import { AccountError } from '../accounts/client'
import { t } from '../i18n/en'
import type { SharedContent } from '../domain/song'

export interface PublicPrompter {
    id: string
    revision: number
    author: string
    content: SharedContent
}

export function publicationLink(id: string): string {
    return `${location.origin}/#song=${encodeURIComponent(id)}`
}

export async function loadPublicPrompter(id: string): Promise<PublicPrompter> {
    const response = await fetch(`/api/publications/${encodeURIComponent(id)}/prompter`, {
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'X-LyricFlow-Capabilities': 'line-timing' },
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined,
    })
    if (!response.ok)
        throw new AccountError(
            t(
                response.status === 404
                    ? 'sharedSongUnavailable'
                    : response.status === 409
                      ? 'sharedSongUpdateRequired'
                      : 'accountNetworkError',
            ),
            response.status,
        )
    const data = (await response.json()) as { publication: PublicPrompter }
    return data.publication
}
