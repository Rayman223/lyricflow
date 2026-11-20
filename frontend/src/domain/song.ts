import type { Arrangement } from './score'
import type { MusicLinks } from './musicLinks'

export interface SongSettings {
    bpm: number
    beatsPerBar: number
    barsPerLine: number
    speedMode: 'bpm' | 'pixels'
    presentation: 'line' | 'continuous'
    pixelsPerSecond: number
    countIn: number
    sound: boolean
    fontSize: number
}

export type ReaderSettings = Partial<Pick<SongSettings, 'bpm' | 'pixelsPerSecond' | 'fontSize'>>

export interface Song {
    id: string
    formatVersion: 1
    title: string
    artist: string
    lyrics: string
    arrangements?: Arrangement[]
    musicLinks?: MusicLinks
    settings: SongSettings
    updatedAt: string
    source?: SongSource
}

export interface SharedContent {
    formatVersion: 1
    title: string
    artist: string
    lyrics: string
    arrangements?: Arrangement[]
    musicLinks?: MusicLinks
    music: Pick<SongSettings, 'bpm' | 'beatsPerBar' | 'barsPerLine'>
}
export interface SongSource {
    publicationId: string
    revision: number
    base: SharedContent
}

export const defaults: SongSettings = {
    bpm: 120,
    beatsPerBar: 4,
    barsPerLine: 1,
    speedMode: 'bpm',
    presentation: 'line',
    pixelsPerSecond: 35,
    countIn: 4,
    sound: false,
    fontSize: 32,
}

export function newSong(): Song {
    return {
        id: crypto.randomUUID(),
        formatVersion: 1,
        title: '',
        artist: '',
        lyrics: '',
        settings: { ...defaults },
        updatedAt: new Date().toISOString(),
    }
}

export function validSettings(s: SongSettings): boolean {
    return (
        Number.isFinite(s.bpm) &&
        s.bpm >= 1 &&
        s.bpm <= 1000 &&
        Number.isInteger(s.beatsPerBar) &&
        s.beatsPerBar >= 1 &&
        s.beatsPerBar <= 32 &&
        Number.isFinite(s.barsPerLine) &&
        s.barsPerLine >= 0.01 &&
        s.barsPerLine <= 1000 &&
        ['bpm', 'pixels'].includes(s.speedMode) &&
        ['line', 'continuous'].includes(s.presentation) &&
        Number.isFinite(s.pixelsPerSecond) &&
        s.pixelsPerSecond >= 1 &&
        s.pixelsPerSecond <= 1000 &&
        Number.isInteger(s.countIn) &&
        s.countIn >= 0 &&
        s.countIn <= 32 &&
        Number.isFinite(s.fontSize) &&
        s.fontSize >= 18 &&
        s.fontSize <= 80 &&
        typeof s.sound === 'boolean'
    )
}
