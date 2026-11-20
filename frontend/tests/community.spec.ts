import { expect, test, type Page, type Browser } from '@playwright/test'

async function register(page: Page, prefix: string) {
    const name = `${prefix}_${crypto.randomUUID().slice(0, 8)}`
    await page.goto('/')
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByRole('button', { name: 'Create a free account', exact: true }).click()
    await page.getByLabel('Public pseudonym', { exact: true }).fill(name)
    await page.getByLabel('Email address', { exact: true }).fill(`${name}@example.test`)
    await page.getByLabel('Password', { exact: true }).fill('A private password 123')
    await page.getByLabel('Confirm password', { exact: true }).fill('A private password 123')
    await page.getByRole('button', { name: 'Create a free account', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
    return name
}
async function another(browser: Browser, prefix: string) {
    const context = await browser.newContext({
        baseURL: 'http://127.0.0.1:4173',
        viewport: { width: 393, height: 851 },
    })
    const page = await context.newPage(),
        name = await register(page, prefix)
    return { context, page, name }
}
async function create(page: Page, title: string) {
    await page.getByRole('button', { name: '+ New song', exact: true }).click()
    await page.getByLabel('Title', { exact: true }).fill(title)
    await page.getByLabel('Artist', { exact: true }).fill('Community test band')
    await page.getByLabel('Lyrics', { exact: true }).fill('Original shared lyrics')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
}
async function share(page: Page, revision: number) {
    await page.getByRole('button', { name: 'Share song', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Public preview', exact: true })).toBeVisible()
    await page
        .getByLabel(
            'I understand how sharing and private copies work, and confirm that I can share this content.',
            { exact: true },
        )
        .check()
    await page
        .getByRole('button', {
            name: revision === 1 ? 'Publish this version' : 'Publish saved changes',
            exact: true,
        })
        .click()
    await expect(
        page.getByText(`Publication saved · V.${revision}.`, { exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
}
async function find(page: Page, title: string, author: string) {
    await page.getByRole('button', { name: 'Community', exact: true }).click()
    await page.getByLabel('Search by title or artist', { exact: true }).fill(title)
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('button', { name: `${title} · Community test band`, exact: true }).click()
    await page.getByRole('button', { name: new RegExp(`^${author} · V\\.`) }).click()
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}
async function edit(page: Page, lyrics: string) {
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await page.getByLabel('Lyrics', { exact: true }).fill(lyrics)
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
}
async function switchSession(page: Page, name: string) {
    const session = await (await page.request.get('/api/session')).json()
    if (session.user)
        expect(
            (
                await page.request.post('/api/logout', {
                    headers: { 'X-CSRF-TOKEN': session.csrfToken },
                })
            ).ok(),
        ).toBe(true)
    const guest = await (await page.request.get('/api/session')).json()
    expect(
        (
            await page.request.post('/api/login', {
                headers: { 'X-CSRF-TOKEN': guest.csrfToken },
                data: { email: `${name}@example.test`, password: 'A private password 123' },
            })
        ).ok(),
    ).toBe(true)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
}
async function delayResponse(page: Page, path: string) {
    // Delay consumption after the native response applied its cookies, as with a slow body.
    await page.evaluate((path) => {
        const original = window.fetch
        let delayed = false
        window.fetch = async (...args) => {
            const response = await original(...args),
                input = args[0],
                url = input instanceof Request ? input.url : String(input)
            if (!delayed && new URL(url, location.href).pathname === path) {
                delayed = true
                ;(window as any).delayedResponseReady = true
                await new Promise<void>(
                    (resolve) => ((window as any).releaseDelayedResponse = resolve),
                )
            }
            return response
        }
    }, path)
    return {
        wait: () =>
            expect.poll(() => page.evaluate(() => (window as any).delayedResponseReady)).toBe(true),
        release: () => page.evaluate(() => (window as any).releaseDelayedResponse?.()),
    }
}

test('closes a private sharing preview when another account becomes active', async ({
    page,
    browser,
}) => {
    await register(page, 'previewowner')
    await create(page, 'Private preview from the original account')
    // Complete the scheduled sync before replacing its session from another tab.
    const synced = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/sync' && response.ok(),
    )
    await page.getByRole('button', { name: 'Share song', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Public preview', exact: true })).toBeVisible()
    await synced
    const other = await another(browser, 'replacement')
    try {
        // Switch the shared session as a second tab would, without remounting this page.
        await switchSession(page, other.name)
        await expect(
            page.getByRole('heading', { name: 'Public preview', exact: true }),
        ).toHaveCount(0)
        await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: other.name, exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Share song', exact: true })).toHaveCount(0)
        await expect
            .poll(
                async () =>
                    (await (await page.request.get('/api/community/mine')).json()).publications
                        .length,
            )
            .toBe(0)
    } finally {
        await other.context.close()
    }
})

for (const pending of [false, true]) {
    test(`resets account deletion after a session change with ${pending ? 'pending' : 'loaded'} publications`, async ({
        page,
        browser,
    }) => {
        await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') })
        await page.clock.pauseAt(new Date('2026-10-20T12:00:00Z'))
        const owner = await register(page, 'deleteform'),
            title = `Old account ${crypto.randomUUID().slice(0, 8)}`
        await create(page, title)
        await share(page, 1)
        // Start the scheduled sync only after listening for its final publications response.
        // Keep timers paused afterwards so a guest sync cannot overwrite the new login.
        const synchronized = page.waitForResponse((response) => {
            const url = new URL(response.url())
            return (
                url.pathname === '/api/community/mine' &&
                url.searchParams.get('sort') === 'id' &&
                response.ok()
            )
        })
        await page.clock.runFor(700)
        await (await synchronized).finished()
        const other = await another(browser, 'deleteother'),
            otherTitle = `New account ${crypto.randomUUID().slice(0, 8)}`
        let delayed: Awaited<ReturnType<typeof delayResponse>> | undefined
        try {
            await create(other.page, otherTitle)
            await share(other.page, 1)
            await page.getByRole('button', { name: owner, exact: true }).click()
            if (pending) delayed = await delayResponse(page, '/api/community/mine')
            await page.getByRole('button', { name: 'Delete account', exact: true }).click()
            if (delayed) await delayed.wait()
            else {
                await page.getByLabel(`${title} · V.1`, { exact: true }).check()
                await page
                    .getByLabel('Type your public pseudonym to confirm', { exact: true })
                    .fill(owner)
                await page
                    .getByLabel('Current password', { exact: true })
                    .fill('A private password 123')
            }
            await switchSession(page, other.name)
            await expect(page.getByRole('heading', { name: other.name, exact: true })).toBeVisible()
            await delayed?.release()
            await expect(
                page.getByRole('button', { name: 'Delete account', exact: true }),
            ).toBeEnabled()
            await expect(
                page.getByLabel('Type your public pseudonym to confirm', { exact: true }),
            ).toHaveCount(0)
            await expect(page.getByLabel(`${title} · V.1`, { exact: true })).toHaveCount(0)
            await page.getByRole('button', { name: 'Delete account', exact: true }).click()
            await expect(page.getByLabel(`${otherTitle} · V.1`, { exact: true })).not.toBeChecked()
            await expect(
                page.getByLabel('Type your public pseudonym to confirm', { exact: true }),
            ).toHaveValue('')
            await expect(page.getByLabel('Current password', { exact: true })).toHaveValue('')
            expect((await (await page.request.get('/api/session')).json()).user.pseudonym).toBe(
                other.name,
            )
        } finally {
            await delayed?.release()
            await other.context.close()
        }
    })
}

test('finishes a late account deletion with its original local erase choice and keeps a newer session', async ({
    page,
    browser,
}) => {
    await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') })
    const owner = await register(page, 'lateerase')
    await create(page, 'Private song selected for local erasure')
    const ownerId = (await (await page.request.get('/api/session')).json()).user.id as string
    const other = await another(browser, 'latelogin')
    let delayed: Awaited<ReturnType<typeof delayResponse>> | undefined
    try {
        // Finish the account screen's scheduled sync before the server removes that account.
        const synced = page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/api/sync' && response.ok(),
        )
        await page.getByRole('button', { name: owner, exact: true }).click()
        await synced
        // Freeze subsequent background sync timers: a revoked-session response must not
        // overwrite the cookies of the replacement login while this test delays deletion.
        await page.clock.pauseAt(new Date('2026-10-20T12:01:00Z'))
        await page.getByRole('button', { name: 'Delete account', exact: true }).click()
        await page.getByLabel('Type your public pseudonym to confirm', { exact: true }).fill(owner)
        await page.getByLabel('Current password', { exact: true }).fill('A private password 123')
        await page.getByLabel('Keep songs and drafts on this device', { exact: true }).uncheck()
        delayed = await delayResponse(page, '/api/account/delete')
        await page
            .getByRole('button', { name: 'Permanently delete my account', exact: true })
            .click()
        await delayed.wait()
        await switchSession(page, other.name)
        await expect(page.getByRole('heading', { name: other.name, exact: true })).toBeVisible()
        const reconciled = page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/api/session' && response.ok(),
        )
        await delayed.release()
        await reconciled
        await expect(
            page.getByRole('button', { name: 'Delete account', exact: true }),
        ).toBeEnabled()
        await expect(page.getByRole('heading', { name: other.name, exact: true })).toBeVisible()
        await expect
            .poll(() =>
                page.evaluate(async (id) => {
                    const db = await new Promise<IDBDatabase>((resolve, reject) => {
                        const request = indexedDB.open(`lyricflow.profile.${id}`)
                        request.onsuccess = () => resolve(request.result)
                        request.onerror = () => reject(request.error)
                    })
                    try {
                        return await new Promise<number>((resolve, reject) => {
                            const request = db.transaction('songs').objectStore('songs').count()
                            request.onsuccess = () => resolve(request.result)
                            request.onerror = () => reject(request.error)
                        })
                    } finally {
                        db.close()
                    }
                }, ownerId),
            )
            .toBe(0)
        expect((await (await page.request.get('/api/session')).json()).user.pseudonym).toBe(
            other.name,
        )
        await page.getByRole('button', { name: 'Sign out', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible()
    } finally {
        await delayed?.release()
        await other.context.close()
    }
})

test('publishes only after consent, accepts a zero-star review, reports and downloads a private copy', async ({
    page,
    browser,
}) => {
    const owner = await register(page, 'publisher'),
        title = `Shared ${crypto.randomUUID().slice(0, 8)}`
    await create(page, title)
    await page.getByRole('button', { name: 'Share song', exact: true }).click()
    await expect(
        page.getByRole('button', { name: 'Publish this version', exact: true }),
    ).toBeDisabled()
    await expect(page.getByText('Original shared lyrics', { exact: true })).toBeVisible()
    await page
        .getByLabel(
            'I understand how sharing and private copies work, and confirm that I can share this content.',
            { exact: true },
        )
        .check()
    await page.getByRole('button', { name: 'Publish this version', exact: true }).click()
    await expect(page.getByText('Publication saved · V.1.', { exact: true })).toBeVisible()
    const reader = await another(browser, 'reader')
    try {
        await find(reader.page, title, owner)
        await expect(reader.page.getByText('No ratings yet', { exact: true }).first()).toBeVisible()
        await reader.page.getByLabel('Stars (0–5)', { exact: true }).selectOption('0')
        const comment = '<img src=x onerror="window.injected=true">'
        await reader.page.getByLabel('Comment (optional)', { exact: true }).fill(comment)
        await reader.page.getByRole('button', { name: 'Save review', exact: true }).click()
        await expect(reader.page.locator('.user-comment')).toHaveText(comment)
        expect(await reader.page.evaluate(() => (window as any).injected)).toBeUndefined()
        await expect(reader.page.getByText('0.0 / 5 · 1 reviews', { exact: true })).toBeVisible()
        await reader.page.getByRole('button', { name: 'Request removal', exact: true }).click()
        await reader.page
            .getByLabel('Details (optional)', { exact: true })
            .fill('A test takedown request')
        await reader.page.getByRole('button', { name: 'Submit report', exact: true }).click()
        await expect(
            reader.page.getByText('Report received. A moderator will review it.', { exact: true }),
        ).toBeVisible()
        await reader.page.getByRole('button', { name: 'Save a private copy', exact: true }).click()
        await expect(reader.page.locator('.song-card')).toHaveCount(1)
        await expect(
            reader.page.getByRole('button', { name: 'Source V.1', exact: true }),
        ).toBeVisible()
        const cached = await reader.page.evaluate(async () =>
            (
                await Promise.all(
                    (await caches.keys()).map(async (key) =>
                        (await (await caches.open(key)).keys()).map((request) => request.url),
                    ),
                )
            ).flat(),
        )
        expect(cached.some((url) => /\/(api|auth)\//.test(new URL(url).pathname))).toBe(false)
    } finally {
        await reader.context.close()
    }
})

test('updates an unchanged copy and keeps customized lyrics when a newer public revision arrives', async ({
    page,
    browser,
}) => {
    const owner = await register(page, 'versions'),
        title = `Versions ${crypto.randomUUID().slice(0, 8)}`
    await create(page, title)
    await share(page, 1)
    const reader = await another(browser, 'copy')
    try {
        await find(reader.page, title, owner)
        await reader.page.getByRole('button', { name: 'Save a private copy', exact: true }).click()
        await edit(page, 'Public revision two')
        await share(page, 2)
        await reader.page.getByRole('button', { name: 'Check for updates', exact: true }).click()
        await expect(reader.page.getByText('Update available — V.2', { exact: true })).toBeVisible()
        await reader.page.getByRole('button', { name: 'Update from source', exact: true }).click()
        await expect(
            reader.page.getByRole('button', { name: 'Source V.2', exact: true }),
        ).toBeVisible()
        await edit(reader.page, 'Personal adapted lyrics')
        await edit(page, 'Public revision three')
        await share(page, 3)
        await reader.page.getByRole('button', { name: 'Check for updates', exact: true }).click()
        await expect(reader.page.getByText('Update available — V.3', { exact: true })).toBeVisible()
        await reader.page.getByRole('button', { name: 'Update from source', exact: true }).click()
        await expect(
            reader.page.getByText(
                'This copy has been customized. Keep it or download the new revision as another private copy.',
                { exact: true },
            ),
        ).toBeVisible()
        await reader.page.getByRole('button', { name: 'Download new copy', exact: true }).click()
        await expect(reader.page.locator('.song-card')).toHaveCount(2)
        await reader.page.getByRole('button', { name: 'Edit', exact: true }).last().click()
        await expect(reader.page.getByLabel('Lyrics', { exact: true })).toHaveValue(
            'Personal adapted lyrics',
        )
        await reader.page.getByRole('button', { name: 'Back to library', exact: true }).click()
        await reader.page.getByRole('button', { name: 'Share song', exact: true }).last().click()
        await expect(reader.page.getByText(/Adapted from/)).toBeVisible()
        await reader.page
            .getByLabel(
                'I understand how sharing and private copies work, and confirm that I can share this content.',
                { exact: true },
            )
            .check()
        await reader.page.getByRole('button', { name: 'Publish this version', exact: true }).click()
        await expect(
            reader.page.getByText('Publication saved · V.1.', { exact: true }),
        ).toBeVisible()
    } finally {
        await reader.context.close()
    }
})

for (const pending of ['source', 'session'] as const) {
    test(`cancels a ${pending} response after a profile change without changing a private copy`, async ({
        page,
        browser,
    }) => {
        const owner = await register(page, 'lateowner'),
            title = `Delayed ${crypto.randomUUID().slice(0, 8)}`
        await create(page, title)
        await share(page, 1)
        const reader = await another(browser, 'latecopy')
        try {
            await find(reader.page, title, owner)
            await reader.page
                .getByRole('button', { name: 'Save a private copy', exact: true })
                .click()
            await edit(page, 'New public lyrics from revision two')
            await share(page, 2)
            await reader.page
                .getByRole('button', { name: 'Check for updates', exact: true })
                .click()
            await expect(
                reader.page.getByText('Update available — V.2', { exact: true }),
            ).toBeVisible()
            let release!: () => void, started!: () => void
            const held = new Promise<void>((resolve) => (release = resolve)),
                requested = new Promise<void>((resolve) => (started = resolve))
            await reader.page.route(
                pending === 'source' ? '**/api/community/publications/*' : '**/api/session',
                async (route) => {
                    const response = await route.fetch()
                    started()
                    await held
                    await route.fulfill({ response })
                },
                { times: 1 },
            )
            await reader.page
                .getByRole('button', {
                    name: pending === 'source' ? 'Download new copy' : 'Update from source',
                    exact: true,
                })
                .click()
            await requested
            await reader.page.getByLabel('Library on this device').selectOption('guest')
            await expect(reader.page.locator('.song-card')).toHaveCount(0)
            release()
            await expect(reader.page.getByRole('alert')).toContainText(
                'The account or local profile changed.',
            )
            await expect(reader.page.getByLabel('Library on this device')).toHaveValue('guest')
            await reader.page
                .getByLabel('Library on this device')
                .selectOption({ label: reader.name })
            await expect(reader.page.locator('.song-card')).toHaveCount(1)
            await expect(
                reader.page.getByRole('button', { name: 'Source V.1', exact: true }),
            ).toBeVisible()
            await reader.page.getByRole('button', { name: 'Edit', exact: true }).click()
            await expect(reader.page.getByLabel('Lyrics', { exact: true })).toHaveValue(
                'Original shared lyrics',
            )
        } finally {
            await reader.context.close()
        }
    })
}

test('withdrawing a publication keeps downloaded copies readable offline', async ({
    page,
    browser,
}) => {
    const owner = await register(page, 'withdraw'),
        title = `Withdraw ${crypto.randomUUID().slice(0, 8)}`
    await create(page, title)
    await share(page, 1)
    const reader = await another(browser, 'offlinecopy')
    try {
        await find(reader.page, title, owner)
        await reader.page.getByRole('button', { name: 'Save a private copy', exact: true }).click()
        await page.getByRole('button', { name: 'Share song', exact: true }).click()
        page.once('dialog', (dialog) => dialog.accept())
        await page.getByRole('button', { name: 'Withdraw publication', exact: true }).click()
        await expect(
            page.getByText('Publication withdrawn. Private copies are kept.', { exact: true }),
        ).toBeVisible()
        await reader.page.getByRole('button', { name: 'Check for updates', exact: true }).click()
        await expect(
            reader.page.getByText('Source unavailable. Your private copy is kept.', {
                exact: true,
            }),
        ).toBeVisible()
        await reader.page.evaluate(async () => {
            await navigator.serviceWorker.ready
        })
        await reader.page.reload()
        await expect
            .poll(() => reader.page.evaluate(() => !!navigator.serviceWorker.controller))
            .toBe(true)
        await reader.context.setOffline(true)
        await reader.page.reload()
        await reader.page.locator('.song-open').click()
        await expect(
            reader.page.getByRole('button', { name: 'Original shared lyrics', exact: true }),
        ).toBeVisible()
    } finally {
        await reader.context.close()
    }
})

test('staff can process a takedown, restore content and manage roles without private songs in tools', async ({
    page,
    browser,
}) => {
    const owner = await register(page, 'reported'),
        title = `Reported ${crypto.randomUUID().slice(0, 8)}`
    await create(page, title)
    await share(page, 1)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Automatically share saved changes', { exact: true }).uncheck()
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await edit(page, 'PRIVATE UNSHARED DRAFT TEXT')
    const reader = await another(browser, 'reporter')
    const staffContext = await browser.newContext({
        baseURL: 'http://127.0.0.1:4173',
        viewport: { width: 393, height: 851 },
    })
    const staff = await staffContext.newPage()
    try {
        await find(reader.page, title, owner)
        await reader.page.getByRole('button', { name: 'Request removal', exact: true }).click()
        await reader.page.getByLabel('Details (optional)', { exact: true }).fill(title)
        await reader.page.getByRole('button', { name: 'Submit report', exact: true }).click()
        await staff.goto('/')
        await staff.getByRole('button', { name: 'Account', exact: true }).click()
        await staff.getByLabel('Email address', { exact: true }).fill('browser_admin@example.test')
        await staff.getByLabel('Password', { exact: true }).fill('Browser test password 123')
        await staff.getByRole('button', { name: 'Sign in', exact: true }).click()
        await staff.getByRole('button', { name: 'Moderation', exact: true }).click()
        await expect(staff.getByText('PRIVATE UNSHARED DRAFT TEXT', { exact: true })).toHaveCount(0)
        const report = staff.locator('.community-card').filter({ hasText: title })
        await report.getByRole('button', { name: 'Moderate this target', exact: true }).click()
        await staff.getByLabel('Reason', { exact: true }).fill('Test takedown reviewed')
        await staff.getByRole('button', { name: 'Apply moderation action', exact: true }).click()
        await expect(staff.getByText('Change saved.', { exact: true })).toBeVisible()
        await staff.getByLabel('Action', { exact: true }).selectOption('restore')
        await staff.getByRole('button', { name: 'Apply moderation action', exact: true }).click()
        await staff.getByRole('button', { name: 'Reports', exact: true }).click()
        const reviewed = staff.locator('.community-card').filter({ hasText: title })
        await reviewed.getByLabel('Report status', { exact: true }).selectOption('closed')
        await reviewed
            .getByLabel('Decision or review note', { exact: true })
            .fill('Test review completed')
        await reviewed.getByRole('button', { name: 'Save report decision', exact: true }).click()
        await staff.getByRole('button', { name: 'Users', exact: true }).click()
        await staff
            .getByLabel('Search users by pseudonym or email', { exact: true })
            .fill(reader.name)
        await staff.getByRole('button', { name: 'Search', exact: true }).click()
        await staff.getByLabel('Reason', { exact: true }).fill('Test moderator assignment')
        await staff.getByLabel('Role', { exact: true }).selectOption('moderator')
        await staff.getByRole('button', { name: 'Save role', exact: true }).click()
        await reader.page.getByRole('button', { name: 'Back to library', exact: true }).click()
        await reader.page.reload()
        await expect(
            reader.page.getByRole('button', { name: 'Moderation', exact: true }),
        ).toBeVisible()
        for (const width of [360, 844, 1024]) {
            await staff.setViewportSize({ width, height: 800 })
            expect(
                await staff.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true)
        }
    } finally {
        await reader.context.close()
        await staffContext.close()
    }
})

test('account deletion keeps selected public work anonymously with its received reviews', async ({
    page,
    browser,
}) => {
    const owner = await register(page, 'anonymous'),
        title = `Anonymous ${crypto.randomUUID().slice(0, 8)}`
    await create(page, title)
    await share(page, 1)
    const reader = await another(browser, 'reviewer')
    try {
        await find(reader.page, title, owner)
        await reader.page.getByLabel('Stars (0–5)', { exact: true }).selectOption('4')
        await reader.page.getByRole('button', { name: 'Save review', exact: true }).click()
        await page.getByRole('button', { name: owner, exact: true }).click()
        await page.getByRole('button', { name: 'Delete account', exact: true }).click()
        await page.getByLabel(`${title} · V.1`, { exact: true }).check()
        await page.getByLabel('Type your public pseudonym to confirm', { exact: true }).fill(owner)
        await page.getByLabel('Current password', { exact: true }).fill('A private password 123')
        await page
            .getByRole('button', { name: 'Permanently delete my account', exact: true })
            .click()
        await expect(page.getByText('Account deleted.', { exact: false })).toBeVisible()
        await reader.page.getByRole('button', { name: 'Song catalog', exact: true }).click()
        await reader.page.getByLabel('Search by title or artist', { exact: true }).fill(title)
        await reader.page.getByRole('button', { name: 'Search', exact: true }).click()
        await reader.page
            .getByRole('button', { name: `${title} · Community test band`, exact: true })
            .click()
        await reader.page.getByRole('button', { name: 'Anonymous · V.1', exact: true }).click()
        await expect(reader.page.getByText('4.0 / 5 · 1 reviews', { exact: true })).toBeVisible()
    } finally {
        await reader.context.close()
    }
})

async function ownPublication(page: Page) {
    return (await (await page.request.get('/api/community/mine')).json()).publications[0]
}
async function waitForPublicLyrics(page: Page, lyrics: string, revision: number) {
    await expect
        .poll(async () => {
            const publication = await ownPublication(page)
            return { lyrics: publication?.content.lyrics, revision: publication?.revision }
        })
        .toEqual({ lyrics, revision })
}
async function loginOwner(browser: Browser, name: string) {
    const context = await browser.newContext({
        baseURL: 'http://127.0.0.1:4173',
        viewport: { width: 393, height: 851 },
    })
    const page = await context.newPage()
    await page.goto('/')
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByLabel('Email address', { exact: true }).fill(`${name}@example.test`)
    await page.getByLabel('Password', { exact: true }).fill('A private password 123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.locator('.song-card')).toHaveCount(1)
    await expect(page.locator('.sharing-badge')).toHaveText('Shared')
    return { context, page }
}

test('shows shared badges, keeps autosaved drafts private and publishes Save and Read changes', async ({
    page,
}) => {
    await register(page, 'autoshare')
    await create(page, `Auto share ${crypto.randomUUID().slice(0, 8)}`)
    await expect(page.locator('.sharing-badge')).toHaveCount(0)
    await share(page, 1)
    await expect(page.locator('.sharing-badge')).toHaveText('Shared')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.locator('.sharing-badge')).toHaveText('Shared')
    await expect(
        page.getByLabel('Automatically share saved changes', { exact: true }),
    ).toBeChecked()
    await page.getByLabel('Lyrics', { exact: true }).fill('Unfinished private draft')
    await expect(page.getByText('Draft saved on device', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await page.getByRole('button', { name: 'Sync now', exact: true }).click()
    await waitForPublicLyrics(page, 'Original shared lyrics', 1)
    await edit(page, 'Automatically shared saved lyrics')
    await waitForPublicLyrics(page, 'Automatically shared saved lyrics', 2)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('Saved through Read')
    await page.getByRole('button', { name: 'Open prompter', exact: true }).click()
    await waitForPublicLyrics(page, 'Saved through Read', 3)
})

test('syncs the per-song preference to another device and never publishes while unchecked', async ({
    page,
    browser,
}) => {
    const owner = await register(page, 'settingowner')
    await create(page, `Preference ${crypto.randomUUID().slice(0, 8)}`)
    await share(page, 1)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Automatically share saved changes', { exact: true }).uncheck()
    await expect.poll(async () => (await ownPublication(page)).autoShareUpdates).toBe(false)
    await page.getByLabel('Lyrics', { exact: true }).fill('Saved but private')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await page.getByRole('button', { name: 'Sync now', exact: true }).click()
    const second = await loginOwner(browser, owner)
    try {
        await second.page.getByRole('button', { name: 'Edit', exact: true }).click()
        await expect(
            second.page.getByLabel('Automatically share saved changes', { exact: true }),
        ).not.toBeChecked()
        await expect(second.page.getByLabel('Lyrics', { exact: true })).toHaveValue(
            'Saved but private',
        )
        await waitForPublicLyrics(page, 'Original shared lyrics', 1)
        await second.page.getByLabel('Automatically share saved changes', { exact: true }).check()
        await expect
            .poll(async () => (await ownPublication(second.page)).autoShareUpdates)
            .toBe(true)
        await waitForPublicLyrics(page, 'Original shared lyrics', 1)
        await second.page.getByLabel('Lyrics', { exact: true }).fill('Explicit save after enabling')
        await second.page.getByRole('button', { name: 'Save song', exact: true }).click()
        await waitForPublicLyrics(page, 'Explicit save after enabling', 2)
    } finally {
        await second.context.close()
    }
})

test('retains an offline public update across reload and sends it on reconnection', async ({
    page,
    context,
}) => {
    await register(page, 'offlineupdate')
    await create(page, `Offline update ${crypto.randomUUID().slice(0, 8)}`)
    await share(page, 1)
    await expect(page.locator('.sharing-badge')).toHaveText('Shared')
    await context.setOffline(true)
    await edit(page, 'Saved offline for publication')
    await expect(page.getByText('Sharing changes pending', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.locator('.sharing-badge')).toHaveText('Shared')
    await expect(page.getByText('Sharing changes pending', { exact: true })).toBeVisible()
    await context.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await waitForPublicLyrics(page, 'Saved offline for publication', 2)
    await expect(page.getByText('Sharing changes pending', { exact: true })).toHaveCount(0)
})

test('blocks an offline update after a concurrent public change and keeps the private save', async ({
    page,
    context,
}) => {
    await register(page, 'conflictupdate')
    await create(page, `Conflict update ${crypto.randomUUID().slice(0, 8)}`)
    await share(page, 1)
    await expect(page.locator('.sharing-badge')).toHaveText('Shared')
    const publication = await ownPublication(page)
    await context.setOffline(true)
    await edit(page, 'Private offline save')
    await page.route('**/api/sync', (route) => route.abort())
    await context.setOffline(false)
    // Update the public version before letting the offline page resume its queue.
    // Sync requests stay blocked briefly so reconnection cannot race this fixture mutation.
    const session = await (await page.request.get('/api/session')).json()
    const response = await page.request.post('/api/community/publish', {
        headers: { 'X-CSRF-TOKEN': session.csrfToken },
        data: {
            accountId: session.user.id,
            localSongId: publication.localSongId,
            expectedRevision: 1,
            sharingAccepted: true,
            content: { ...publication.content, lyrics: 'Concurrent public version' },
        },
    })
    expect(response.ok()).toBe(true)
    await page.unroute('**/api/sync')
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await expect(
        page.getByText('Sharing update blocked. Open Share song to review and publish manually.', {
            exact: true,
        }),
    ).toBeVisible()
    await waitForPublicLyrics(page, 'Concurrent public version', 2)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue('Private offline save')
})

test('keeps the Shared badge when a listing started before publication returns late', async ({
    page,
}) => {
    await register(page, 'latebadge')
    await create(page, `Late badge ${crypto.randomUUID().slice(0, 8)}`)
    let release!: () => void, started!: () => void, nextStarted!: () => void
    const held = new Promise<void>((resolve) => (release = resolve)),
        requested = new Promise<void>((resolve) => (started = resolve)),
        nextRequested = new Promise<void>((resolve) => (nextStarted = resolve))
    let requests = 0
    await page.route('**/api/community/mine?sort=id&page=1', async (route) => {
        if (++requests === 1) {
            const response = await route.fetch()
            started()
            await held
            await route.fulfill({ response })
        } else {
            nextStarted()
            await route.fulfill({ status: 503, json: { message: 'Temporary listing failure' } })
        }
    })
    try {
        // The sharing preview has its own song-specific lookup, unaffected by this held listing.
        await page.getByRole('button', { name: 'Share song', exact: true }).click()
        await requested
        await page
            .getByLabel(
                'I understand how sharing and private copies work, and confirm that I can share this content.',
                { exact: true },
            )
            .check()
        await page.getByRole('button', { name: 'Publish this version', exact: true }).click()
        await expect(page.getByText('Publication saved · V.1.', { exact: true })).toBeVisible()
        await page.getByRole('button', { name: 'Back to library', exact: true }).click()
        await expect(page.locator('.sharing-badge')).toHaveText('Shared')
        release()
        await page.getByRole('button', { name: 'Sync now', exact: true }).click()
        // A subsequent failed listing proves the old result was consumed and cannot repair it.
        await nextRequested
        await expect(page.locator('.sharing-badge')).toHaveText('Shared')
    } finally {
        release()
        await page.unroute('**/api/community/mine?sort=id&page=1')
    }
})
