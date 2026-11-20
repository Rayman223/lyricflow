import { expect, test, type Page } from '@playwright/test'

const links = {
    YouTube: 'https://youtu.be/dQw4w9WgXcQ',
    'YouTube Music': 'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    Deezer: 'https://www.deezer.com/fr/track/3135556',
    Spotify: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
}
async function create(page: Page) {
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Title', { exact: true }).fill('Music link song')
    await page.getByLabel('Lyrics', { exact: true }).fill('First line\nLast line')
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    for (const [name, url] of Object.entries(links))
        await page.getByLabel(`${name} link (optional)`, { exact: true }).fill(url)
}
async function checkLinks(page: Page) {
    const nav = page.getByRole('navigation', { name: 'Music links' })
    await expect(nav.getByRole('link')).toHaveCount(4)
    for (const [name, url] of Object.entries(links)) {
        const link = nav.getByRole('link', { name: `Open ${name} (new tab)`, exact: true })
        await expect(link).toHaveAttribute('href', url)
        await expect(link).toHaveAttribute('target', '_blank')
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
        await expect(link).toHaveText(name)
    }
}

test('keeps invalid drafts through reload, blocks save and reading, then saves four links offline', async ({
    page,
    context,
}) => {
    await create(page)
    await page
        .getByLabel('YouTube link (optional)', { exact: true })
        .fill('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')
    await expect(page.getByLabel('YouTube link (optional)', { exact: true })).toHaveAttribute(
        'aria-invalid',
        'true',
    )
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Check the music links')
    await page.getByRole('button', { name: 'Open prompter', exact: true }).click()
    await expect(page.locator('.reader')).toHaveCount(0)
    await expect(page.getByText('Draft saved on device', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Continue editing', exact: true }).click()
    await expect(page.getByLabel('YouTube link (optional)', { exact: true })).toHaveValue(
        'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    )
    await page.getByLabel('YouTube link (optional)', { exact: true }).fill(` ${links.YouTube} `)
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Open prompter', exact: true }).click()
    await checkLinks(page)
    await page.reload()
    await page.locator('.song-open').click()
    await checkLinks(page)
    await page.getByRole('button', { name: 'Your library' }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    for (const name of Object.keys(links))
        await page.getByLabel(`${name} link (optional)`, { exact: true }).fill('')
    await page.getByRole('button', { name: 'Open prompter', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Music links' })).toHaveCount(0)
})

test('shows music links without overflow and preserves playback controls in both themes and landscape', async ({
    page,
}, testInfo) => {
    await create(page)
    await page.getByRole('button', { name: 'Open prompter', exact: true }).click()
    for (const [width, height] of [
        [320, 640],
        [915, 412],
        [820, 1180],
    ]) {
        await page.setViewportSize({ width: width!, height: height! })
        for (const theme of ['light', 'dark']) {
            await page.evaluate((theme) => {
                document.documentElement.dataset.theme = theme
            }, theme)
            await checkLinks(page)
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true)
            await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeInViewport()
            await expect(page.locator('.lyric-row').first()).toBeInViewport()
            await expect(
                page.getByRole('link', { name: 'Open Spotify (new tab)' }),
            ).toBeInViewport()
            await page.screenshot({ path: testInfo.outputPath(`${width}-${theme}.png`) })
        }
    }
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Music links' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await checkLinks(page)
})

test('publishes links with consent, restores them on another device and opens them anonymously', async ({
    page,
    context,
    browser,
    baseURL,
}) => {
    const name = `music_${crypto.randomUUID().slice(0, 8)}`
    const session = await (await context.request.get('/api/session')).json()
    const response = await context.request.post('/api/register', {
        headers: { 'X-CSRF-TOKEN': session.csrfToken },
        data: {
            pseudonym: name,
            email: `${name}@example.test`,
            password: 'A private password 123',
            password_confirmation: 'A private password 123',
        },
    })
    expect(response.ok()).toBe(true)
    await page.goto('/')
    const account = await (await context.request.get('/api/session')).json()
    await page
        .getByRole('combobox', { name: 'Library on this device' })
        .selectOption(account.user.id)
    await create(page)
    await page.getByRole('button', { name: 'Open prompter', exact: true }).click()
    await page.getByRole('button', { name: 'Share link', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Public preview' })).toBeVisible()
    await checkLinks(page)
    await page
        .getByLabel(
            'I understand how sharing and private copies work, and confirm that I can share this content.',
            { exact: true },
        )
        .check()
    await page.getByRole('button', { name: 'Publish this version', exact: true }).click()
    await expect(page.getByText('Publication saved · V.1.', { exact: true })).toBeVisible()
    const publication = (await (await context.request.get('/api/community/mine')).json())
        .publications[0]
    const second = await browser.newContext({ baseURL, storageState: await context.storageState() })
    const guest = await browser.newContext({ baseURL })
    try {
        const restored = await second.newPage()
        await restored.goto('/')
        await restored
            .getByRole('combobox', { name: 'Library on this device' })
            .selectOption(account.user.id)
        await restored.locator('.song-open').click()
        await checkLinks(restored)
        const viewer = await guest.newPage()
        await viewer.goto(`/#song=${publication.id}`)
        await checkLinks(viewer)
        expect(await viewer.evaluate(async () => (await indexedDB.databases()).length)).toBe(0)
        await page.getByRole('button', { name: 'Back to library', exact: true }).click()
        await page.getByRole('button', { name: 'Your library' }).click()
        await page.getByRole('button', { name: 'Edit', exact: true }).click()
        await page.getByLabel('Spotify link (optional)', { exact: true }).fill('')
        await page
            .getByLabel('Deezer link (optional)', { exact: true })
            .fill('https://deezer.com/track/2')
        await page.getByRole('button', { name: 'Save song', exact: true }).click()
        await expect
            .poll(
                async () =>
                    (
                        await (
                            await context.request.get(
                                `/api/publications/${publication.id}/prompter`,
                            )
                        ).json()
                    ).publication.revision,
            )
            .toBe(2)
        await viewer.reload()
        await expect(
            viewer.getByRole('navigation', { name: 'Music links' }).getByRole('link'),
        ).toHaveCount(3)
        await expect(viewer.getByRole('link', { name: 'Open Deezer (new tab)' })).toHaveAttribute(
            'href',
            'https://deezer.com/track/2',
        )
        await expect(viewer.getByRole('link', { name: 'Open Spotify (new tab)' })).toHaveCount(0)
    } finally {
        await second.close()
        await guest.close()
    }
})

test('suppresses untrusted stored links in a public reader', async ({ page }) => {
    const id = crypto.randomUUID()
    await page.route(`**/api/publications/${id}/prompter`, (route) =>
        route.fulfill({
            json: {
                publication: {
                    id,
                    revision: 1,
                    author: 'test',
                    content: {
                        formatVersion: 1,
                        title: 'Unsafe links',
                        artist: '',
                        lyrics: 'A lyric',
                        music: { bpm: 120, beatsPerBar: 4, barsPerLine: 1 },
                        musicLinks: {
                            youtube: 'javascript:alert(1)',
                            spotify:
                                'https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC',
                        },
                    },
                },
            },
        }),
    )
    await page.goto(`/#song=${id}`)
    await expect(page.locator('.reader')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Music links' })).toHaveCount(0)
})
