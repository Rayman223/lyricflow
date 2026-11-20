import { cleanMusicLinks, musicServices } from '../domain/musicLinks'
import { newSong, type Song, type SharedContent } from '../domain/song'

export interface Publication {
    id: string
    catalogId: string
    author: string
    authorId: string | null
    revision: number
    updatedAt: string
    average: number | null
    ratingCount: number
    published: boolean
    hidden: boolean
    source: { publicationId: string; revision: number } | null
    content: SharedContent
    localSongId?: string
}
export interface OwnedPublication extends Publication {
    localSongId: string
    autoShareUpdates: boolean
    sharingVersion: number
}
export interface SharingUpdate {
    id: string
    content: SharedContent
    expectedRevision: number
    expectedSharingVersion: number
}
export interface SharingSetting {
    id: string
    enabled: boolean
    expectedSharingVersion: number
}
export interface SharingEntry {
    localSongId: string
    publication: OwnedPublication
    setting?: SharingSetting
    settingInFlight?: SharingSetting
    update?: SharingUpdate
    inFlight?: SharingUpdate
    blocked?: string
}
export function sharingEnabled(entry: SharingEntry): boolean {
    return (
        entry.setting?.enabled ??
        entry.settingInFlight?.enabled ??
        entry.publication.autoShareUpdates
    )
}
export interface Rating {
    id: string
    authorId: string
    author: string
    stars: number
    comment: string | null
    revision: number
    updatedAt: string
}
export interface CatalogSong {
    id: string
    title: string
    artist: string
    best_average?: number | null
    version_count?: number
}
export interface SourceUpdate {
    id: string
    available: boolean
    revision: number | null
}

export function sharedContent(song: Song): SharedContent {
    const links = cleanMusicLinks(song.musicLinks)
    return {
        ...(Object.keys(links).length ? { musicLinks: links } : {}),
        formatVersion: 1,
        title: song.title,
        artist: song.artist,
        lyrics: song.lyrics,
        music: {
            bpm: song.settings.bpm,
            beatsPerBar: song.settings.beatsPerBar,
            barsPerLine: song.settings.barsPerLine,
        },
    }
}
export function sharedSignature(content: SharedContent): string {
    return JSON.stringify([
        content.formatVersion,
        content.title,
        content.artist,
        content.lyrics,
        content.music.bpm,
        content.music.beatsPerBar,
        content.music.barsPerLine,
        ...musicServices.map(({ key }) => content.musicLinks?.[key] || ''),
    ])
}
export function applyPublication(song: Song, publication: Publication): Song {
    const content = publication.content
    return {
        ...song,
        title: content.title,
        artist: content.artist,
        lyrics: content.lyrics,
        musicLinks: structuredClone(content.musicLinks ?? {}),
        formatVersion: 1,
        settings: { ...song.settings, ...content.music },
        updatedAt: new Date().toISOString(),
        source: {
            publicationId: publication.id,
            revision: publication.revision,
            base: structuredClone(content),
        },
    }
}
export function copyPublication(publication: Publication) {
    return applyPublication(newSong(), publication)
}

export interface ModerationTarget {
    type: 'publication' | 'rating' | 'user'
    id: string
    label: string
}
