import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { openDB } from 'idb'
import cases from '../../../tests/fixtures/music-links.json'
import { validMusicLink, validMusicLinks, cleanMusicLinks, type MusicService } from './musicLinks'
import { newSong } from './song'
import { Library, openLibrary } from '../storage/library'
import {
    sharedContent,
    sharedSignature,
    copyPublication,
    type Publication,
} from '../community/model'

it.each(cases)('validates $service: $url ($valid)', ({ service, url, valid }) => {
    expect(validMusicLink(service as MusicService, url)).toBe(valid)
})

it('omits blank fields and keeps a stable signature regardless of service insertion order', () => {
    const song = newSong()
    const youtube = 'https://youtu.be/dQw4w9WgXcQ'
    expect(validMusicLinks({ youtube: ' unfinished ' })).toBe(false)
    expect(validMusicLinks({ youtube: '   ' })).toBe(true)
    expect(cleanMusicLinks({ youtube: ` ${youtube} `, spotify: '' })).toEqual({ youtube })
    expect(sharedSignature(sharedContent(song))).toBe(
        sharedSignature({ ...sharedContent(song), musicLinks: {} }),
    )
    const first = { ...song, musicLinks: { youtube, deezer: 'https://deezer.com/track/1' } }
    const second = { ...song, musicLinks: { deezer: 'https://deezer.com/track/1', youtube } }
    expect(sharedSignature(sharedContent(first))).toBe(sharedSignature(sharedContent(second)))
    expect(sharedSignature(sharedContent(first))).not.toBe(sharedSignature(sharedContent(song)))
})

it('preserves v7 songs, invalid drafts and exact queued requests through migration and reopening', async () => {
    const name = crypto.randomUUID(),
        song = newSong()
    const old = await openDB(name, 7, {
        upgrade(db) {
            for (const store of ['songs', 'drafts']) db.createObjectStore(store, { keyPath: 'id' })
            db.createObjectStore('preferences')
            db.createObjectStore('profiles', { keyPath: 'id' })
            db.createObjectStore('sync', { keyPath: 'key' })
            db.createObjectStore('community', { keyPath: 'localSongId' })
        },
    })
    await old.put('songs', song)
    await old.put('drafts', { ...song, lyrics: 'unfinished' })
    const entry = {
        key: `song.${song.id}`,
        revision: 2,
        operation: {
            id: crypto.randomUUID(),
            key: `song.${song.id}`,
            baseRevision: 2,
            value: { song, draft: null },
        },
    }
    await old.put('sync', entry)
    await old.put('preferences', 'dark', 'theme')
    old.close()
    const library = new Library(await openLibrary(name))
    expect(await library.list()).toEqual([song])
    expect((await library.drafts())[0]?.lyrics).toBe('unfinished')
    expect(await library.syncEntries()).toEqual([entry])
    expect(await library.getPreference('theme')).toBe('dark')
    expect(await library.getPreference('musicLinksFormat')).toBe('1')
    await library.saveDraft({ ...song, musicLinks: { youtube: 'unfinished' } })
    library.close()
    const reopened = new Library(await openLibrary(name))
    expect((await reopened.drafts())[0]?.musicLinks?.youtube).toBe('unfinished')
    expect((await reopened.syncEntries())[0]?.operation?.value).toMatchObject({
        draft: { musicLinks: { youtube: 'unfinished' } },
    })
    reopened.close()
})

it('copies links independently and protects customized links from a source update', async () => {
    const content = sharedContent({
        ...newSong(),
        title: 'Song',
        lyrics: 'Lyrics',
        musicLinks: { deezer: 'https://deezer.com/track/1' },
    })
    const publication = { id: crypto.randomUUID(), revision: 1, content } as Publication
    const copy = copyPublication(publication)
    copy.musicLinks!.deezer = 'https://deezer.com/track/2'
    expect(content.musicLinks?.deezer).toBe('https://deezer.com/track/1')
    const library = new Library(await openLibrary(crypto.randomUUID()))
    await library.save(copy)
    expect(await library.updateFromPublication(copy.id, { ...publication, revision: 2 })).toBe(
        'customized',
    )
    await library.updateReaderSettings(copy.id, { bpm: 80 })
    expect((await library.list())[0]?.musicLinks).toEqual(copy.musicLinks)
    library.close()
})

it('uses the editor UTF-16 length limit for Unicode query parameters', () => {
    const prefix = 'https://youtu.be/dQw4w9WgXcQ?label='
    const accented = prefix + 'é'.repeat(2048 - prefix.length)
    const emoji = prefix + '🎵'.repeat(Math.floor((2048 - prefix.length) / 2))
    expect(validMusicLink('youtube', accented)).toBe(true)
    expect(validMusicLink('youtube', accented + 'a')).toBe(false)
    expect(validMusicLink('youtube', emoji)).toBe(true)
    expect(validMusicLink('youtube', emoji + '🎵')).toBe(false)
})
