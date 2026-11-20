import { expect, test, type Page } from '@playwright/test'

test('keeps lyrics in the editor and reports a device write failure', async ({ page }) => {
    await page.addInitScript(() => {
        const originalPut = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof originalPut>) {
            if (this.name === 'songs' || this.name === 'drafts')
                throw new DOMException('Test device full', 'QuotaExceededError')
            return originalPut.apply(this, args)
        }
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('Keep this private draft')
    await expect(page.getByRole('alert')).toContainText('Could not save on this device')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue('Keep this private draft')
    await expect(page.getByRole('heading', { name: 'Song editor' })).toBeVisible()
})

async function createSong(page: Page, title: string, lyrics = 'First line\nSecond line') {
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Title', { exact: true }).fill(title)
    await page.getByLabel('Artist', { exact: true }).fill('Test artist')
    await page.getByLabel('Lyrics', { exact: true }).fill(lyrics)
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
}

test('persists songs and theme, opens and edits offline after a full reload', async ({
    page,
    context,
}) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    await createSong(page, 'Offline song')
    await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready
    })
    await page.reload()
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
    await context.setOffline(true)
    await page.reload()
    await expect(page.getByText('Offline song', { exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('Offline edit\nNext line')
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await expect(page.getByRole('button', { name: 'Offline edit', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue('Offline edit\nNext line')
    expect(errors).toEqual([])
})

test('enforces three songs, preserves invalid drafts and refuses to read invalid codes', async ({
    page,
}) => {
    await page.goto('/')
    for (let i = 1; i <= 3; i++) await createSong(page, `Song ${i}`)
    await page.getByRole('button', { name: 'New song' }).click()
    await expect(page.getByRole('alert')).toContainText('Your guest library holds 3 songs')
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await page
        .getByLabel('Lyrics', { exact: true })
        .fill('[tempo=90]\nA draft without a closing tag')
    await expect(page.getByRole('button', { name: 'Open prompter' })).toBeDisabled()
    await expect(page.getByText('Draft saved on device', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue(
        '[tempo=90]\nA draft without a closing tag',
    )
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await page
        .getByRole('button', { name: /Song 3/ })
        .first()
        .click()
    await expect(page.getByRole('button', { name: 'Open prompter' })).toBeDisabled()
})

test('keeps wrapped lyrics as one active step and pauses on visibility loss', async ({ page }) => {
    await page.goto('/')
    const longLine =
        'One very long lyric line that wraps over several visual lines on a narrow phone screen'
    await createSong(
        page,
        'Wrapped song',
        `[section=Verse]\n${longLine}\n[tempo=80]\nSecond\n[/tempo]`,
    )
    await page.locator('.song-open').click()
    await expect(page.locator('.lyric-row')).toHaveCount(2)
    const box = await page.getByRole('button', { name: longLine }).boundingBox()
    expect(box!.height).toBeGreaterThan(80)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
    await page.getByLabel('Song BPM').fill('180')
    await page.getByLabel('Song BPM').blur()
    await page.getByRole('button', { name: 'Second', exact: true }).click({ force: true })
    await expect(page.locator('.passage-bpm strong')).toHaveText('80')
})
