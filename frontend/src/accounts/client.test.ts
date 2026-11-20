import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
})

function sessionResponse(id: string, csrfToken: string) {
    return Response.json({ enabled: true, user: { id }, csrfToken })
}

it('never replays an account mutation after another tab changes the signed-in account', async () => {
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(sessionResponse('account-a', 'token-a'))
        .mockResolvedValueOnce(Response.json({ message: 'CSRF expired' }, { status: 419 }))
        .mockResolvedValueOnce(sessionResponse('account-b', 'token-b'))
    vi.stubGlobal('fetch', fetch)
    const client = await import('./client')
    await client.session()
    await expect(client.accountRequest('/api/logout')).rejects.toMatchObject({ status: 401 })
    expect(fetch.mock.calls.filter(([url]) => url === '/api/logout')).toHaveLength(1)
})

it('refreshes an expired CSRF token once when the account has not changed', async () => {
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(sessionResponse('account-a', 'token-a'))
        .mockResolvedValueOnce(Response.json({ message: 'CSRF expired' }, { status: 419 }))
        .mockResolvedValueOnce(sessionResponse('account-a', 'new-token-a'))
        .mockResolvedValueOnce(Response.json({ user: null, csrfToken: 'guest-token' }))
    vi.stubGlobal('fetch', fetch)
    const client = await import('./client')
    await client.session()
    await expect(client.accountRequest('/api/logout')).resolves.toMatchObject({ user: null })
    const last = fetch.mock.calls.at(-1)![1]
    expect(last.headers['X-CSRF-TOKEN']).toBe('new-token-a')
    expect(last.cache).toBe('no-store')
})
