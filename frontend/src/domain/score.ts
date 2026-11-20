// LyricFlow score format v1. Only musical data belongs here; mixer and viewport
// state are deliberately ephemeral. Durations use 96 ticks per quarter note.
export type Instrument = 'guitar' | 'bass' | 'piano' | 'drums'
export type Duration = 1 | 2 | 4 | 8 | 16 | 32 | 64
export interface ScoreNote {
    id: string
    pitch: number
    spelling: 'auto' | 'sharp' | 'flat'
    tie: boolean // Continue the same pitch in the next event of this voice.
    string?: number // 1 is the highest string, as on a printed tablature.
    fret?: number
}
export interface ScoreEvent {
    id: string
    duration: Duration
    dots: 0 | 1 | 2
    triplet: boolean
    notes: ScoreNote[] // Empty means a rest.
}
export interface ScoreVoice {
    id: string
    events: ScoreEvent[]
}
export interface ScoreMeasure {
    id: string
    voices: ScoreVoice[]
}
export interface ScoreStaff {
    id: string
    clef: 'treble' | 'bass' | 'percussion'
    measures: ScoreMeasure[]
}
export interface ScoreTrack {
    id: string
    name: string
    instrument: Instrument
    staves: ScoreStaff[]
}
export interface Arrangement {
    id: string
    version: 1
    name: string
    tempo: number
    numerator: number
    denominator: 2 | 4 | 8 | 16
    mode?: 'major' | 'minor' // Absence is major in format v1.
    key: number // Circle of fifths, -7 (seven flats) through +7.
    bars: string[]
    tracks: ScoreTrack[]
}
export const instruments: Instrument[] = ['guitar', 'bass', 'piano', 'drums']
export const durations: Duration[] = [1, 2, 4, 8, 16, 32, 64]
export const tunings = { guitar: [64, 59, 55, 50, 45, 40], bass: [43, 38, 33, 28] }
export const drumPitches = [36, 38, 42, 46, 49, 51, 45, 48, 50] as const
export const scoreLimits = { bytes: 1_000_000, events: 30000, tracks: 64, bars: 1000 }
export const uid = () => crypto.randomUUID()
export const emptyMeasure = (): ScoreMeasure => ({ id: uid(), voices: [{ id: uid(), events: [] }] })
export function newTrack(instrument: Instrument, bars: number): ScoreTrack {
    return {
        id: uid(),
        name: instrument[0]!.toUpperCase() + instrument.slice(1),
        instrument,
        staves: (instrument === 'piano'
            ? (['treble', 'bass'] as const)
            : ([
                  instrument === 'drums' ? 'percussion' : instrument === 'bass' ? 'bass' : 'treble',
              ] as const)
        ).map((clef) => ({
            id: uid(),
            clef,
            measures: Array.from({ length: bars }, emptyMeasure),
        })),
    }
}
export function newArrangement(): Arrangement {
    return {
        id: uid(),
        version: 1,
        name: 'Arrangement',
        tempo: 120,
        numerator: 4,
        denominator: 4,
        key: 0,
        bars: [uid()],
        tracks: [newTrack('guitar', 1)],
    }
}
export function eventTicks(event: ScoreEvent): number {
    return (
        (384 / event.duration) *
        (event.dots === 2 ? 1.75 : event.dots === 1 ? 1.5 : 1) *
        (event.triplet ? 2 / 3 : 1)
    )
}
export function barTicks(a: Arrangement): number {
    return (a.numerator * 384) / a.denominator
}
export function cloneMusic<T>(value: T): T {
    // Regenerate all stable identifiers when duplicating a passage/arrangement.
    return JSON.parse(JSON.stringify(value), (key, item) => (key === 'id' ? uid() : item)) as T
}
export function duplicateArrangement(a: Arrangement): Arrangement {
    return { ...cloneMusic(a), bars: a.bars.map(uid), name: `${a.name} (copy)` }
}
export function addBar(a: Arrangement) {
    a.bars.push(uid())
    for (const t of a.tracks) for (const s of t.staves) s.measures.push(emptyMeasure())
}
export function copyBars(a: Arrangement, start: number, end: number) {
    const count = end - start + 1
    a.bars.push(...Array.from({ length: count }, uid))
    for (const t of a.tracks)
        for (const s of t.staves)
            s.measures.push(...s.measures.slice(start, end + 1).map(cloneMusic))
}

// Structural validation is shared by private drafts and publishable content.
// Musical validation below is stricter, so an unfinished bar can always be saved.
export function scoreStructure(value: unknown): boolean {
    if (value === undefined) return true
    if (!Array.isArray(value)) return false
    try {
        if (new TextEncoder().encode(JSON.stringify(value)).length > scoreLimits.bytes) return false
    } catch {
        return false
    }
    const ids = new Set<string>()
    const id = (v: unknown) =>
        typeof v === 'string' && /^[\da-f-]{36}$/i.test(v) && !ids.has(v) && !!ids.add(v)
    const object = (v: unknown, keys: string[]): v is Record<string, any> =>
        !!v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        Object.keys(v).every((k) => keys.includes(k))
    const list = (v: unknown, max: number): v is any[] => Array.isArray(v) && v.length <= max
    const int = (v: unknown, min: number, max: number): v is number =>
        Number.isInteger(v) && (v as number) >= min && (v as number) <= max
    let events = 0
    return value.every(
        (a) =>
            object(a, [
                'id',
                'version',
                'name',
                'tempo',
                'numerator',
                'denominator',
                'key',
                'mode',
                'bars',
                'tracks',
            ]) &&
            id(a.id) &&
            a.version === 1 &&
            typeof a.name === 'string' &&
            a.name.length <= 200 &&
            typeof a.tempo === 'number' &&
            Number.isFinite(a.tempo) &&
            int(a.numerator, 1, 32) &&
            [2, 4, 8, 16].includes(a.denominator) &&
            int(a.key, -7, 7) &&
            (a.mode === undefined || ['major', 'minor'].includes(a.mode)) &&
            list(a.bars, scoreLimits.bars) &&
            a.bars.length > 0 &&
            a.bars.every(id) &&
            list(a.tracks, scoreLimits.tracks) &&
            a.tracks.every(
                (t) =>
                    object(t, ['id', 'name', 'instrument', 'staves']) &&
                    id(t.id) &&
                    typeof t.name === 'string' &&
                    t.name.length <= 200 &&
                    instruments.includes(t.instrument) &&
                    list(t.staves, 2) &&
                    t.staves.length === (t.instrument === 'piano' ? 2 : 1) &&
                    t.staves.every(
                        (s, si) =>
                            object(s, ['id', 'clef', 'measures']) &&
                            id(s.id) &&
                            s.clef ===
                                (t.instrument === 'drums'
                                    ? 'percussion'
                                    : t.instrument === 'bass' || si === 1
                                      ? 'bass'
                                      : 'treble') &&
                            list(s.measures, scoreLimits.bars) &&
                            s.measures.length === a.bars.length &&
                            s.measures.every(
                                (m) =>
                                    object(m, ['id', 'voices']) &&
                                    id(m.id) &&
                                    list(m.voices, 4) &&
                                    m.voices.length > 0 &&
                                    m.voices.every(
                                        (v) =>
                                            object(v, ['id', 'events']) &&
                                            id(v.id) &&
                                            list(v.events, 512) &&
                                            v.events.every(
                                                (e) =>
                                                    ++events <= scoreLimits.events &&
                                                    object(e, [
                                                        'id',
                                                        'duration',
                                                        'dots',
                                                        'triplet',
                                                        'notes',
                                                    ]) &&
                                                    id(e.id) &&
                                                    durations.includes(e.duration) &&
                                                    [0, 1, 2].includes(e.dots) &&
                                                    typeof e.triplet === 'boolean' &&
                                                    list(e.notes, 16) &&
                                                    e.notes.every(
                                                        (n) =>
                                                            object(n, [
                                                                'id',
                                                                'pitch',
                                                                'spelling',
                                                                'tie',
                                                                'string',
                                                                'fret',
                                                            ]) &&
                                                            id(n.id) &&
                                                            int(n.pitch, 0, 127) &&
                                                            ['auto', 'sharp', 'flat'].includes(
                                                                n.spelling,
                                                            ) &&
                                                            typeof n.tie === 'boolean' &&
                                                            (t.instrument === 'guitar' ||
                                                            t.instrument === 'bass'
                                                                ? int(
                                                                      n.string,
                                                                      1,
                                                                      tunings[
                                                                          t.instrument as
                                                                              'guitar' | 'bass'
                                                                      ].length,
                                                                  ) && int(n.fret, 0, 24)
                                                                : n.string === undefined &&
                                                                  n.fret === undefined),
                                                    ),
                                            ),
                                    ),
                            ),
                    ),
            ),
    )
}
export function arrangementErrors(a: Arrangement): string[] {
    if (!scoreStructure([a]))
        return [
            'Score exceeds the supported format or technical limits. Your draft is kept on this device.',
        ]
    const errors: string[] = []
    if (!a.name.trim()) errors.push('Give this arrangement a name.')
    if (a.tempo < 20 || a.tempo > 300) errors.push('Tempo must be between 20 and 300 BPM.')
    if (!a.tracks.length) errors.push('Add at least one track.')
    let sounding = false
    for (const t of a.tracks) {
        if (!t.name.trim()) errors.push('Give every track a name.')
        for (const s of t.staves) {
            const nextEvents = new Map<string, ScoreEvent | undefined>()
            for (let vi = 0; vi < 4; vi++) {
                const sequence: (ScoreEvent | undefined)[] = s.measures.flatMap((m) =>
                    m.voices[vi]?.events.length ? m.voices[vi]!.events : [undefined],
                )
                for (const [index, event] of sequence.entries())
                    if (event) nextEvents.set(event.id, sequence[index + 1])
            }
            for (const [mi, m] of s.measures.entries())
                for (const [vi, v] of m.voices.entries()) {
                    const label = `${t.name}, ${s.clef}, measure ${mi + 1}, voice ${vi + 1}`
                    if (v.events.reduce((sum, e) => sum + eventTicks(e), 0) !== barTicks(a))
                        errors.push(`${label}: fill exactly ${a.numerator}/${a.denominator}.`)
                    let triplets = 0,
                        tripletDuration = 0
                    for (const e of v.events) {
                        if (e.triplet) {
                            if (triplets && (tripletDuration !== e.duration || e.dots))
                                errors.push(`${label}: use three equal, undotted triplet events.`)
                            tripletDuration = e.duration
                            triplets = (triplets + 1) % 3
                            if (e.dots) errors.push(`${label}: triplets cannot be dotted.`)
                        } else if (triplets) {
                            errors.push(`${label}: complete the triplet group.`)
                            triplets = 0
                        }
                        const pitches = new Set<number>(),
                            strings = new Set<number>()
                        for (const n of e.notes) {
                            sounding = true
                            if (pitches.has(n.pitch))
                                errors.push(`${label}: duplicate simultaneous pitch.`)
                            pitches.add(n.pitch)
                            if (t.instrument === 'guitar' || t.instrument === 'bass') {
                                if (strings.has(n.string!))
                                    errors.push(`${label}: only one note per string.`)
                                strings.add(n.string!)
                                if (tunings[t.instrument][n.string! - 1]! + n.fret! !== n.pitch)
                                    errors.push(`${label}: string/fret must match the pitch.`)
                            }
                            if (
                                t.instrument === 'drums' &&
                                (!drumPitches.includes(n.pitch as (typeof drumPitches)[number]) ||
                                    n.tie)
                            )
                                errors.push(`${label}: choose a supported drum without a tie.`)
                            if (n.tie) {
                                const next = nextEvents.get(e.id)
                                if (
                                    !next?.notes.some(
                                        (note) =>
                                            note.pitch === n.pitch && note.string === n.string,
                                    )
                                )
                                    errors.push(
                                        `${label}: tie needs the same note in the next event.`,
                                    )
                            }
                        }
                    }
                    if (triplets) errors.push(`${label}: complete the triplet group.`)
                }
        }
    }
    if (!sounding) errors.push('Add at least one sounding note.')
    return [...new Set(errors)]
}
export function publishableScores(value: Arrangement[] | undefined): boolean {
    return scoreStructure(value) && (value ?? []).every((a) => !arrangementErrors(a).length)
}

export function scoreSignature(value: Arrangement[] | undefined): string {
    // Object property order is not part of the musical content returned by JSON APIs.
    return JSON.stringify(value ?? [], (_key, item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item
        const normalized =
            item.version === 1 && Array.isArray(item.tracks)
                ? { ...item, mode: item.mode ?? 'major' }
                : item
        return Object.fromEntries(
            Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b, 'en')),
        )
    })
}
