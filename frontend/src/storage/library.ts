import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { t } from '../i18n/en'
import type { ReaderSettings, Song } from '../domain/song'
import type { RemoteRecord, SyncEntry, SyncOperation, SyncResponse, SyncValue } from './sync-types'
import {
    sharedContent,
    sharedSignature,
    applyPublication,
    type Publication,
    type OwnedPublication,
    type SharingEntry,
    type SharingUpdate,
    type SharingSetting,
    sharingEnabled,
} from '../community/model'

interface LibrarySchema extends DBSchema {
    songs: { key: string; value: Song }
    drafts: { key: string; value: Song }
    preferences: { key: string; value: string }
    profiles: { key: string; value: LocalProfile }
    sync: { key: string; value: SyncEntry }
    community: { key: string; value: SharingEntry }
}

const syncStores = ['songs', 'drafts', 'preferences', 'sync', 'community'] as const
type WriteTransaction = IDBPTransaction<LibrarySchema, typeof syncStores, 'readwrite'>

async function queueSync(tx: WriteTransaction, key: string) {
    const store = tx.objectStore('sync')
    const entry = (await store.get(key)) ?? { key, revision: 0 }
    const value =
        key === 'theme'
            ? { theme: (await tx.objectStore('preferences').get('theme')) as 'light' | 'dark' }
            : await songValue(tx, key.slice(5))
    // Only newly created operations advertise score support. Never rewrite an
    // immutable in-flight request or a snapshot preserved by the v9 migration.
    if (value && 'song' in value)
        for (const kind of ['song', 'draft'] as const) {
            const song = value[kind]
            if (song) song.arrangements ??= []
        }
    entry.operation = { id: crypto.randomUUID(), key, baseRevision: entry.revision, value }
    await store.put(entry)
}

async function songValue(tx: WriteTransaction, id: string): Promise<SyncValue> {
    const song = (await tx.objectStore('songs').get(id)) ?? null
    const draft = (await tx.objectStore('drafts').get(id)) ?? null
    return song || draft ? { song, draft } : null
}

async function writeRemote(tx: WriteTransaction, record: RemoteRecord) {
    if (record.key === 'theme') {
        if (record.value && 'theme' in record.value)
            await tx.objectStore('preferences').put(record.value.theme, 'theme')
        return
    }
    const id = record.key.slice(5)
    for (const kind of ['songs', 'drafts'] as const) {
        const value =
            record.value && 'song' in record.value
                ? record.value[kind === 'songs' ? 'song' : 'draft']
                : null
        if (value) await tx.objectStore(kind).put(value)
        else await tx.objectStore(kind).delete(id)
    }
}

export interface LocalProfile {
    id: string
    label: string
}

export class QuotaError extends Error {}
export class LibraryRemovedError extends Error {}

export function openLibrary(name = 'lyricflow') {
    return openDB<LibrarySchema>(name, 9, {
        upgrade(db, oldVersion, _next, transaction) {
            // Append future migrations here. Never recreate a populated object store.
            if (oldVersion < 1) {
                db.createObjectStore('songs', { keyPath: 'id' })
                db.createObjectStore('drafts', { keyPath: 'id' })
                db.createObjectStore('preferences')
            }
            if (oldVersion < 2) {
                // v1 songs/drafts/preferences remain in the original guest database.
                db.createObjectStore('profiles', { keyPath: 'id' })
            }
            if (oldVersion < 3) {
                // Existing records are queued lazily by prepareSync, in one transaction.
                db.createObjectStore('sync', { keyPath: 'key' })
            }
            if (oldVersion < 4) {
                // v4 adds optional source provenance to song records; older songs stay intact.
                transaction.objectStore('preferences').put('1', 'communityFormat')
            }
            if (oldVersion < 5) {
                // Invalidate old handles after an explicit local library removal.
                transaction.objectStore('preferences').put(crypto.randomUUID(), 'generation')
            }
            if (oldVersion < 6) {
                db.createObjectStore('community', { keyPath: 'localSongId' })
            }
            if (oldVersion < 7) {
                // v6 entries remain intact; an absent settingInFlight means no claimed setting.
                transaction.objectStore('preferences').put('2', 'automaticSharingFormat')
            }
            if (oldVersion < 8) {
                // Optional musicLinks on songs, drafts and shared content; absence means no links.
                // Keep queued request snapshots intact for idempotent retries.
                transaction.objectStore('preferences').put('1', 'musicLinksFormat')
            }
            if (oldVersion < 9) {
                // Optional arrangements v1; retain songs, drafts, revisions and retry hashes.
                transaction.objectStore('preferences').put('1', 'scoreFormat')
            }
        },
        blocking(_old, _next, event) {
            ;(event.target as IDBDatabase).close()
        },
    })
}

export class Library {
    private generation: Promise<string | undefined>
    constructor(private db: IDBPDatabase<LibrarySchema>) {
        this.generation = db.get('preferences', 'generation')
    }

    private async checkGeneration(tx: WriteTransaction) {
        if ((await tx.objectStore('preferences').get('generation')) !== (await this.generation))
            throw new LibraryRemovedError('libraryRemoved')
    }
    async isCurrent() {
        return (await this.db.get('preferences', 'generation')) === (await this.generation)
    }

    async list() {
        return (await this.db.getAll('songs')).sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
        )
    }
    async drafts() {
        return this.db.getAll('drafts')
    }
    async saveDraft(song: Song) {
        await this.write(async (tx) => {
            await tx.objectStore('drafts').put(structuredClone(song))
            await queueSync(tx, `song.${song.id}`)
        })
    }
    async save(song: Song, shareSavedChanges = false) {
        // The count and write share one transaction, including across browser tabs.
        const tx = this.db.transaction(syncStores, 'readwrite')
        try {
            await this.checkGeneration(tx)
            const existing = await tx.objectStore('songs').get(song.id)
            const member = (await tx.objectStore('preferences').get('membership')) === 'member'
            if (!existing && !member && (await tx.objectStore('songs').count()) >= 3) {
                tx.abort()
                throw new QuotaError('guestLimit')
            }
            await tx.objectStore('songs').put(structuredClone(song))
            await tx.objectStore('drafts').delete(song.id)
            await queueSync(tx, `song.${song.id}`)
            const entry = await tx.objectStore('community').get(song.id)
            if (
                shareSavedChanges &&
                entry &&
                entry.publication.published &&
                !entry.publication.hidden &&
                sharingEnabled(entry) &&
                !entry.blocked
            ) {
                const content = sharedContent(song)
                if (
                    entry.inFlight ||
                    sharedSignature(content) !== sharedSignature(entry.publication.content)
                ) {
                    const base = entry.update ?? entry.inFlight
                    entry.update = {
                        id: crypto.randomUUID(),
                        content,
                        expectedRevision: base?.expectedRevision ?? entry.publication.revision,
                        expectedSharingVersion:
                            base?.expectedSharingVersion ?? entry.publication.sharingVersion,
                    }
                } else delete entry.update
                await tx.objectStore('community').put(entry)
            }
            await tx.done
        } catch (error) {
            try {
                tx.abort()
            } catch {
                /* Already complete or aborted. */
            }
            await tx.done.catch(() => {})
            throw error
        }
    }
    async updateReaderSettings(id: string, settings: ReaderSettings) {
        const tx = this.db.transaction(syncStores, 'readwrite')
        try {
            await this.checkGeneration(tx)
            const song = await tx.objectStore('songs').get(id)
            if (!song) {
                await tx.done
                return false
            }
            const updatedAt = new Date().toISOString()
            // Read the latest records: a reader may be older than another tab's edits.
            const draft = await tx.objectStore('drafts').get(id)
            for (const [store, record] of [
                ['songs', song],
                ['drafts', draft],
            ] as const) {
                if (record)
                    await tx.objectStore(store).put({
                        ...record,
                        settings: { ...record.settings, ...settings },
                        updatedAt,
                    })
            }
            await queueSync(tx, `song.${id}`)
            await tx.done
            return true
        } catch (error) {
            try {
                tx.abort()
            } catch {
                /* Already complete or aborted. */
            }
            await tx.done.catch(() => {})
            throw error
        }
    }
    async remove(id: string) {
        const tx = this.db.transaction(syncStores, 'readwrite')
        try {
            await this.checkGeneration(tx)
            await tx.objectStore('songs').delete(id)
            await tx.objectStore('drafts').delete(id)
            await tx.objectStore('community').delete(id)
            await queueSync(tx, `song.${id}`)
            await tx.done
        } catch (error) {
            try {
                tx.abort()
            } catch {
                /* Already complete or aborted. */
            }
            await tx.done.catch(() => {})
            throw error
        }
    }
    async discardDraft(id: string) {
        await this.write(async (tx) => {
            await tx.objectStore('drafts').delete(id)
            await queueSync(tx, `song.${id}`)
        })
    }
    async updateFromPublication(id: string, publication: Publication) {
        return this.write(async (tx) => {
            const song = await tx.objectStore('songs').get(id)
            if (!song?.source || song.source.publicationId !== publication.id) return 'unavailable'
            if (publication.revision <= song.source.revision) return 'current'
            const draft = await tx.objectStore('drafts').get(id)
            const base = sharedSignature(song.source.base)
            if (
                sharedSignature(sharedContent(song)) !== base ||
                (draft && sharedSignature(sharedContent(draft)) !== base)
            )
                return 'customized'
            await tx.objectStore('songs').put(applyPublication(song, publication))
            if (draft) await tx.objectStore('drafts').put(applyPublication(draft, publication))
            await queueSync(tx, `song.${id}`)
            return 'updated'
        })
    }
    async sharingEntries() {
        return this.db.getAll('community')
    }
    async rememberPublications(
        publications: OwnedPublication[],
        complete = false,
        explicit = false,
        listedBefore?: OwnedPublication[],
    ) {
        await this.write(async (tx) => {
            if ((await tx.objectStore('preferences').get('membership')) !== 'member') return
            const store = tx.objectStore('community')
            for (const publication of publications) {
                if (!publication.localSongId) continue
                const entry = (await store.get(publication.localSongId)) ?? {
                    localSongId: publication.localSongId,
                    publication,
                }
                if (
                    publication.sharingVersion < entry.publication.sharingVersion ||
                    publication.revision < entry.publication.revision
                )
                    continue
                entry.publication = structuredClone(publication)
                if (
                    (entry.update || entry.inFlight) &&
                    (!publication.published ||
                        publication.hidden ||
                        (!publication.autoShareUpdates && !entry.setting?.enabled))
                )
                    entry.blocked = t('sharingInactive')
                if (explicit) {
                    delete entry.setting
                    delete entry.settingInFlight
                    delete entry.update
                    delete entry.inFlight
                    delete entry.blocked
                }
                await store.put(entry)
            }
            if (complete) {
                await tx.objectStore('preferences').put('1', 'communityLoaded')
                const ids = new Set(publications.map((p) => p.localSongId))
                const previous =
                    listedBefore && new Map(listedBefore.map((p) => [p.localSongId, p]))
                for (const entry of await store.getAll()) {
                    if (!ids.has(entry.localSongId)) {
                        // A response cannot remove a publication confirmed while it was loading.
                        const before = previous?.get(entry.localSongId)
                        if (
                            previous &&
                            (!before ||
                                before.id !== entry.publication.id ||
                                before.revision !== entry.publication.revision ||
                                before.sharingVersion !== entry.publication.sharingVersion)
                        )
                            continue
                        if (
                            entry.setting ||
                            entry.settingInFlight ||
                            entry.update ||
                            entry.inFlight
                        ) {
                            entry.publication.published = false
                            entry.blocked = t('sharingMissing')
                            await store.put(entry)
                        } else await store.delete(entry.localSongId)
                    }
                }
            }
        })
    }
    async setAutoSharing(id: string, enabled: boolean) {
        await this.write(async (tx) => {
            const store = tx.objectStore('community'),
                entry = await store.get(id)
            if (!entry) return
            if (entry.blocked) {
                // An explicit choice after a reported conflict starts from the refreshed policy.
                delete entry.setting
                delete entry.settingInFlight
            }
            entry.setting = {
                id: crypto.randomUUID(),
                enabled,
                expectedSharingVersion:
                    entry.setting?.expectedSharingVersion ??
                    entry.settingInFlight?.expectedSharingVersion ??
                    entry.publication.sharingVersion,
            }
            delete entry.update
            delete entry.inFlight
            delete entry.blocked
            await store.put(entry)
        })
    }
    async nextSharingOperation(settingsOnly = false) {
        return this.write(async (tx) => {
            if ((await tx.objectStore('preferences').get('membership')) !== 'member') return
            const store = tx.objectStore('community')
            for (const entry of await store.getAll()) {
                if (entry.blocked) continue
                if (!entry.settingInFlight && entry.setting) {
                    entry.settingInFlight = structuredClone(entry.setting)
                    await store.put(entry)
                }
                if (entry.settingInFlight)
                    return { entry, kind: 'setting' as const, operation: entry.settingInFlight }
                if (settingsOnly) continue
                if (!(await tx.objectStore('songs').get(entry.localSongId))) {
                    delete entry.update
                    delete entry.inFlight
                    await store.put(entry)
                    continue
                }
                const privateEntry = await tx.objectStore('sync').get(`song.${entry.localSongId}`)
                if (privateEntry?.conflict || privateEntry?.operation || privateEntry?.inFlight)
                    continue
                if (
                    !entry.publication.published ||
                    entry.publication.hidden ||
                    !sharingEnabled(entry)
                )
                    continue
                if (!entry.inFlight && entry.update) {
                    entry.inFlight = structuredClone(entry.update)
                    await store.put(entry)
                }
                if (entry.inFlight)
                    return { entry, kind: 'update' as const, operation: entry.inFlight }
            }
        })
    }
    async acceptSharing(
        id: string,
        operation: SharingUpdate | SharingSetting,
        publication: OwnedPublication,
    ) {
        await this.write(async (tx) => {
            if ((await tx.objectStore('preferences').get('membership')) !== 'member') return
            const store = tx.objectStore('community'),
                entry = await store.get(id)
            if (!entry) return
            if (
                publication.sharingVersion >= entry.publication.sharingVersion &&
                publication.revision >= entry.publication.revision
            )
                entry.publication = structuredClone(publication)
            if ('enabled' in operation && entry.settingInFlight?.id === operation.id) {
                delete entry.settingInFlight
                if (entry.setting?.id === operation.id) delete entry.setting
                else if (entry.setting?.expectedSharingVersion === operation.expectedSharingVersion)
                    entry.setting.expectedSharingVersion = publication.sharingVersion
                if (entry.update?.expectedSharingVersion === operation.expectedSharingVersion)
                    entry.update.expectedSharingVersion = publication.sharingVersion
            } else if ('content' in operation && entry.inFlight?.id === operation.id) {
                delete entry.inFlight
                if (entry.update?.id === operation.id) delete entry.update
                else if (
                    entry.update &&
                    entry.update.expectedRevision === operation.expectedRevision
                )
                    entry.update.expectedRevision = publication.revision
            }
            await store.put(entry)
        })
    }
    async blockSharing(id: string, operationId: string, message: string) {
        await this.write(async (tx) => {
            const store = tx.objectStore('community'),
                entry = await store.get(id)
            if (entry && [entry.settingInFlight?.id, entry.inFlight?.id].includes(operationId)) {
                entry.blocked = message
                await store.put(entry)
            }
        })
    }
    async getPreference(key: string) {
        return this.db.get('preferences', key)
    }
    async setPreference(key: string, value: string) {
        await this.write(async (tx) => {
            await tx.objectStore('preferences').put(value, key)
            if (key === 'theme') await queueSync(tx, 'theme')
        })
    }
    async isMember() {
        return (await this.getPreference('membership')) === 'member'
    }
    async setMember(member: boolean) {
        await this.setPreference('membership', member ? 'member' : 'guest')
    }
    async profiles() {
        return [
            { id: 'guest', label: 'Guest' },
            ...(await this.db.getAll('profiles')).filter((p) => p.id !== 'guest'),
        ]
    }
    async rememberProfile(profile: LocalProfile) {
        await this.db.put('profiles', profile)
    }
    async forgetProfile(id: string) {
        await this.db.delete('profiles', id)
    }
    async eraseLocal() {
        await this.write(async (tx) => {
            for (const store of syncStores) await tx.objectStore(store).clear()
            await tx.objectStore('preferences').put(crypto.randomUUID(), 'generation')
        })
    }
    async copyFrom(source: Library) {
        const [songs, drafts] = await Promise.all([source.list(), source.drafts()])
        const tx = this.db.transaction(syncStores, 'readwrite')
        try {
            await this.checkGeneration(tx)
            if ((await tx.objectStore('preferences').get('membership')) !== 'member') {
                throw new QuotaError('accountRequired')
            }
            // Retrying a copy never overwrites an edited song or a newer draft.
            const existing = new Set(await tx.objectStore('songs').getAllKeys())
            const existingDrafts = new Set(await tx.objectStore('drafts').getAllKeys())
            for (const song of songs) {
                if (!existing.has(song.id) && !existingDrafts.has(song.id))
                    await tx.objectStore('songs').put(song)
            }
            for (const draft of drafts) {
                if (!existing.has(draft.id) && !existingDrafts.has(draft.id))
                    await tx.objectStore('drafts').put(draft)
            }
            for (const id of new Set([...songs, ...drafts].map((s) => s.id))) {
                if (!existing.has(id) && !existingDrafts.has(id)) await queueSync(tx, `song.${id}`)
            }
            await tx.done
        } catch (error) {
            try {
                tx.abort()
            } catch {
                /* The transaction may already be aborted. */
            }
            await tx.done.catch(() => {})
            throw error
        }
    }
    private async write<T>(action: (tx: WriteTransaction) => Promise<T>) {
        const tx = this.db.transaction(syncStores, 'readwrite')
        try {
            await this.checkGeneration(tx)
            const result = await action(tx)
            await tx.done
            return result
        } catch (error) {
            try {
                tx.abort()
            } catch {
                /* Already complete or aborted. */
            }
            await tx.done.catch(() => {})
            throw error
        }
    }
    async prepareSync() {
        await this.write(async (tx) => {
            const keys = new Set([
                ...(await tx.objectStore('songs').getAllKeys()),
                ...(await tx.objectStore('drafts').getAllKeys()),
            ])
            for (const id of keys) {
                if (!(await tx.objectStore('sync').get(`song.${id}`)))
                    await queueSync(tx, `song.${id}`)
            }
            const theme = await tx.objectStore('preferences').get('theme')
            if (theme && !(await tx.objectStore('sync').get('theme'))) await queueSync(tx, 'theme')
        })
    }
    async syncEntries() {
        return this.db.getAll('sync')
    }
    async nextSyncOperation() {
        return this.write(async (tx) => {
            const store = tx.objectStore('sync')
            const entry = (await store.getAll()).find(
                (entry) => !entry.conflict && (entry.inFlight || entry.operation),
            )
            if (!entry) return undefined
            if (!entry.inFlight) {
                entry.inFlight = structuredClone(entry.operation!)
                await store.put(entry)
            }
            return entry.inFlight
        })
    }
    async syncCursor() {
        return Number((await this.getPreference('syncCursor')) ?? 0)
    }
    async acceptSync(response: SyncResponse, sent?: SyncOperation) {
        await this.write(async (tx) => {
            // A late request cannot reauthorize a signed-out or deleted profile.
            if ((await tx.objectStore('preferences').get('membership')) !== 'member') return
            const store = tx.objectStore('sync')
            const result = response.result
            if (sent && result) {
                const entry = await store.get(sent.key)
                if (entry?.inFlight?.id === sent.id) delete entry.inFlight
                if (entry && result.status === 'applied' && result.revision >= entry.revision) {
                    entry.revision = result.revision
                    if (entry.operation?.id === sent.id) delete entry.operation
                    else if (entry.operation) {
                        entry.operation.baseRevision = result.revision
                        entry.operation.id = crypto.randomUUID()
                        // A changed request gets a fresh ID; receipt hashes remain immutable.
                    }
                    await store.put(entry)
                } else if (
                    entry &&
                    result.status === 'conflict' &&
                    result.record.revision >= entry.revision
                ) {
                    entry.conflict = result.record
                    await store.put(entry)
                } else if (entry) await store.put(entry)
            }
            for (const remote of response.records) {
                const entry = (await store.get(remote.key)) ?? { key: remote.key, revision: 0 }
                if (remote.revision <= entry.revision) continue
                if (entry.operation || entry.conflict) {
                    if (remote.key === 'theme' && entry.operation) {
                        // Themes use server confirmation order, independent of phone clocks.
                        entry.revision = remote.revision
                        entry.operation.baseRevision = remote.revision
                        entry.operation.id = crypto.randomUUID()
                    } else entry.conflict = remote
                } else {
                    await writeRemote(tx, remote)
                    entry.revision = remote.revision
                }
                await store.put(entry)
            }
            const cursor = Number((await tx.objectStore('preferences').get('syncCursor')) ?? 0)
            await tx
                .objectStore('preferences')
                .put(String(Math.max(cursor, response.cursor)), 'syncCursor')
        })
    }
    async resolveConflict(
        key: string,
        choice: 'local' | 'server' | 'both',
        expectedRevision: number,
        expectedOperationId?: string,
    ) {
        await this.write(async (tx) => {
            const store = tx.objectStore('sync')
            const entry = await store.get(key)
            const remote = entry?.conflict
            if (!entry || !remote || remote.revision !== expectedRevision)
                throw new Error('conflictChanged')
            if (expectedOperationId !== undefined && entry.operation?.id !== expectedOperationId)
                throw new Error('conflictChanged')
            const sharing = await tx.objectStore('community').get(key.slice(5))
            if (sharing) {
                delete sharing.update
                delete sharing.inFlight
                await tx.objectStore('community').put(sharing)
            }
            const local = await songValue(tx, key.slice(5))
            // Keeping both, or recovering a server-deleted song, uses a fresh identity.
            if (
                (choice === 'both' || (choice === 'local' && remote.value === null)) &&
                local &&
                'song' in local
            ) {
                if (
                    (await tx.objectStore('preferences').get('membership')) !== 'member' &&
                    (await tx.objectStore('songs').count()) >= 3
                ) {
                    throw new QuotaError('guestLimit')
                }
                const id = crypto.randomUUID()
                for (const kind of ['song', 'draft'] as const) {
                    const song = local[kind]
                    if (song)
                        await tx
                            .objectStore(kind === 'song' ? 'songs' : 'drafts')
                            .put({ ...song, id })
                }
                await queueSync(tx, `song.${id}`)
            }
            entry.revision = remote.revision
            delete entry.conflict
            delete entry.operation
            delete entry.inFlight
            await store.put(entry)
            if (choice === 'local' && remote.value !== null) await queueSync(tx, key)
            else await writeRemote(tx, remote)
        })
    }
    async detach(erase: boolean) {
        await this.write(async (tx) => {
            if (!erase) {
                // Keep every locally held version when the server account is removed.
                for (const entry of await tx.objectStore('sync').getAll()) {
                    const value = entry.conflict?.value
                    if (!value || !('song' in value)) continue
                    const id = crypto.randomUUID()
                    for (const kind of ['song', 'draft'] as const) {
                        if (value[kind])
                            await tx
                                .objectStore(kind === 'song' ? 'songs' : 'drafts')
                                .put({ ...value[kind], id })
                    }
                }
            }
            await tx.objectStore('sync').clear()
            await tx.objectStore('community').clear()
            await tx.objectStore('preferences').delete('communityLoaded')
            await tx.objectStore('preferences').delete('syncCursor')
            await tx.objectStore('preferences').put('guest', 'membership')
            if (erase) {
                await tx.objectStore('songs').clear()
                await tx.objectStore('drafts').clear()
                await tx.objectStore('preferences').delete('theme')
            }
        })
    }
    async whenIdle() {
        // This barrier is queued behind writes already opened on every local store.
        await this.db.transaction(this.db.objectStoreNames, 'readonly').done
    }
    close() {
        this.db.close()
    }
}

export function profileDatabase(id: string) {
    if (id === 'guest') return 'lyricflow'
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('invalidProfile')
    return `lyricflow.profile.${id}`
}
