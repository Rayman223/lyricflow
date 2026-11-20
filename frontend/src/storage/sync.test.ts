import 'fake-indexeddb/auto'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { openDB } from 'idb'
import { Library, openLibrary } from './library'
import { newSong } from '../domain/song'
import type { RemoteRecord, SyncOperation, SyncResponse } from './sync-types'

async function member() {
    const db = new Library(await openLibrary(crypto.randomUUID()))
    await db.setMember(true)
    return db
}
function response(records: RemoteRecord[], result: SyncResponse['result'] = null): SyncResponse {
    return {
        accountId: 'account',
        records,
        result,
        cursor: Math.max(0, ...records.map((r) => r.revision)),
        more: false,
    }
}
async function pending(db: Library, key: string) {
    return (await db.syncEntries()).find((e) => e.key === key)!.operation!
}
async function acknowledge(db: Library, op: SyncOperation, revision: number) {
    await db.acceptSync(
        response([{ key: op.key, revision, value: op.value }], { status: 'applied', revision }),
        op,
    )
}
afterEach(() => vi.restoreAllMocks())

describe('durable private synchronization', () => {
    it('retries the immutable request after a lost response even if lyrics changed before reopening', async () => {
        const name = crypto.randomUUID(),
            first = new Library(await openLibrary(name))
        await first.setMember(true)
        const song = { ...newSong(), lyrics: 'First upload' },
            key = `song.${song.id}`
        await first.save(song)
        const sent = (await first.nextSyncOperation())!
        first.close()
        const reopened = new Library(await openLibrary(name))
        await reopened.save({ ...song, lyrics: 'Edited after losing the response' })
        expect(await reopened.nextSyncOperation()).toEqual(sent)
        await acknowledge(reopened, sent, 1)
        const next = await reopened.nextSyncOperation()
        expect(next?.baseRevision).toBe(1)
        expect(next?.id).not.toBe(sent.id)
        expect(next?.value).toMatchObject({ song: { lyrics: 'Edited after losing the response' } })
        await acknowledge(reopened, next!, 2)
        expect((await reopened.syncEntries())[0]?.inFlight).toBeUndefined()
        expect((await reopened.syncEntries())[0]?.operation).toBeUndefined()
        expect((await pending(reopened, key))?.id).toBeUndefined()
        reopened.close()
    })
    it('allows an explicit choice of local or online data and protects the signed-out creation quota', async () => {
        for (const choice of ['local', 'server'] as const) {
            const db = await member(),
                song = { ...newSong(), lyrics: 'Local' },
                key = `song.${song.id}`
            await db.save(song)
            await db.acceptSync(
                response([
                    {
                        key,
                        revision: 3,
                        value: { song: { ...song, lyrics: 'Server' }, draft: null },
                    },
                ]),
            )
            await db.resolveConflict(key, choice, 3)
            expect((await db.list())[0]?.lyrics).toBe(choice === 'local' ? 'Local' : 'Server')
            const entry = (await db.syncEntries())[0]!
            expect(entry.conflict).toBeUndefined()
            expect(entry.operation?.baseRevision).toBe(choice === 'local' ? 3 : undefined)
            db.close()
        }
        const db = await member(),
            song = newSong(),
            key = `song.${song.id}`
        for (const value of [song, newSong(), newSong()]) await db.save(value)
        await db.acceptSync(response([{ key, revision: 1, value: { song, draft: null } }]))
        await db.setMember(false)
        await expect(db.resolveConflict(key, 'both', 1)).rejects.toThrow('guestLimit')
        expect(await db.list()).toHaveLength(3)
        db.close()
    })
    it('migrates v2 lazily without changing existing lyrics, drafts, membership or theme', async () => {
        const name = crypto.randomUUID()
        const song = newSong()
        const old = await openDB(name, 2, {
            upgrade(db) {
                db.createObjectStore('songs', { keyPath: 'id' })
                db.createObjectStore('drafts', { keyPath: 'id' })
                db.createObjectStore('preferences')
                db.createObjectStore('profiles', { keyPath: 'id' })
            },
        })
        await old.put('songs', song)
        await old.put('drafts', { ...song, lyrics: 'Unfinished' })
        await old.put('preferences', 'member', 'membership')
        await old.put('preferences', 'dark', 'theme')
        old.close()
        const db = new Library(await openLibrary(name))
        await db.prepareSync()
        const ops = (await db.syncEntries()).map((e) => e.operation)
        expect(ops).toHaveLength(2)
        expect(await db.list()).toEqual([song])
        expect((await db.drafts())[0]?.lyrics).toBe('Unfinished')
        await db.prepareSync()
        expect((await db.syncEntries()).map((e) => e.operation)).toEqual(ops)
        expect(await db.isMember()).toBe(true)
        db.close()
    })

    it('retains newer edits made while a request is in flight and advances their base revision', async () => {
        const db = await member(),
            song = newSong(),
            key = `song.${song.id}`
        await db.save(song)
        const sent = await pending(db, key)
        await db.save({ ...song, lyrics: 'Typed while uploading' })
        await acknowledge(db, sent, 1)
        const next = await pending(db, key)
        expect(next.id).not.toBe(sent.id)
        expect(next.baseRevision).toBe(1)
        expect(next.value).toMatchObject({ song: { lyrics: 'Typed while uploading' } })
        await acknowledge(db, next, 2)
        expect((await db.syncEntries())[0]?.operation).toBeUndefined()
        expect((await db.list())[0]?.lyrics).toBe('Typed while uploading')
        db.close()
    })

    it('keeps both versions of conflicts across reopen and can choose two separate songs', async () => {
        const name = crypto.randomUUID(),
            db = new Library(await openLibrary(name))
        await db.setMember(true)
        const song = { ...newSong(), lyrics: 'On device' },
            key = `song.${song.id}`
        await db.save(song)
        const remote: RemoteRecord = {
            key,
            revision: 2,
            value: { song: { ...song, lyrics: 'On server' }, draft: null },
        }
        await db.acceptSync(
            response([remote], { status: 'conflict', record: remote }),
            await pending(db, key),
        )
        db.close()
        const reopened = new Library(await openLibrary(name))
        expect((await reopened.list())[0]?.lyrics).toBe('On device')
        expect((await reopened.syncEntries())[0]?.conflict).toEqual(remote)
        await reopened.resolveConflict(key, 'both', 2)
        expect((await reopened.list()).map((s) => s.lyrics).sort()).toEqual([
            'On device',
            'On server',
        ])
        expect((await reopened.syncEntries()).filter((e) => e.operation)).toHaveLength(1)
        reopened.close()
    })

    it('preserves drafts and reader settings in pending snapshots', async () => {
        const db = await member(),
            song = newSong(),
            key = `song.${song.id}`
        await db.save(song)
        await db.saveDraft({ ...song, lyrics: '[invalid draft]' })
        await db.updateReaderSettings(song.id, { bpm: 145 })
        expect((await pending(db, key)).value).toMatchObject({
            song: { settings: { bpm: 145 } },
            draft: { lyrics: '[invalid draft]', settings: { bpm: 145 } },
        })
        await db.discardDraft(song.id)
        expect((await pending(db, key)).value).toMatchObject({ draft: null })
        db.close()
    })

    it('propagates deletions and uses a new identity when keeping a remotely deleted song', async () => {
        const db = await member(),
            song = { ...newSong(), lyrics: 'Offline edits' },
            key = `song.${song.id}`
        await db.save(song)
        await acknowledge(db, await pending(db, key), 1)
        await db.saveDraft({ ...song, lyrics: 'Unfinished offline edits' })
        const remote = { key, revision: 2, value: null }
        await db.acceptSync(response([remote]))
        await db.resolveConflict(key, 'local', 2)
        const [copy] = await db.list()
        expect(copy?.id).not.toBe(song.id)
        expect((await db.drafts())[0]?.id).toBe(copy?.id)
        expect((await db.syncEntries()).find((e) => e.key === key)?.operation).toBeUndefined()
        await db.remove(copy!.id)
        expect((await pending(db, `song.${copy!.id}`)).value).toBeNull()
        db.close()
    })

    it('applies server changes and deletions only when no local changes need preserving', async () => {
        const db = await member(),
            song = newSong(),
            key = `song.${song.id}`
        await db.acceptSync(
            response([
                { key, revision: 1, value: { song, draft: { ...song, lyrics: 'Restored draft' } } },
            ]),
        )
        expect(await db.list()).toEqual([song])
        expect((await db.drafts())[0]?.lyrics).toBe('Restored draft')
        await db.acceptSync(response([{ key, revision: 2, value: null }]))
        expect(await db.list()).toEqual([])
        expect(await db.drafts()).toEqual([])
        await db.acceptSync(response([{ key, revision: 1, value: { song, draft: null } }]))
        expect(await db.list()).toEqual([])
        expect(await db.syncCursor()).toBe(2)
        db.close()
    })

    it('preserves local theme changes until server confirmation and then accepts new preferences', async () => {
        const db = await member()
        await db.setPreference('theme', 'dark')
        await db.acceptSync(response([{ key: 'theme', revision: 1, value: { theme: 'light' } }]))
        expect(await db.getPreference('theme')).toBe('dark')
        expect((await pending(db, 'theme')).baseRevision).toBe(1)
        await acknowledge(db, await pending(db, 'theme'), 2)
        await db.acceptSync(response([{ key: 'theme', revision: 3, value: { theme: 'light' } }]))
        expect(await db.getPreference('theme')).toBe('light')
        db.close()
    })

    it('rejects stale conflict choices and rolls back songs, queue and cursor on write failure', async () => {
        const db = await member(),
            song = newSong(),
            key = `song.${song.id}`
        await db.save(song)
        await db.acceptSync(
            response([
                { key, revision: 2, value: { song: { ...song, lyrics: 'Server' }, draft: null } },
            ]),
        )
        await expect(db.resolveConflict(key, 'server', 1)).rejects.toThrow('conflictChanged')
        const put = IDBObjectStore.prototype.put
        const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
            this: IDBObjectStore,
            value,
            key,
        ) {
            const request = key === undefined ? put.call(this, value) : put.call(this, value, key)
            this.transaction.abort()
            return request
        })
        await expect(db.resolveConflict(key, 'server', 2)).rejects.toMatchObject({
            name: 'AbortError',
        })
        spy.mockRestore()
        expect(await db.list()).toEqual([song])
        expect((await db.syncEntries())[0]?.conflict?.revision).toBe(2)
        db.close()
    })

    it('ignores late responses after logout or deletion and honors keeping or erasing local songs', async () => {
        for (const erase of [false, true]) {
            const db = await member(),
                song = newSong(),
                key = `song.${song.id}`
            await db.save(song)
            const op = await pending(db, key)
            await db.detach(erase)
            await acknowledge(db, op, 1)
            expect(await db.isMember()).toBe(false)
            expect(await db.syncEntries()).toEqual([])
            expect(await db.list()).toEqual(erase ? [] : [song])
            db.close()
        }
    })
    it('also retains the online conflict copy when account deletion keeps local songs', async () => {
        const db = await member(),
            song = { ...newSong(), lyrics: 'Local' },
            key = `song.${song.id}`
        await db.save(song)
        await db.acceptSync(
            response([
                {
                    key,
                    revision: 1,
                    value: { song: { ...song, lyrics: 'Conflicting online copy' }, draft: null },
                },
            ]),
        )
        await db.detach(false)
        expect((await db.list()).map((s) => s.lyrics).sort()).toEqual([
            'Conflicting online copy',
            'Local',
        ])
        expect(await db.isMember()).toBe(false)
        expect(await db.syncEntries()).toEqual([])
        db.close()
    })
})
