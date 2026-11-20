export const musicServices = [
    { key: 'youtube', name: 'YouTube', example: 'https://www.youtube.com/watch?v=…' },
    { key: 'youtubeMusic', name: 'YouTube Music', example: 'https://music.youtube.com/watch?v=…' },
    { key: 'deezer', name: 'Deezer', example: 'https://www.deezer.com/track/…' },
    { key: 'spotify', name: 'Spotify', example: 'https://open.spotify.com/track/…' },
] as const

export type MusicService = (typeof musicServices)[number]['key']
export type MusicLinks = Partial<Record<MusicService, string>>

export function validMusicLink(service: MusicService, value: string): boolean {
    if (
        value.length > 2048 ||
        /[\s\\]/u.test(value) ||
        !/^https:\/\/[a-z0-9.-]+(?::443)?\//i.test(value)
    )
        return false
    try {
        const url = new URL(value)
        if (url.username || url.password || url.port) return false
        const host = url.hostname
        const path = url.pathname
        if (path !== value.replace(/^https:\/\/[^/]+/i, '').split(/[?#]/, 1)[0]) return false
        const video = /^[\w-]{11}$/.test(url.searchParams.get('v') ?? '')
        switch (service) {
            case 'youtube':
                return (
                    (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host) &&
                        ((path === '/watch' && video) ||
                            /^\/(shorts|live|embed)\/[\w-]{11}\/?$/.test(path))) ||
                    (host === 'youtu.be' && /^\/[\w-]{11}\/?$/.test(path))
                )
            case 'youtubeMusic':
                return host === 'music.youtube.com' && path === '/watch' && video
            case 'deezer':
                return (
                    (['deezer.com', 'www.deezer.com'].includes(host) &&
                        /^\/(?:[a-z]{2}\/)?track\/[1-9]\d*\/?$/.test(path)) ||
                    (host === 'deezer.page.link' && /^\/[a-zA-Z0-9]+\/?$/.test(path)) ||
                    (host === 'link.deezer.com' && /^\/s\/[a-zA-Z0-9]+\/?$/.test(path))
                )
            case 'spotify':
                return (
                    (host === 'open.spotify.com' &&
                        /^\/(?:intl-[a-z]{2}\/)?track\/[a-zA-Z0-9]{22}\/?$/.test(path)) ||
                    (host === 'spotify.link' && /^\/[a-zA-Z0-9]+\/?$/.test(path))
                )
        }
    } catch {
        return false
    }
}

export function validMusicLinks(links?: MusicLinks): boolean {
    return (
        !links ||
        Object.entries(links).every(
            ([key, value]) =>
                musicServices.some((service) => service.key === key) &&
                typeof value === 'string' &&
                (value.trim() === '' || validMusicLink(key as MusicService, value.trim())),
        )
    )
}

export function cleanMusicLinks(links?: MusicLinks): MusicLinks {
    return Object.fromEntries(
        musicServices.flatMap(({ key }) => {
            const value = links?.[key]?.trim()
            return value ? [[key, value]] : []
        }),
    )
}
