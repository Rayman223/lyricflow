import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { openDB } from 'idb'
import { Library, openLibrary } from '../storage/library'
import { newSong } from '../domain/song'
import { applyPublication, copyPublication, sharedContent, type Publication } from './model'

function publication(): Publication {
    const song = {
        ...newSong(),
        title: 'Shared song',
        lyrics: 'Original lyrics',
        settings: {
            ...newSong().settings,
            bpm: 90,
            beatsPerBar: 3,
            barsPerLine: 2,
            fontSize: 70,
            sound: true,
        },
    }
    return {
        id: crypto.randomUUID(),
        catalogId: crypto.randomUUID(),
        author: 'musician',
        authorId: crypto.randomUUID(),
        revision: 1,
        updatedAt: new Date().toISOString(),
        average: null,
        ratingCount: 0,
        published: true,
        hidden: false,
        source: null,
        content: sharedContent(song),
    }
}

describe('private copies of community publications', () => {
    it('shares only musical content and creates independent private identities', () => {
        const pub = publication(),
            first = copyPublication(pub),
            second = copyPublication(pub)
        expect(first.id).not.toBe(second.id)
        expect(first.settings).toMatchObject({
            bpm: 90,
            beatsPerBar: 3,
            barsPerLine: 2,
            fontSize: 32,
            sound: false,
        })
        expect(Object.keys(pub.content.music).sort()).toEqual(['barsPerLine', 'beatsPerBar', 'bpm'])
        expect(first.source).toEqual({ publicationId: pub.id, revision: 1, base: pub.content })
        first.source!.base.lyrics = 'Changed private baseline'
        expect(pub.content.lyrics).toBe('Original lyrics')
    })
    it('migrates v3 without losing queued operations, drafts or preferences', async () => {
        const name = crypto.randomUUID(),
            song = newSong()
        const old = await openDB(name, 3, {
            upgrade(db) {
                db.createObjectStore('songs', { keyPath: 'id' })
                db.createObjectStore('drafts', { keyPath: 'id' })
                db.createObjectStore('profiles', { keyPath: 'id' })
                db.createObjectStore('sync', { keyPath: 'key' })
                db.createObjectStore('preferences')
            },
        })
        await old.put('songs', song)
        await old.put('drafts', { ...song, lyrics: 'Unfinished' })
        await old.put('preferences', 'dark', 'theme')
        const entry = {
            key: `song.${song.id}`,
            revision: 2,
            operation: {
                id: crypto.randomUUID(),
                key: `song.${song.id}`,
                baseRevision: 2,
                value: null,
            },
        }
        await old.put('sync', entry)
        old.close()
        const migrated = new Library(await openLibrary(name))
        expect(await migrated.list()).toEqual([song])
        expect((await migrated.drafts())[0]?.lyrics).toBe('Unfinished')
        expect(await migrated.syncEntries()).toEqual([entry])
        expect(await migrated.getPreference('theme')).toBe('dark')
        expect(await migrated.getPreference('communityFormat')).toBe('1')
        migrated.close()
    })
    it('updates unchanged content while retaining personal display settings and queueing synchronization', async () => {
        const db = new Library(await openLibrary(crypto.randomUUID())),
            pub = publication()
        const copy = copyPublication(pub)
        copy.settings.fontSize = 48
        copy.settings.speedMode = 'pixels'
        copy.settings.sound = true
        await db.save(copy)
        const updated = {
            ...pub,
            revision: 2,
            content: {
                ...pub.content,
                lyrics: 'New revision',
                music: { ...pub.content.music, bpm: 145 },
            },
        }
        expect(await db.updateFromPublication(copy.id, updated)).toBe('updated')
        expect((await db.list())[0]).toMatchObject({
            lyrics: 'New revision',
            settings: { fontSize: 48, speedMode: 'pixels', sound: true, bpm: 145 },
            source: { revision: 2, base: updated.content },
        })
        expect((await db.syncEntries())[0]?.operation?.value).toMatchObject({
            song: { lyrics: 'New revision', source: { revision: 2 } },
        })
        db.close()
    })
    it('never replaces customized lyrics, musical settings or a newer draft', async () => {
        for (const kind of ['lyrics', 'music', 'draft'] as const) {
            const db = new Library(await openLibrary(crypto.randomUUID())),
                pub = publication(),
                copy = copyPublication(pub)
            if (kind === 'lyrics') copy.lyrics = 'Personal adaptation'
            if (kind === 'music') copy.settings.bpm = 150
            await db.save(copy)
            if (kind === 'draft') await db.saveDraft({ ...copy, lyrics: 'Unfinished adaptation' })
            const updated = {
                ...pub,
                revision: 2,
                content: { ...pub.content, lyrics: 'New revision' },
            }
            expect(await db.updateFromPublication(copy.id, updated)).toBe('customized')
            expect(await db.list()).toEqual([copy])
            if (kind === 'draft')
                expect((await db.drafts())[0]?.lyrics).toBe('Unfinished adaptation')
            db.close()
        }
    })
    it('does not recreate a removed song or apply another publication to its source', async () => {
        const db = new Library(await openLibrary(crypto.randomUUID())),
            pub = publication(),
            copy = copyPublication(pub)
        await db.save(copy)
        expect(await db.updateFromPublication(copy.id, publication())).toBe('unavailable')
        await db.remove(copy.id)
        expect(await db.updateFromPublication(copy.id, pub)).toBe('unavailable')
        expect(await db.list()).toEqual([])
        db.close()
    })
    it('preserves personal reader options when building a revision from its shared content', () => {
        const pub = publication(),
            local = copyPublication(pub)
        local.settings.presentation = 'continuous'
        local.settings.countIn = 8
        const updated = applyPublication(local, { ...pub, revision: 3 })
        expect(updated.settings).toMatchObject({ presentation: 'continuous', countIn: 8 })
        expect(updated.id).toBe(local.id)
    })
    it('never downgrades a copy after another tab already accepted a newer revision', async () => {
        const db = new Library(await openLibrary(crypto.randomUUID())),
            pub = publication()
        const latest = {
                ...pub,
                revision: 3,
                content: { ...pub.content, lyrics: 'Newest revision' },
            },
            copy = copyPublication(latest)
        await db.save(copy)
        expect(await db.updateFromPublication(copy.id, pub)).toBe('current')
        expect(await db.list()).toEqual([copy])
        db.close()
    })
})
