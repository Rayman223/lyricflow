import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountError, accountGet, accountRequest } from '../accounts/client'
import { synchronizeSharing } from './sharing'

vi.mock('../accounts/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../accounts/client')>()),
    accountGet: vi.fn(),
    accountRequest: vi.fn(),
}))
beforeEach(() => {
    vi.stubGlobal('navigator', {})
    vi.mocked(accountGet).mockReset()
    vi.mocked(accountRequest).mockReset()
})
afterEach(() => vi.unstubAllGlobals())
import { Library, openLibrary, LibraryRemovedError } from '../storage/library'
import { newSong } from '../domain/song'
import { sharedContent, type OwnedPublication } from './model'

async function setup() {
    const name = crypto.randomUUID(),
        library = new Library(await openLibrary(name))
    const song = { ...newSong(), title: 'Shared song', lyrics: 'Original lyrics' }
    const publication: OwnedPublication = {
        id: crypto.randomUUID(),
        catalogId: crypto.randomUUID(),
        author: 'Owner',
        authorId: 'owner',
        revision: 1,
        updatedAt: song.updatedAt,
        average: null,
        ratingCount: 0,
        published: true,
        hidden: false,
        source: null,
        content: sharedContent(song),
        localSongId: song.id,
        autoShareUpdates: true,
        sharingVersion: 1,
    }
    await library.setMember(true)
    await library.save(song)
    await library.rememberPublications([publication])
    return { name, library, song, publication }
}
async function settlePrivate(library: Library) {
    let revision = await library.syncCursor()
    for (;;) {
        const operation = await library.nextSyncOperation()
        if (!operation) return
        await library.acceptSync(
            {
                accountId: 'owner',
                result: { status: 'applied', revision: ++revision },
                records: [],
                cursor: revision,
                more: false,
            },
            operation,
        )
    }
}

describe('durable automatic sharing', () => {
    it('migrates v5 without changing songs, drafts, private operations or preferences and queues nothing', async () => {
        const name = crypto.randomUUID(),
            song = newSong()
        const old = await openDB(name, 5, {
            upgrade(db) {
                for (const store of ['songs', 'drafts', 'profiles'])
                    db.createObjectStore(store, { keyPath: 'id' })
                db.createObjectStore('preferences')
                db.createObjectStore('sync', { keyPath: 'key' })
            },
        })
        await old.put('songs', song)
        await old.put('drafts', { ...song, lyrics: 'Private draft' })
        await old.put('preferences', 'generation-5', 'generation')
        await old.put('preferences', 'dark', 'theme')
        const pending = { key: `song.${song.id}`, revision: 0, operation: { id: 'existing' } }
        await old.put('sync', pending)
        old.close()
        const library = new Library(await openLibrary(name))
        expect(await library.list()).toEqual([song])
        expect((await library.drafts())[0]?.lyrics).toBe('Private draft')
        expect(await library.syncEntries()).toEqual([pending])
        expect(await library.getPreference('theme')).toBe('dark')
        expect(await library.getPreference('generation')).toBe('generation-5')
        expect(await library.sharingEntries()).toEqual([])
        library.close()
    })
    it('migrates v6 and preserves songs, drafts and queued operations before claiming a durable setting', async () => {
        const fixture = await setup()
        fixture.library.close()
        const { song, publication } = fixture,
            name = crypto.randomUUID()
        const old = await openDB(name, 6, {
            upgrade(db) {
                for (const store of ['songs', 'drafts', 'profiles'])
                    db.createObjectStore(store, { keyPath: 'id' })
                db.createObjectStore('preferences')
                db.createObjectStore('sync', { keyPath: 'key' })
                db.createObjectStore('community', { keyPath: 'localSongId' })
            },
        })
        const entry = {
            localSongId: song.id,
            publication,
            setting: { id: crypto.randomUUID(), enabled: false, expectedSharingVersion: 1 },
        }
        await old.put('songs', song)
        await old.put('drafts', { ...song, lyrics: 'Private unfinished draft' })
        await old.put('preferences', 'member', 'membership')
        await old.put('preferences', 'generation-6', 'generation')
        await old.put('community', entry)
        old.close()
        const library = new Library(await openLibrary(name))
        expect(await library.getPreference('automaticSharingFormat')).toBe('2')
        expect(await library.getPreference('generation')).toBe('generation-6')
        expect(await library.list()).toEqual([song])
        expect((await library.drafts())[0]?.lyrics).toBe('Private unfinished draft')
        expect(await library.sharingEntries()).toEqual([entry])
        expect((await library.nextSharingOperation())?.operation).toEqual(entry.setting)
        library.close()
        const reopened = new Library(await openLibrary(name))
        expect((await reopened.nextSharingOperation())?.operation).toEqual(entry.setting)
        reopened.close()
    })
    it('queues only explicit saves, keeps drafts private, and waits for private sync', async () => {
        const { library, song } = await setup()
        await library.saveDraft({ ...song, lyrics: 'Unfinished private draft' })
        await library.updateReaderSettings(song.id, { bpm: 130 })
        expect((await library.sharingEntries())[0]?.update).toBeUndefined()
        await library.save({ ...song, lyrics: 'Saved changes' }, true)
        expect(await library.nextSharingOperation()).toBeUndefined()
        await settlePrivate(library)
        const next = await library.nextSharingOperation()
        expect(next?.kind).toBe('update')
        expect(next?.operation).toMatchObject({
            content: { lyrics: 'Saved changes' },
            expectedRevision: 1,
            expectedSharingVersion: 1,
        })
        expect(next?.operation).not.toHaveProperty('content.settings')
        await library.saveDraft({ ...song, lyrics: 'Later draft' })
        expect((await library.sharingEntries())[0]?.update?.content.lyrics).toBe('Saved changes')
        library.close()
    })
    it('retains the exact in-flight snapshot across reloads and rebases a newer queued save after acknowledgement', async () => {
        const { name, library, song, publication } = await setup()
        await library.save({ ...song, lyrics: 'First save' }, true)
        await settlePrivate(library)
        const first = (await library.nextSharingOperation())!
        library.close()
        const reopened = new Library(await openLibrary(name))
        expect((await reopened.nextSharingOperation())?.operation).toEqual(first.operation)
        await reopened.save({ ...song, lyrics: 'Second save' }, true)
        await reopened.acceptSharing(song.id, first.operation, {
            ...publication,
            revision: 2,
            content: sharedContent({ ...song, lyrics: 'First save' }),
        })
        await settlePrivate(reopened)
        const second = (await reopened.nextSharingOperation())!
        expect(second.operation).toMatchObject({
            content: { lyrics: 'Second save' },
            expectedRevision: 2,
        })
        expect(second.operation.id).not.toBe(first.operation.id)
        await reopened.acceptSharing(song.id, second.operation, { ...publication, revision: 3 })
        expect(await reopened.nextSharingOperation()).toBeUndefined()
        reopened.close()
    })
    it('cancels pending updates on disable and does not publish just by enabling', async () => {
        const { library, song, publication } = await setup()
        await library.save({ ...song, lyrics: 'Offline saved change' }, true)
        await library.setAutoSharing(song.id, false)
        const disabled = (await library.nextSharingOperation())!
        expect(disabled.kind).toBe('setting')
        expect((await library.sharingEntries())[0]?.update).toBeUndefined()
        await library.acceptSharing(song.id, disabled.operation, {
            ...publication,
            autoShareUpdates: false,
            sharingVersion: 2,
        })
        await library.save({ ...song, lyrics: 'Private saved change' }, true)
        expect((await library.sharingEntries())[0]?.update).toBeUndefined()
        await library.setAutoSharing(song.id, true)
        const enabled = (await library.nextSharingOperation())!
        await library.acceptSharing(song.id, enabled.operation, {
            ...publication,
            sharingVersion: 3,
        })
        await settlePrivate(library)
        expect(await library.nextSharingOperation()).toBeUndefined()
        library.close()
    })
    it('sends a queued enable before the explicit save made while enabling', async () => {
        const { library, song, publication } = await setup()
        await library.rememberPublications([
            { ...publication, autoShareUpdates: false, sharingVersion: 2 },
        ])
        await library.setAutoSharing(song.id, true)
        await library.save({ ...song, lyrics: 'Saved after checking the box' }, true)
        await settlePrivate(library)
        vi.mocked(accountGet).mockResolvedValue({
            accountId: 'owner',
            publications: [{ ...publication, autoShareUpdates: false, sharingVersion: 2 }],
            more: false,
        })
        vi.mocked(accountRequest)
            .mockResolvedValueOnce({ publication: { ...publication, sharingVersion: 3 } })
            .mockResolvedValueOnce({
                publication: {
                    ...publication,
                    sharingVersion: 3,
                    revision: 2,
                    content: sharedContent({ ...song, lyrics: 'Saved after checking the box' }),
                },
            })
        await synchronizeSharing(library, 'owner', () => true)
        expect(vi.mocked(accountRequest).mock.calls[0]?.[0]).toContain('/auto-share')
        expect(vi.mocked(accountRequest).mock.calls[1]?.[1]).toMatchObject({
            expectedSharingVersion: 3,
            content: { lyrics: 'Saved after checking the box' },
        })
        expect((await library.sharingEntries())[0]?.blocked).toBeUndefined()
        library.close()
    })
    it('keeps revoked offline updates blocked even when publication is later restored', async () => {
        const { library, song, publication } = await setup()
        await library.save({ ...song, lyrics: 'Stale offline save' }, true)
        await settlePrivate(library)
        await library.rememberPublications([
            { ...publication, published: false, sharingVersion: 2 },
        ])
        expect((await library.sharingEntries())[0]?.blocked).toBeDefined()
        await library.rememberPublications([{ ...publication, sharingVersion: 3 }])
        expect(await library.nextSharingOperation()).toBeUndefined()
        expect((await library.list())[0]?.lyrics).toBe('Stale offline save')
        library.close()
    })
    it('keeps the original public revision when another device changes publication or settings', async () => {
        const { library, song, publication } = await setup()
        await library.save({ ...song, lyrics: 'Offline changes' }, true)
        await library.rememberPublications(
            [{ ...publication, revision: 2, sharingVersion: 2 }],
            true,
        )
        await settlePrivate(library)
        const next = (await library.nextSharingOperation())!
        expect(next.operation).toMatchObject({ expectedRevision: 1, expectedSharingVersion: 1 })
        await library.blockSharing(song.id, next.operation.id, 'Concurrent public changes')
        expect(await library.nextSharingOperation()).toBeUndefined()
        expect((await library.list())[0]?.lyrics).toBe('Offline changes')
        library.close()
    })
    it('blocks private conflicts and cancels the old public intent after resolution', async () => {
        const { library, song } = await setup()
        await library.save({ ...song, lyrics: 'Conflicting save' }, true)
        const operation = (await library.nextSyncOperation())!
        const record = { key: operation.key, revision: 10, value: { song, draft: null } }
        await library.acceptSync(
            {
                accountId: 'owner',
                result: { status: 'conflict', record },
                records: [],
                cursor: 10,
                more: false,
            },
            operation,
        )
        expect(await library.nextSharingOperation()).toBeUndefined()
        await library.resolveConflict(operation.key, 'local', 10, operation.id)
        await settlePrivate(library)
        expect(await library.nextSharingOperation()).toBeUndefined()
        library.close()
    })
    it('removes pending sharing on deletion, erasure and detach and rejects late writes to erased profiles', async () => {
        const { name, library, song, publication } = await setup()
        await library.save({ ...song, lyrics: 'Saved change' }, true)
        const old = new Library(await openLibrary(name))
        await library.eraseLocal()
        expect(await library.sharingEntries()).toEqual([])
        await expect(old.rememberPublications([publication])).rejects.toBeInstanceOf(
            LibraryRemovedError,
        )
        old.close()
        library.close()
        for (const action of ['delete', 'detach'] as const) {
            const { library, song, publication } = await setup()
            await library.save({ ...song, lyrics: 'Saved change' }, true)
            if (action === 'delete') await library.remove(song.id)
            else await library.detach(false)
            expect(await library.sharingEntries()).toEqual([])
            if (action === 'detach') {
                await library.rememberPublications([publication], true)
                expect(await library.sharingEntries()).toEqual([])
            }
            library.close()
        }
    })
})

describe('sharing exchanges', () => {
    it('keeps a publication confirmed locally after an older owner listing started', async () => {
        const { library, publication } = await setup()
        // This listing began before the song was published; its response arrives later.
        await library.rememberPublications([], true)
        vi.mocked(accountGet).mockImplementation(async () => {
            await library.rememberPublications([publication], false, true)
            return { accountId: 'owner', publications: [], more: false }
        })
        await synchronizeSharing(library, 'owner', () => true)
        expect((await library.sharingEntries())[0]?.publication.id).toBe(publication.id)
        library.close()
    })
    it('keeps a newer publication confirmation when an older listing omits that song', async () => {
        const { library, publication } = await setup()
        vi.mocked(accountGet).mockImplementation(async () => {
            await library.rememberPublications(
                [{ ...publication, revision: 2, sharingVersion: 2 }],
                false,
                true,
            )
            return { accountId: 'owner', publications: [], more: false }
        })
        await synchronizeSharing(library, 'owner', () => true)
        expect((await library.sharingEntries())[0]?.publication.revision).toBe(2)
        library.close()
    })
    it('serializes a newer checkbox choice after the previous request was already accepted', async () => {
        const { library, song, publication } = await setup()
        await library.setAutoSharing(song.id, false)
        const first = (await library.nextSharingOperation())!
        // Another tab changes its mind while the first response is delayed.
        await library.setAutoSharing(song.id, true)
        await library.acceptSharing(song.id, first.operation, {
            ...publication,
            autoShareUpdates: false,
            sharingVersion: 2,
        })
        const second = (await library.nextSharingOperation())!
        expect(second.operation).toMatchObject({ enabled: true, expectedSharingVersion: 2 })
        expect(second.operation.id).not.toBe(first.operation.id)
        library.close()
    })

    it('loads every owner page and never applies another account response', async () => {
        const { library, publication } = await setup()
        const otherPublication = {
            ...publication,
            id: crypto.randomUUID(),
            localSongId: crypto.randomUUID(),
        }
        vi.mocked(accountGet)
            .mockResolvedValueOnce({ accountId: 'owner', publications: [publication], more: true })
            .mockResolvedValueOnce({
                accountId: 'owner',
                publications: [otherPublication],
                more: false,
            })
        await synchronizeSharing(library, 'owner', () => true)
        expect(accountGet).toHaveBeenCalledWith('/api/community/mine?sort=id&page=2')
        expect(await library.sharingEntries()).toHaveLength(2)
        vi.mocked(accountGet).mockResolvedValue({
            accountId: 'another-account',
            publications: [],
            more: false,
        })
        await expect(synchronizeSharing(library, 'owner', () => true)).rejects.toBeInstanceOf(
            AccountError,
        )
        expect(await library.sharingEntries()).toHaveLength(2)
        library.close()
    })
    it('retries a lost response with the same snapshot and stops on a public conflict', async () => {
        const { library, song, publication } = await setup()
        await library.save({ ...song, lyrics: 'Offline saved change' }, true)
        await settlePrivate(library)
        vi.mocked(accountGet).mockResolvedValue({
            accountId: 'owner',
            publications: [publication],
            more: false,
        })
        vi.mocked(accountRequest).mockRejectedValueOnce(new Error('Connection lost'))
        await expect(synchronizeSharing(library, 'owner', () => true)).rejects.toThrow(
            'Connection lost',
        )
        const firstBody = vi.mocked(accountRequest).mock.calls[0]![1]
        vi.mocked(accountRequest).mockRejectedValueOnce(new AccountError('Concurrent change', 409))
        await synchronizeSharing(library, 'owner', () => true)
        expect(vi.mocked(accountRequest).mock.calls[1]![1]).toEqual(firstBody)
        expect((await library.sharingEntries())[0]?.blocked).toBe('Concurrent change')
        await synchronizeSharing(library, 'owner', () => true)
        expect(accountRequest).toHaveBeenCalledTimes(2)
        library.close()
    })
    it('allows a fresh explicit choice after a real settings conflict', async () => {
        const { library, song, publication } = await setup()
        await library.setAutoSharing(song.id, false)
        const old = (await library.nextSharingOperation())!
        await library.rememberPublications([{ ...publication, sharingVersion: 3 }])
        await library.blockSharing(song.id, old.operation.id, 'Policy changed elsewhere')
        await library.setAutoSharing(song.id, false)
        const fresh = (await library.nextSharingOperation())!
        expect(fresh.operation).toMatchObject({ enabled: false, expectedSharingVersion: 3 })
        expect(fresh.operation.id).not.toBe(old.operation.id)
        library.close()
    })
    it('replays an accepted setting after a lost response before sending a newer choice', async () => {
        const { library, name, song, publication } = await setup()
        await library.setAutoSharing(song.id, false)
        const first = (await library.nextSharingOperation())!
        await library.setAutoSharing(song.id, true)
        library.close()
        const reopened = new Library(await openLibrary(name))
        const disabled = { ...publication, autoShareUpdates: false, sharingVersion: 2 }
        vi.mocked(accountGet).mockResolvedValue({
            accountId: 'owner',
            publications: [disabled],
            more: false,
        })
        vi.mocked(accountRequest)
            .mockResolvedValueOnce({ publication: disabled })
            .mockResolvedValueOnce({ publication: { ...publication, sharingVersion: 3 } })
        await synchronizeSharing(reopened, 'owner', () => true)
        expect(vi.mocked(accountRequest).mock.calls[0]?.[1]).toMatchObject({
            operationId: first.operation.id,
            enabled: false,
            expectedSharingVersion: 1,
        })
        expect(vi.mocked(accountRequest).mock.calls[1]?.[1]).toMatchObject({
            enabled: true,
            expectedSharingVersion: 2,
        })
        const entry = (await reopened.sharingEntries())[0]!
        expect(entry.publication.autoShareUpdates).toBe(true)
        expect(entry.setting).toBeUndefined()
        expect(entry.settingInFlight).toBeUndefined()
        expect(entry.blocked).toBeUndefined()
        reopened.close()
    })
    it('ignores a late publication result after profile change and keeps it retryable', async () => {
        const { library, song, publication } = await setup()
        await library.save({ ...song, lyrics: 'Saved version' }, true)
        await settlePrivate(library)
        let current = true
        vi.mocked(accountGet).mockResolvedValue({
            accountId: 'owner',
            publications: [publication],
            more: false,
        })
        vi.mocked(accountRequest).mockImplementation(async () => {
            current = false
            return { publication: { ...publication, revision: 2 } }
        })
        await synchronizeSharing(library, 'owner', () => current)
        const entry = (await library.sharingEntries())[0]!
        expect(entry.publication.revision).toBe(1)
        expect(entry.inFlight).toBeDefined()
        library.close()
    })
})
