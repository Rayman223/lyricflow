import { t } from '../i18n/en'

export interface Account {
    id: string
    pseudonym: string
    email: string
    verified: boolean
    hasPassword: boolean
    googleLinked: boolean
    role: 'member' | 'moderator' | 'admin'
    supporter?: boolean
}

export interface AccountSession {
    enabled: boolean
    googleEnabled: boolean
    emailEnabled: boolean
    googlePending: boolean
    user: Account | null
    csrfToken: string
}

export class AccountError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message)
    }
}

let csrfToken = ''
let currentAccountId: string | null = null

export async function accountGet<T>(path: string): Promise<T> {
    const response = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined,
    })
    if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new AccountError(data.message ?? t('accountNetworkError'), response.status)
    }
    return response.json() as Promise<T>
}

export async function session(): Promise<AccountSession> {
    let response = await fetch('/api/session', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
    })
    if (response.status === 401) {
        // A revoked session is cleared by the server; recover the new guest session.
        response = await fetch('/api/session', {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
        })
    }
    if (!response.ok) throw new AccountError(t('accountNetworkError'), response.status)
    const data = (await response.json()) as AccountSession
    csrfToken = data.csrfToken
    currentAccountId = data.user?.id ?? null
    return data
}

export async function accountRequest<
    T = { user: Account | null; message?: string; redirect?: string },
>(path: string, body: Record<string, unknown> = {}, retry = true): Promise<T> {
    if (!csrfToken) await session()
    const expectedAccount = currentAccountId
    const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal:
            (path === '/api/sync' || path.startsWith('/api/community/')) &&
            typeof AbortSignal.timeout === 'function'
                ? AbortSignal.timeout(15000)
                : undefined,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-CSRF-TOKEN': csrfToken,
        },
        body: JSON.stringify(body),
    })
    if (response.status === 419 && retry) {
        await session()
        if (currentAccountId !== expectedAccount)
            throw new AccountError(t('accountChangedError'), 401)
        return accountRequest(path, body, false)
    }
    const data = await response.json()
    if (data.csrfToken) csrfToken = data.csrfToken
    if (response.ok && 'user' in data) currentAccountId = data.user?.id ?? null
    if (!response.ok) {
        const first = Object.values(data.errors ?? {}).flat()[0]
        throw new AccountError(
            typeof first === 'string' ? first : (data.message ?? t('retry')),
            response.status,
        )
    }
    return data as T
}
