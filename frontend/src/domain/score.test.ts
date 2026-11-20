import 'fake-indexeddb/auto'
import { reactive } from 'vue'
import { midi, Settings } from '@coderline/alphatab'
import { expect, it } from 'vitest'
import { openDB } from 'idb'
import fixture from '../../../tests/fixtures/score.json'
import { alphaScore, prepareScoreMidi } from './alphaScore'
import {
    arrangementErrors,
    barTicks,
    copyBars,
    cloneMusic,
    duplicateArrangement,
    eventTicks,
    newArrangement,
    scoreStructure,
    uid,
    type Arrangement,
    type ScoreEvent,
} from './score'
import { newSong } from './song'
import { Library, openLibrary } from '../storage/library'
import {
    applyPublication,
    copyPublication,
    sharedContent,
    sharedSignature,
    type Publication,
} from '../community/model'
const ensemble = () => structuredClone(fixture) as Arrangement
it('converts standard guitar, bass, two piano staves and percussion without persisting alphaTab data', () => {
    const a = ensemble(),
        before = JSON.stringify(a),
        score = alphaScore(a)
    expect(arrangementErrors(a)).toEqual([])
    expect(score.tempo).toBe(120)
    expect(score.masterBars[1]!.start).toBe(3840)
    expect(score.tracks.map((t) => t.staves.length)).toEqual([1, 1, 1, 2, 1])
    for (const [i, expected] of [64, 64, 43, 60, 36].entries())
        expect(score.tracks[i]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!.realValue).toBe(
            expected,
        )
    expect(score.tracks[3]!.staves[1]!.bars[0]!.clef).toBe(3)
    expect(score.tracks.map((t) => t.playbackInfo.primaryChannel)).toEqual([0, 1, 2, 3, 4])
    expect(score.tracks[4]!.playbackInfo.bank).toBe(128)
    expect(JSON.stringify(a)).toBe(before)
})
it('keeps incomplete drafts, checks exact dotted and triplet durations and rejects broken ties and tablatures', () => {
    expect(arrangementErrors(newArrangement()).length).toBeGreaterThan(0)
    const a = ensemble(),
        v = a.tracks[0]!.staves[0]!.measures[0]!.voices[0]!,
        source = v.events[0]!
    v.events = [
        { ...source, id: uid(), duration: 2, dots: 1 },
        { ...source, id: uid(), duration: 4, notes: [] },
    ]
    expect(v.events.reduce((sum, e) => sum + eventTicks(e), 0)).toBe(barTicks(a))
    expect(arrangementErrors(a)).toEqual([])
    v.events = Array.from(
        { length: 3 },
        (_, i) =>
            ({
                ...structuredClone(source),
                id: uid(),
                duration: 2,
                triplet: true,
                notes: [{ ...source.notes[0]!, id: uid(), tie: i < 2 }],
            }) as ScoreEvent,
    )
    expect(arrangementErrors(a)).toEqual([])
    const score = alphaScore(a),
        beats = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats
    expect(beats.map((b) => b.playbackDuration)).toEqual([1280, 1280, 1280])
    expect(beats[1]!.notes[0]!.isTieDestination).toBe(true)
    v.events[2]!.notes[0]!.fret = 1
    expect(arrangementErrors(a).join()).toContain('match the pitch')
    v.events[2]!.notes = []
    expect(arrangementErrors(a).join()).toContain('tie needs')
    v.events.pop()
    expect(arrangementErrors(a).join()).toContain('triplet')
})
it('preserves independent voices, chords, key signatures and note spelling in the adapter', () => {
    const a = ensemble(),
        staff = a.tracks[3]!.staves[0]!,
        voice = staff.measures[0]!.voices[0]!
    a.key = -3
    a.mode = 'minor'
    voice.events[0]!.notes.push({ id: uid(), pitch: 63, spelling: 'flat', tie: false })
    staff.measures[0]!.voices.push({
        id: uid(),
        events: [{ id: uid(), duration: 1, dots: 0, triplet: false, notes: [] }],
    })
    expect(arrangementErrors(a)).toEqual([])
    const bar = alphaScore(a).tracks[3]!.staves[0]!.bars[0]!
    expect(bar.keySignature).toBe(-3)
    expect(bar.keySignatureType).toBe(1)
    expect(bar.voices).toHaveLength(2)
    expect(bar.voices[0]!.beats[0]!.notes[1]!.accidentalMode).toBe(5)
})
it('duplicates passages and arrangements independently with fresh stable ids', () => {
    const a = ensemble(),
        copy = duplicateArrangement(a)
    expect(scoreStructure([a, copy])).toBe(true)
    copy.tracks[0]!.name = 'Different'
    expect(a.tracks[0]!.name).toBe('Lead guitar')
    copyBars(a, 0, 1)
    expect(a.bars).toHaveLength(4)
    expect(arrangementErrors(a)).toEqual([])
})
it('rejects oversized or forged formats but accepts incomplete musical drafts', () => {
    const a = ensemble()
    expect(scoreStructure([newArrangement()])).toBe(true)
    expect(scoreStructure([{ ...a, privateUrl: 'https://example.test' }])).toBe(false)
    expect(scoreStructure([{ ...a, tracks: Array(65).fill(a.tracks[0]) }])).toBe(false)
    expect(scoreStructure([{ ...a, name: 'a'.repeat(1000001) }])).toBe(false)
    a.tracks[0]!.staves[0]!.measures[0]!.voices[0]!.events[0]!.notes[0]!.pitch = 128
    expect(scoreStructure([a])).toBe(false)
})
it('migrates v8 preserving exact queued snapshots, then reopens incomplete score drafts', async () => {
    const name = uid(),
        song = newSong(),
        old = await openDB(name, 8, {
            upgrade(db) {
                for (const key of ['songs', 'drafts']) db.createObjectStore(key, { keyPath: 'id' })
                db.createObjectStore('preferences')
                db.createObjectStore('profiles', { keyPath: 'id' })
                db.createObjectStore('sync', { keyPath: 'key' })
                db.createObjectStore('community', { keyPath: 'localSongId' })
            },
        })
    const entry = {
        key: `song.${song.id}`,
        revision: 1,
        operation: {
            id: uid(),
            key: `song.${song.id}`,
            baseRevision: 1,
            value: { song, draft: null },
        },
    }
    await old.put('songs', song)
    await old.put('sync', entry)
    old.close()
    const lib = new Library(await openLibrary(name))
    expect(await lib.syncEntries()).toEqual([entry])
    expect(await lib.list()).toEqual([song])
    expect(await lib.getPreference('scoreFormat')).toBe('1')
    await lib.saveDraft({ ...song, arrangements: [newArrangement()] })
    lib.close()
    const reopened = new Library(await openLibrary(name))
    expect((await reopened.drafts())[0]!.arrangements).toHaveLength(1)
    expect((await reopened.syncEntries())[0]!.operation!.value).toMatchObject({
        draft: { arrangements: [{ version: 1 }] },
    })
    reopened.close()
})
it('protects score adaptations from public source updates and compares their whole version', async () => {
    const song = { ...newSong(), title: 'Instrumental', arrangements: [ensemble()] },
        content = sharedContent(song)
    const publication = { id: uid(), revision: 1, content } as Publication,
        copy = copyPublication(publication)
    expect(sharedSignature({ ...content, arrangements: undefined })).toBe(
        sharedSignature({ ...content, arrangements: [] }),
    )
    copy.arrangements![0]!.tempo = 80
    expect(content.arrangements![0]!.tempo).toBe(120)
    expect(sharedSignature(sharedContent(copy))).not.toBe(sharedSignature(content))
    const library = new Library(await openLibrary(uid()))
    await library.save(copy)
    expect(await library.updateFromPublication(copy.id, { ...publication, revision: 2 })).toBe(
        'customized',
    )
    expect(
        applyPublication(song, { ...publication, content: { ...content, arrangements: [] } })
            .arrangements,
    ).toEqual([])
    library.close()
})

it('keeps both complete song versions including drafts and arrangements through a conflict', async () => {
    const name = uid(),
        library = new Library(await openLibrary(name)),
        song = { ...newSong(), arrangements: [ensemble()] }
    await library.setMember(true)
    await library.save(song)
    const operation = (await library.nextSyncOperation())!,
        remoteSong = structuredClone(song)
    remoteSong.arrangements[0]!.tempo = 85
    const remote = { key: `song.${song.id}`, revision: 2, value: { song: remoteSong, draft: null } }
    await library.acceptSync(
        {
            accountId: 'account',
            records: [remote],
            result: { status: 'conflict', record: remote },
            cursor: 2,
            more: false,
        },
        operation,
    )
    library.close()
    const reopened = new Library(await openLibrary(name))
    expect((await reopened.syncEntries())[0]!.conflict!.value).toMatchObject({
        song: { arrangements: [{ tempo: 85 }] },
    })
    await reopened.resolveConflict(remote.key, 'both', 2)
    expect((await reopened.list()).map((s) => s.arrangements![0]!.tempo).sort()).toEqual(
        [120, 85].sort(),
    )
    const other = new Library(await openLibrary(uid()))
    expect(await other.list()).toEqual([])
    reopened.close()
    other.close()
})

it('gives every instrument and drum track an independent synth channel and preloads all drum samples silently', () => {
    const a = ensemble(),
        extra = duplicateArrangement(a).tracks[4]!
    a.tracks.push(extra)
    const score = alphaScore(a)
    expect(new Set(score.tracks.map((t) => t.playbackInfo.primaryChannel)).size).toBe(6)
    expect(score.tracks[5]!.playbackInfo.bank).toBe(128)
    const file = new midi.MidiFile(),
        handler = new midi.AlphaSynthMidiFileHandler(file),
        generator = new midi.MidiFileGenerator(score, new Settings(), handler)
    generator.generate()
    prepareScoreMidi(file, a)
    const silent = file.tracks
        .flatMap((t) => t.events)
        .filter((e) => e instanceof midi.NoteOnEvent && e.noteVelocity === 0) as midi.NoteOnEvent[]
    expect(silent.map((e) => e.noteKey)).toEqual([36, 38, 42, 46, 49, 51, 45, 48, 50])
    expect(silent.every((e) => e.channel === 9 && e.tick === 0)).toBe(true)
    const sounding = file.tracks
        .flatMap((t) => t.events)
        .filter((e) => e instanceof midi.NoteOnEvent && e.noteVelocity > 0) as midi.NoteOnEvent[]
    expect(new Set(sounding.map((e) => e.channel)).size).toBe(6)
    expect(sounding.some((e) => e.channel === 9)).toBe(false)
})

it('does not connect a tie over a measure where the voice is absent', () => {
    const a = ensemble()
    copyBars(a, 0, 0)
    const staff = a.tracks[3]!.staves[0]!,
        base = staff.measures[0]!.voices[0]!
    const first = cloneMusic(base),
        last = cloneMusic(base)
    first.events[0]!.notes[0]!.tie = true
    staff.measures[0]!.voices.push(first)
    staff.measures[2]!.voices.push(last)
    expect(arrangementErrors(a).join()).toContain('tie needs')
})

it('takes a plain snapshot of reactive score data for sharing without changing the editor', () => {
    const song = reactive({ ...newSong(), arrangements: [ensemble()] })
    const content = sharedContent(song)
    content.arrangements![0]!.tempo = 85
    expect(song.arrangements[0]!.tempo).toBe(120)
    expect(() => structuredClone(content)).not.toThrow()
})

it('advertises explicit empty scores on new legacy-song operations while keeping old retry snapshots intact', async () => {
    const library = new Library(await openLibrary(uid())),
        song = newSong()
    await library.save(song)
    expect((await library.syncEntries())[0]!.operation!.value).toMatchObject({
        song: { arrangements: [] },
    })
    await library.saveDraft({ ...song, arrangements: [newArrangement()] })
    await library.discardDraft(song.id)
    expect((await library.syncEntries())[0]!.operation!.value).toMatchObject({
        song: { arrangements: [] },
        draft: null,
    })
    expect((await library.list())[0]!.arrangements).toBeUndefined()
    library.close()
})

it('compares object key order and the implicit major mode as the same score version', () => {
    const song = { ...newSong(), arrangements: [ensemble()] },
        original = sharedContent(song)
    const reordered = JSON.parse(JSON.stringify(original.arrangements), (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).reverse())
            : value,
    )
    reordered[0].mode = 'major'
    expect(sharedSignature({ ...original, arrangements: reordered })).toBe(
        sharedSignature(original),
    )
    reordered[0].mode = 'minor'
    expect(sharedSignature({ ...original, arrangements: reordered })).not.toBe(
        sharedSignature(original),
    )
})
