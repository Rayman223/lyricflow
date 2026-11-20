import { expect, test, type Page, type Browser } from '@playwright/test'

const password = 'A private password 123'
async function register(page: Page) {
    const name = `sync_${crypto.randomUUID().slice(0, 8)}`
    await page.goto('/')
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByRole('button', { name: 'Create a free account', exact: true }).click()
    await page.getByLabel('Public pseudonym', { exact: true }).fill(name)
    await page.getByLabel('Email address', { exact: true }).fill(`${name}@example.test`)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByLabel('Confirm password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Create a free account', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
    return name
}
async function secondDevice(browser: Browser, name: string) {
    const context = await browser.newContext({
        baseURL: test.info().project.use.baseURL,
        viewport: { width: 393, height: 851 },
    })
    const page = await context.newPage()
    await page.goto('/')
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByLabel('Email address', { exact: true }).fill(`${name}@example.test`)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
    return { page, context }
}
async function sync(page: Page) {
    const button = page.getByRole('button', { name: 'Sync now', exact: true })
    await expect(button).toBeEnabled()
    await button.click()
    await expect(page.locator('.sync-status')).toContainText('Synced')
}
async function save(
    page: Page,
    title: string,
    lyrics: string,
    existing = false,
    musicLink?: string,
) {
    await page
        .getByRole('button', { name: existing ? 'Edit' : '+ New song', exact: true })
        .first()
        .click()
    await page.getByLabel('Title', { exact: true }).fill(title)
    await page.getByLabel('Lyrics', { exact: true }).fill(lyrics)
    if (musicLink) await page.getByLabel('Deezer link (optional)', { exact: true }).fill(musicLink)
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
}

test('restores private songs, unfinished drafts and theme on another device without caching API data', async ({
    page,
    browser,
}) => {
    const name = await register(page)
    await save(page, 'Backed up song', 'Private saved lyrics')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('Unfinished private draft')
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click()
    await sync(page)
    const second = await secondDevice(browser, name)
    try {
        await sync(second.page)
        await expect(second.page.getByText('Backed up song', { exact: true })).toBeVisible()
        await expect(second.page.locator('html')).toHaveAttribute('data-theme', 'dark')
        await second.page.getByRole('button', { name: 'Edit', exact: true }).click()
        await expect(second.page.getByLabel('Lyrics', { exact: true })).toHaveValue(
            'Unfinished private draft',
        )
        await second.page.evaluate(async () => {
            await navigator.serviceWorker.ready
        })
        const cached = await second.page.evaluate(async () =>
            (
                await Promise.all(
                    (await caches.keys()).map(async (name) =>
                        (await (await caches.open(name)).keys()).map((r) => r.url),
                    ),
                )
            ).flat(),
        )
        expect(cached.some((url) => /\/(api|auth)\//.test(new URL(url).pathname))).toBe(false)
    } finally {
        await second.context.close()
    }
})

test('retains conflicting offline edits after reload and keeps both versions on explicit choice', async ({
    page,
    browser,
}) => {
    const name = await register(page)
    await save(page, 'Concurrent song', 'Original')
    await sync(page)
    const second = await secondDevice(browser, name)
    try {
        await sync(second.page)
        await second.context.setOffline(true)
        await save(
            second.page,
            'Concurrent song',
            'Offline device lyrics',
            true,
            'https://deezer.com/track/1',
        )
        await save(
            page,
            'Concurrent song',
            'Online device lyrics',
            true,
            'https://deezer.com/track/2',
        )
        await sync(page)
        await second.context.setOffline(false)
        await second.page.getByRole('button', { name: 'Sync now', exact: true }).click()
        await expect(
            second.page.getByRole('heading', { name: 'Choose a version', exact: true }),
        ).toBeVisible()
        await second.page.reload()
        await expect(
            second.page.getByRole('heading', { name: 'Choose a version', exact: true }),
        ).toBeVisible()
        await second.page.getByText('Compare song versions', { exact: true }).click()
        await expect(second.page.locator('.conflict-card')).toContainText(
            'https://deezer.com/track/1',
        )
        await expect(second.page.locator('.conflict-card')).toContainText(
            'https://deezer.com/track/2',
        )
        await expect(second.page.locator('.conflict-card pre').nth(0)).toHaveText(
            'Offline device lyrics',
        )
        await expect(second.page.locator('.conflict-card pre').nth(1)).toHaveText(
            'Online device lyrics',
        )
        await second.page
            .getByRole('button', { name: 'Keep both as separate songs', exact: true })
            .click()
        await sync(second.page)
        await expect(second.page.locator('.song-card')).toHaveCount(2)
        await sync(page)
        await expect(page.locator('.song-card')).toHaveCount(2)
    } finally {
        await second.context.close()
    }
})

test('propagates deletion and prevents an old offline device from silently recreating the song', async ({
    page,
    browser,
}) => {
    const name = await register(page)
    await save(page, 'Deleted song', 'Original')
    await sync(page)
    const second = await secondDevice(browser, name)
    try {
        await sync(second.page)
        await second.context.setOffline(true)
        await save(second.page, 'Deleted song', 'Recovered offline lyrics', true)
        await page.getByRole('button', { name: 'Delete Deleted song', exact: true }).click()
        await page.getByRole('button', { name: 'Delete song', exact: true }).click()
        await sync(page)
        await second.context.setOffline(false)
        await second.page.getByRole('button', { name: 'Sync now', exact: true }).click()
        await expect(
            second.page.getByRole('heading', { name: 'Choose a version', exact: true }),
        ).toBeVisible()
        await sync(page)
        await expect(page.locator('.song-card')).toHaveCount(0)
        await second.page.getByRole('button', { name: 'Keep device version', exact: true }).click()
        await sync(second.page)
        await sync(page)
        await expect(page.locator('.song-card')).toHaveCount(1)
        await page.getByRole('button', { name: 'Edit', exact: true }).click()
        await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue(
            'Recovered offline lyrics',
        )
    } finally {
        await second.context.close()
    }
})

for (const keep of [true, false]) {
    test(`deletes an account and ${keep ? 'keeps' : 'erases'} songs on this device`, async ({
        page,
        browser,
    }) => {
        const name = await register(page)
        await save(page, 'Before deletion', 'Private lyrics')
        await sync(page)
        const second = await secondDevice(browser, name)
        try {
            await sync(second.page)
            await page.getByRole('button', { name, exact: true }).click()
            await page.getByRole('button', { name: 'Delete account', exact: true }).click()
            await page
                .getByLabel('Type your public pseudonym to confirm', { exact: true })
                .fill(name)
            await page.getByLabel('Current password', { exact: true }).fill(password)
            await page
                .getByLabel('Keep songs and drafts on this device', { exact: true })
                .setChecked(keep)
            await page
                .getByRole('button', { name: 'Permanently delete my account', exact: true })
                .click()
            await expect(page.getByText('Account deleted.', { exact: false })).toBeVisible()
            await expect(page.locator('.song-card')).toHaveCount(keep ? 1 : 0)
            await page.reload()
            await expect(page.locator('.song-card')).toHaveCount(keep ? 1 : 0)
            await second.page.getByRole('button', { name: 'Sync now', exact: true }).click()
            await expect(second.page.locator('.sync-status')).toContainText('Sign in to sync')
            await expect(second.page.locator('.song-card')).toHaveCount(1)
        } finally {
            await second.context.close()
        }
    })
}

test('keeps editing available while an online synchronization response is delayed', async ({
    page,
    browser,
}) => {
    const name = await register(page)
    await save(page, 'Slow connection', 'Before editing')
    await sync(page)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    await page.route('**/api/sync', async (route) => {
        await held
        await route.continue()
    })
    try {
        const request = page.waitForRequest('**/api/sync')
        await page.getByRole('button', { name: 'Sync now', exact: true }).click()
        await request
        await save(page, 'Slow connection', 'Edited during a slow request', true)
    } finally {
        release()
    }
    await sync(page)
    const second = await secondDevice(browser, name)
    try {
        await sync(second.page)
        await second.page.getByRole('button', { name: 'Edit', exact: true }).click()
        await expect(second.page.getByLabel('Lyrics', { exact: true })).toHaveValue(
            'Edited during a slow request',
        )
    } finally {
        await second.context.close()
    }
})

test('recovers a lost upload response without turning the next local edit into a conflict', async ({
    page,
    browser,
}) => {
    const name = await register(page)
    await save(page, 'Lost response', 'Original')
    await sync(page)
    let drop = true
    await page.route('**/api/sync', async (route) => {
        const body = route.request().postDataJSON()
        if (drop && body.operation?.value?.song?.lyrics === 'Accepted but response lost') {
            drop = false
            await route.fetch()
            await route.abort('failed')
        } else await route.continue()
    })
    await save(page, 'Lost response', 'Accepted but response lost', true)
    await page.getByRole('button', { name: 'Sync now', exact: true }).click()
    await expect(page.locator('.sync-status')).toContainText('Sync unavailable')
    await save(page, 'Lost response', 'New edit after the lost response', true)
    await sync(page)
    await expect(page.getByRole('heading', { name: 'Choose a version', exact: true })).toHaveCount(
        0,
    )
    const second = await secondDevice(browser, name)
    try {
        await sync(second.page)
        await second.page.getByRole('button', { name: 'Edit', exact: true }).click()
        await expect(second.page.getByLabel('Lyrics', { exact: true })).toHaveValue(
            'New edit after the lost response',
        )
    } finally {
        await second.context.close()
    }
})
