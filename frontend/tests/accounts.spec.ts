import { expect, test, type Page } from '@playwright/test'

async function register(page: Page, prefix: string) {
    const nickname = `${prefix}_${crypto.randomUUID().slice(0, 8)}`
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByRole('button', { name: 'Create a free account', exact: true }).click()
    await page.getByLabel('Public pseudonym', { exact: true }).fill(nickname)
    await page.getByLabel('Email address', { exact: true }).fill(`${nickname}@example.test`)
    await page.getByLabel('Password', { exact: true }).fill('A private password 123')
    await page.getByLabel('Confirm password', { exact: true }).fill('A private password 123')
    await page.getByRole('button', { name: 'Create a free account', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
    return nickname
}

async function createSong(page: Page, title: string) {
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Title', { exact: true }).fill(title)
    await page.getByLabel('Lyrics', { exact: true }).fill('A private local lyric')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
}

for (const remember of [true, false]) {
    test(`restores only a remembered sign-in after closing the browser (remember=${remember})`, async ({
        page,
        context,
        browser,
    }) => {
        await page.goto('/')
        const nickname = await register(page, 'remember')
        await createSong(page, 'Private song kept on device')
        await expect(page.locator('.sync-status')).toContainText('Synced')
        await page.getByRole('button', { name: nickname, exact: true }).click()
        await page.getByRole('button', { name: 'Sign out', exact: true }).click()
        await page.getByRole('button', { name: 'Account', exact: true }).click()
        const checkbox = page.getByRole('checkbox', { name: 'Remember me', exact: true })
        await expect(checkbox).not.toBeChecked()
        if (remember) await checkbox.check()
        await page.getByLabel('Email address', { exact: true }).fill(`${nickname}@example.test`)
        await page.getByLabel('Password', { exact: true }).fill('A private password 123')
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()

        // Retain persistent browser data, dropping session cookies as a browser exit does.
        const state = await context.storageState({ indexedDB: true })
        const sessionCookies = state.cookies.filter((cookie) => cookie.expires === -1)
        expect(sessionCookies.some((cookie) => cookie.name.endsWith('session'))).toBe(true)
        state.cookies = state.cookies.filter((cookie) => cookie.expires > 0)
        expect(state.cookies.some((cookie) => cookie.name.startsWith('remember_'))).toBe(remember)
        const reopened = await browser.newContext({ storageState: state })
        try {
            const next = await reopened.newPage()
            await next.goto('/')
            await expect(
                next.getByText('Private song kept on device', { exact: true }),
            ).toBeVisible()
            await expect(
                next.getByRole('button', { name: remember ? nickname : 'Account', exact: true }),
            ).toBeVisible()
            const session = await (await next.request.get('/api/session')).json()
            expect(session.user?.pseudonym ?? null).toBe(remember ? nickname : null)
            if (remember) {
                await next.getByRole('button', { name: nickname, exact: true }).click()
                await next.getByRole('button', { name: 'Sign out', exact: true }).click()
                await expect(
                    next.getByRole('heading', { name: 'Your library', exact: true }),
                ).toBeVisible()
                expect(
                    (await reopened.cookies()).some((cookie) =>
                        cookie.name.startsWith('remember_'),
                    ),
                ).toBe(false)
                await next.reload()
                expect((await (await next.request.get('/api/session')).json()).user).toBeNull()
                await expect(
                    next.getByText('Private song kept on device', { exact: true }),
                ).toBeVisible()
            }
        } finally {
            await reopened.close()
        }
    })
}

test('uses the same remember choice for Google and password sign-in on a narrow screen', async ({
    page,
}) => {
    await page.route('**/api/session', async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, json: { ...(await response.json()), googleEnabled: true } })
    })
    await page.setViewportSize({ width: 320, height: 740 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    const google = page.getByRole('link', { name: 'Continue with Google' })
    await expect(google).toHaveAttribute('href', '/auth/google/redirect?remember=0')
    await page.getByRole('checkbox', { name: 'Remember me', exact: true }).check()
    await expect(google).toHaveAttribute('href', '/auth/google/redirect?remember=1')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Remember me', exact: true })).toHaveCount(0)
})

test('deletes a selected signed-out library offline and restores only its online songs on sign-in', async ({
    page,
    context,
}) => {
    await page.goto('/')
    await createSong(page, 'Guest kept')
    const first = await register(page, 'remove')
    await expect(
        page.getByRole('button', { name: 'Delete local library', exact: true }),
    ).toBeDisabled()
    await createSong(page, 'Online song restored')
    await expect(page.locator('.sync-status')).toContainText('Synced')
    await page.getByRole('button', { name: first, exact: true }).click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    const second = await register(page, 'kept')
    await createSong(page, 'Other account kept')
    await page.getByLabel('Library on this device').selectOption({ label: first })
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready
    })
    await page.reload()
    await expect(page.getByText('Online song restored', { exact: true })).toBeVisible()
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('Only on this device')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    page.once('dialog', async (dialog) => {
        expect(dialog.message()).toContain(first)
        expect(dialog.message()).toContain('unsynced changes')
        await dialog.dismiss()
    })
    await page.getByRole('button', { name: 'Delete local library', exact: true }).click()
    await expect(page.getByText('Online song restored', { exact: true })).toBeVisible()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Delete local library', exact: true }).click()
    await expect(page.getByLabel('Library on this device')).toHaveValue('guest')
    await expect(page.getByText('Guest kept', { exact: true })).toBeVisible()
    await expect(page.locator('select option').filter({ hasText: first })).toHaveCount(0)
    await page.reload()
    await expect(page.locator('select option').filter({ hasText: first })).toHaveCount(0)
    await page.getByLabel('Library on this device').selectOption({ label: second })
    await expect(page.getByText('Other account kept', { exact: true })).toBeVisible()
    await context.setOffline(false)
    await page.getByRole('button', { name: second, exact: true }).click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByLabel('Email address', { exact: true }).fill(`${first}@example.test`)
    await page.getByLabel('Password', { exact: true }).fill('A private password 123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByText('Online song restored', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue('A private local lyric')
})

test('clears Guest across tabs without erasing other profile labels or their songs', async ({
    page,
    context,
}) => {
    await page.goto('/')
    await createSong(page, 'Guest to remove')
    const nickname = await register(page, 'guestreset')
    await createSong(page, 'Member kept')
    await page.getByLabel('Library on this device').selectOption('guest')
    const other = await context.newPage()
    await other.goto('/')
    await other.getByRole('button', { name: 'Edit', exact: true }).click()
    await other.getByLabel('Lyrics', { exact: true }).fill('Unfinished in another tab')
    const memberTab = await context.newPage()
    await memberTab.goto('/')
    await memberTab.getByLabel('Library on this device').selectOption({ label: nickname })
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Delete local library', exact: true }).click()
    for (const tab of [page, other]) {
        await expect(tab.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
        await expect(tab.locator('.song-card')).toHaveCount(0)
        await expect(tab.getByLabel('Library on this device')).toHaveValue('guest')
        await expect(tab.getByRole('alert')).toHaveCount(0)
    }
    await expect(memberTab.getByText('Member kept', { exact: true })).toBeVisible()
    await memberTab.getByLabel('Library on this device').selectOption('guest')
    await expect(memberTab.locator('.song-card')).toHaveCount(0)
    await expect(memberTab.getByRole('alert')).toHaveCount(0)
    await memberTab.close()
    await other.close()
    await page.reload()
    await expect(page.locator('.song-card')).toHaveCount(0)
    await createSong(page, 'Fresh guest song')
    await page.getByLabel('Library on this device').selectOption({ label: nickname })
    await expect(page.getByText('Member kept', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('keeps a local library when its deletion transaction fails', async ({ page }) => {
    await page.goto('/')
    await createSong(page, 'Must survive')
    await page.evaluate(() => {
        const clear = IDBObjectStore.prototype.clear
        IDBObjectStore.prototype.clear = function () {
            const result = clear.call(this)
            this.transaction.abort()
            return result
        }
    })
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Delete local library', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByText('Must survive', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByText('Must survive', { exact: true })).toBeVisible()
})

test('keeps the guest library separate and copies it only after explicit confirmation', async ({
    page,
}) => {
    await page.goto('/')
    await createSong(page, 'Guest original')
    const nickname = await register(page, 'guitarplayerwithlong')
    await page.setViewportSize({ width: 360, height: 800 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('button', { name: nickname, exact: true })).toBeInViewport()
    await expect(page.getByText('Guest original', { exact: true })).not.toBeVisible()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Copy guest songs to this profile' }).click()
    await expect(page.getByText('Guest original', { exact: true })).toBeVisible()
    await page.getByLabel('Library on this device').selectOption('guest')
    await expect(page.getByText('Guest original', { exact: true })).toBeVisible()
    await page.getByLabel('Library on this device').selectOption({ label: nickname })
    const urls = await page.evaluate(async () => {
        const stores = await Promise.all((await caches.keys()).map((name) => caches.open(name)))
        return (await Promise.all(stores.map((store) => store.keys())))
            .flat()
            .map((request) => request.url)
    })
    expect(urls.some((url) => /\/(api|auth)\//.test(new URL(url).pathname))).toBe(false)
})

test('retains unlimited creation offline and keeps songs editable after logout', async ({
    page,
    context,
}) => {
    await page.goto('/')
    const nickname = await register(page, 'offline')
    for (let i = 0; i < 4; i++) await createSong(page, `Member song ${i}`)
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready
    })
    await page.reload()
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
    await context.setOffline(true)
    await page.reload()
    await createSong(page, 'Created without a connection')
    await expect(page.locator('.song-card')).toHaveCount(5)
    await context.setOffline(false)
    await page.getByRole('button', { name: nickname, exact: true }).click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.locator('.song-card')).toHaveCount(5)
    await page.getByRole('button', { name: '+ New song', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Your guest library holds 3 songs')
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await page.getByLabel('Lyrics', { exact: true }).fill('Edited after signing out')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await expect(page.locator('.song-card')).toHaveCount(5)
    const second = await register(page, 'separate')
    await expect(page.locator('.song-card')).toHaveCount(0)
    await page.getByLabel('Library on this device').selectOption({ label: nickname })
    await expect(page.locator('.song-card')).toHaveCount(5)
    await page.getByLabel('Library on this device').selectOption({ label: second })
    await expect(page.locator('.song-card')).toHaveCount(0)
})

test('keeps the previous profile inaccessible while the next library loads', async ({ page }) => {
    await page.addInitScript(() => {
        const original = IDBRequest.prototype.addEventListener
        let delayed: {
            request: IDBRequest
            listener: EventListenerOrEventListenerObject
            event: Event
        }[] = []
        ;(window as any).holdSongLists = false
        ;(window as any).releaseSongLists = () => {
            const waiting = delayed
            delayed = []
            for (const { request, listener, event } of waiting) {
                if (typeof listener === 'function') listener.call(request, event)
                else listener.handleEvent(event)
            }
        }
        IDBRequest.prototype.addEventListener = function (
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
        ) {
            if (
                (window as any).holdSongLists &&
                type === 'success' &&
                this.source instanceof IDBObjectStore &&
                this.source.name === 'songs'
            ) {
                delayed.push({ request: this, listener, event: new Event('success') })
                return
            }
            return original.call(this, type, listener, options)
        }
    })
    await page.goto('/')
    const first = await register(page, 'first')
    await createSong(page, 'First profile private song')
    await page.getByRole('button', { name: first, exact: true }).click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    const second = await register(page, 'second')
    await page.getByLabel('Library on this device').selectOption({ label: first })
    await expect(page.getByText('First profile private song', { exact: true })).toBeVisible()

    await page.evaluate(() => ((window as any).holdSongLists = true))
    await page.getByLabel('Library on this device').selectOption({ label: second })
    await expect(page.getByText('Loading this profile…', { exact: true })).toBeVisible()
    await expect(page.getByText('First profile private song', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)

    await page.evaluate(() => (window as any).releaseSongLists())
    await expect(page.getByRole('heading', { name: 'Your library' })).toBeVisible()
    await expect(page.locator('.song-card')).toHaveCount(0)
})

test('shows password recovery from a reset link even with an active session', async ({ page }) => {
    await page.goto('/')
    const nickname = await register(page, 'reset')
    const email = `${nickname}@example.test`
    const token = 'single-use-test-token'
    await page.goto(`/#reset-password?token=${token}&email=${encodeURIComponent(email)}`)
    await page.reload()

    await expect(page.getByRole('heading', { name: 'Reset password', exact: true })).toBeVisible()
    await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(email)
    await expect(page).toHaveURL(/\/$/)
    await page.getByLabel('Password', { exact: true }).fill('A replacement password 456')
    await page.getByLabel('Confirm password', { exact: true }).fill('A replacement password 456')

    let submitted: Record<string, string> | undefined
    await page.route('**/api/reset-password', async (route) => {
        submitted = route.request().postDataJSON()
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Password reset successfully.' }),
        })
    })
    await page.getByRole('button', { name: 'Reset password', exact: true }).click()
    await expect.poll(() => submitted?.token).toBe(token)
    expect(submitted?.email).toBe(email)
})
