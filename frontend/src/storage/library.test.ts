import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { Library, LibraryRemovedError, openLibrary, profileDatabase, QuotaError } from './library'
import { openDB } from 'idb'
import { newSong } from '../domain/song'

describe('local library transactions', () => {
    it('migrates v4 without altering songs, pending operations, profiles or preferences', async () => {
        const name = crypto.randomUUID()
        const song = newSong()
        const old = await openDB(name, 4, {
            upgrade(db) {
                for (const store of ['songs', 'drafts', 'profiles'])
                    db.createObjectStore(store, { keyPath: 'id' })
                db.createObjectStore('sync', { keyPath: 'key' })
                db.createObjectStore('preferences')
            },
        })
        await old.put('songs', song)
        await old.put('drafts', { ...song, lyrics: 'Unfinished lyrics' })
        await old.put('preferences', 'dark', 'theme')
        await old.put('preferences', 'member', 'membership')
        await old.put('profiles', { id: 'saved-account', label: 'Saved account' })
        const operation = { key: `song.${song.id}`, revision: 0, operation: { id: 'pending' } }
        await old.put('sync', operation)
        old.close()
        const migrated = new Library(await openLibrary(name))
        expect(await migrated.list()).toEqual([song])
        expect((await migrated.drafts())[0]?.lyrics).toBe('Unfinished lyrics')
        expect(await migrated.getPreference('theme')).toBe('dark')
        expect(await migrated.isMember()).toBe(true)
        expect(await migrated.syncEntries()).toEqual([operation])
        expect(await migrated.profiles()).toContainEqual({
            id: 'saved-account',
            label: 'Saved account',
        })
        expect(await migrated.getPreference('generation')).toBeTruthy()
        migrated.close()
    })
    it('erases only the selected library and rejects old tabs and late sync responses', async () => {
        const name = crypto.randomUUID()
        const target = new Library(await openLibrary(name))
        const oldTab = new Library(await openLibrary(name))
        const other = new Library(await openLibrary(crypto.randomUUID()))
        const song = { ...newSong(), lyrics: 'Private lyrics' }
        await target.setMember(true)
        await target.save(song)
        await target.saveDraft({ ...song, lyrics: 'Private unfinished draft' })
        await target.setPreference('theme', 'dark')
        await target.setPreference('syncCursor', '42')
        await target.rememberProfile({ id: 'other', label: 'Other library' })
        await other.save(song)
        const sent = await oldTab.nextSyncOperation()
        await target.eraseLocal()
        expect(await oldTab.isCurrent()).toBe(false)
        expect(await target.list()).toEqual([])
        expect(await target.drafts()).toEqual([])
        expect(await target.syncEntries()).toEqual([])
        expect(await target.getPreference('theme')).toBeUndefined()
        expect(await target.syncCursor()).toBe(0)
        expect(await target.isMember()).toBe(false)
        // The guest registry survives a reset of the guest library.
        expect(await target.profiles()).toContainEqual({ id: 'other', label: 'Other library' })
        expect(await other.list()).toEqual([song])
        const reopened = new Library(await openLibrary(name))
        expect(await reopened.isCurrent()).toBe(true)
        await reopened.setMember(true)
        for (const write of [
            () => oldTab.save(song),
            () => oldTab.saveDraft(song),
            () => oldTab.setMember(true),
            () => oldTab.remove(song.id),
            () => oldTab.updateReaderSettings(song.id, { bpm: 180 }),
            () => oldTab.copyFrom(other),
            () =>
                oldTab.acceptSync(
                    {
                        accountId: 'account',
                        result: null,
                        cursor: 43,
                        more: false,
                        records: [
                            { key: `song.${song.id}`, revision: 1, value: { song, draft: null } },
                        ],
                    },
                    sent,
                ),
        ])
            await expect(write()).rejects.toBeInstanceOf(LibraryRemovedError)
        expect(await reopened.list()).toEqual([])
        expect(await reopened.syncEntries()).toEqual([])
        await reopened.save(song)
        expect(await reopened.list()).toEqual([song])
        for (const db of [target, oldTab, other, reopened]) db.close()
    })
    it('migrates the deployed v1 database without losing songs, drafts or preferences', async () => {
        const name = crypto.randomUUID()
        const song = { ...newSong(), lyrics: 'Existing device lyrics' }
        const old = await openDB(name, 1, {
            upgrade(db) {
                db.createObjectStore('songs', { keyPath: 'id' })
                db.createObjectStore('drafts', { keyPath: 'id' })
                db.createObjectStore('preferences')
            },
        })
        await old.put('songs', song)
        await old.put('drafts', { ...song, lyrics: 'Existing unfinished draft' })
        await old.put('preferences', 'dark', 'theme')
        old.close()
        const migrated = new Library(await openLibrary(name))
        expect(await migrated.list()).toEqual([song])
        expect((await migrated.drafts())[0]?.lyrics).toBe('Existing unfinished draft')
        expect(await migrated.getPreference('theme')).toBe('dark')
        expect(await migrated.profiles()).toEqual([{ id: 'guest', label: 'Guest' }])
        expect(await migrated.isMember()).toBe(false)
        migrated.close()
        const reopened = new Library(await openLibrary(name))
        expect(await reopened.list()).toEqual([song])
        reopened.close()
    })
    it('retains unlimited access offline and enforces logout across tabs without deleting songs', async () => {
        const name = crypto.randomUUID()
        const a = new Library(await openLibrary(name))
        await a.setMember(true)
        for (let i = 0; i < 5; i++) await a.save(newSong())
        const b = new Library(await openLibrary(name))
        expect(await b.isMember()).toBe(true)
        await b.setMember(false)
        await expect(a.save(newSong())).rejects.toBeInstanceOf(QuotaError)
        const first = (await a.list())[0]!
        await a.save({ ...first, lyrics: 'Edited after logout' })
        expect(await a.list()).toHaveLength(5)
        a.close()
        b.close()
    })
    it('isolates account profiles and only copies guest songs after an explicit request', async () => {
        const guest = new Library(await openLibrary(crypto.randomUUID()))
        const a = new Library(await openLibrary(profileDatabase(crypto.randomUUID())))
        const b = new Library(await openLibrary(profileDatabase(crypto.randomUUID())))
        const song = { ...newSong(), lyrics: 'Guest private lyrics' }
        await guest.save(song)
        await guest.saveDraft({ ...song, lyrics: 'Guest unfinished draft' })
        expect(await a.list()).toEqual([])
        expect(await b.list()).toEqual([])
        await a.setMember(true)
        await a.copyFrom(guest)
        expect(await a.list()).toEqual([song])
        expect((await a.drafts())[0]?.lyrics).toBe('Guest unfinished draft')
        await a.save({ ...song, lyrics: 'Account-specific edits' })
        await a.saveDraft({ ...song, lyrics: 'Account-specific draft' })
        await a.copyFrom(guest)
        expect((await a.list())[0]?.lyrics).toBe('Account-specific edits')
        expect((await a.drafts())[0]?.lyrics).toBe('Account-specific draft')
        expect(await guest.list()).toEqual([song])
        expect(await b.list()).toEqual([])
        await expect(b.copyFrom(guest)).rejects.toBeInstanceOf(QuotaError)
        guest.close()
        a.close()
        b.close()
    })
    it('updates reader settings without losing newer lyrics or other draft settings', async () => {
        const db = new Library(await openLibrary(crypto.randomUUID()))
        const song = { ...newSong(), lyrics: 'Newer song from another tab' }
        const draft = {
            ...song,
            lyrics: 'Unfinished private draft',
            settings: { ...song.settings, countIn: 8 },
        }
        await db.save(song)
        await db.saveDraft(draft)
        expect(await db.updateReaderSettings(song.id, { bpm: 150 })).toBe(true)
        expect((await db.list())[0]).toMatchObject({
            lyrics: song.lyrics,
            settings: { bpm: 150, countIn: 4 },
        })
        expect((await db.drafts())[0]).toMatchObject({
            lyrics: draft.lyrics,
            settings: { bpm: 150, countIn: 8 },
        })
        await db.remove(song.id)
        expect(await db.updateReaderSettings(song.id, { fontSize: 40 })).toBe(false)
        expect(await db.list()).toEqual([])
        db.close()
    })
    it('reports an aborted save without an unhandled transaction rejection or partial changes', async () => {
        const db = new Library(await openLibrary(crypto.randomUUID()))
        const song = { ...newSong(), lyrics: 'Original lyrics' }
        await db.save(song)
        const originalPut = IDBObjectStore.prototype.put
        const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
            this: IDBObjectStore,
            value: unknown,
        ) {
            const request = originalPut.call(this, value)
            this.transaction.abort()
            return request
        })
        try {
            await expect(db.save({ ...song, title: 'Interrupted save' })).rejects.toMatchObject({
                name: 'AbortError',
            })
            await new Promise((resolve) => setTimeout(resolve, 0))
        } finally {
            spy.mockRestore()
        }
        expect(await db.list()).toEqual([song])
        db.close()
    })
    it('persists a song across database reopen and clears its saved draft', async () => {
        const name = crypto.randomUUID()
        const first = new Library(await openLibrary(name))
        const song = { ...newSong(), lyrics: 'A private line' }
        await first.saveDraft(song)
        expect(await first.drafts()).toHaveLength(1)
        await first.save(song)
        expect(await first.drafts()).toHaveLength(0)
        first.close()
        const second = new Library(await openLibrary(name))
        expect(await second.list()).toEqual([song])
        second.close()
    })
    it('keeps unsaved drafts recoverable without using a guest song slot', async () => {
        const db = new Library(await openLibrary(crypto.randomUUID()))
        const draft = { ...newSong(), lyrics: '[tempo=broken]' }
        await db.saveDraft(draft)
        expect(await db.list()).toHaveLength(0)
        expect(await db.drafts()).toEqual([draft])
        db.close()
    })
    it('enforces the guest limit atomically across tabs while allowing edits', async () => {
        const name = crypto.randomUUID()
        const a = new Library(await openLibrary(name)),
            b = new Library(await openLibrary(name))
        const first = newSong()
        await a.save(first)
        await a.save(newSong())
        const results = await Promise.allSettled([a.save(newSong()), b.save(newSong())])
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
        expect(rejected.reason).toBeInstanceOf(QuotaError)
        await a.save({ ...first, title: 'Edited' })
        expect(await a.list()).toHaveLength(3)
        a.close()
        b.close()
    })
    it('deletes song and draft together and preserves theme', async () => {
        const db = new Library(await openLibrary(crypto.randomUUID()))
        const song = newSong()
        await db.save(song)
        await db.saveDraft(song)
        await db.setPreference('theme', 'dark')
        await db.remove(song.id)
        expect(await db.list()).toEqual([])
        expect(await db.drafts()).toEqual([])
        expect(await db.getPreference('theme')).toBe('dark')
        db.close()
    })
})
