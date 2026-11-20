import { expect, test } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'

test('editor inserts combined line settings and keeps code invisible in the reader', async ({
    page,
}) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Title', { exact: true }).fill('Timing song')
    const lyrics = page.getByLabel('Lyrics', { exact: true })
    await lyrics.fill('First line\nSecond line')
    await lyrics.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0))
    await page.getByRole('button', { name: '+ Line timing', exact: true }).click()
    await page.getByLabel('Tempo (optional)').fill('80%')
    await page.getByLabel('Duration (optional)').fill('1.5')
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect(lyrics).toHaveValue('[line tempo=80% bars=1.5] First line\nSecond line')
    await lyrics.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0))
    await page.getByRole('button', { name: '+ Line timing', exact: true }).click()
    await page.getByLabel('Duration (optional)').fill('2')
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect(lyrics).toHaveValue('[line tempo=80% bars=2] First line\nSecond line')
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await expect(page.locator('.lyric-row').first()).toHaveText('First line')
    await expect(page.locator('.passage-bpm strong')).toHaveText('96')
    await page.getByLabel('Song BPM').fill('150')
    await page.getByLabel('Song BPM').blur()
    await expect(page.locator('.passage-bpm strong')).toHaveText('120')
})

for (const mode of ['bpm', 'pixels']) {
    test(`continuous ${mode} scrolling moves and respects timed and manual pauses`, async ({
        page,
    }) => {
        await page.clock.install()
        await page.goto('/')
        await page.getByRole('button', { name: 'New song' }).click()
        await page.getByLabel('Title', { exact: true }).fill(`Continuous ${mode}`)
        await page
            .getByLabel('Lyrics', { exact: true })
            .fill('First line\n[pause seconds=5]\nNext line')
        await page.getByLabel('Count-in beats (0 = off)').fill('0')
        await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption(mode)
        if (mode === 'bpm') await page.getByLabel('Movement').selectOption('continuous')
        else await page.getByLabel('Pixels / second').fill('1000')
        await page.getByRole('button', { name: 'Open prompter' }).click()
        const before = await page
            .getByTestId('lyrics-viewport')
            .evaluate((element) => element.scrollTop)
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await expect
            .poll(() =>
                page.getByTestId('lyrics-viewport').evaluate((element) => element.scrollTop),
            )
            .not.toBe(before)
        await expect(page.locator('.pause-row')).toHaveClass(/active/, { timeout: 4000 })
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
        const paused = await page.locator('.pause-row').textContent()
        await page.clock.runFor(2000)
        await expect(page.locator('.pause-row')).toHaveText(paused!)
        await page.getByRole('button', { name: 'Resume', exact: true }).click()
        await page.clock.runFor(6000)
        await expect(page.locator('.pause-row')).not.toHaveClass(/active/)
        await page.getByRole('button', { name: 'Your library' }).click()
    })
}

test('musical waits count down beats, pause with playback and convert bars', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-19T12:00:00Z') })
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Title', { exact: true }).fill('Musical waits')
    await page
        .getByLabel('Lyrics', { exact: true })
        .fill('First line\n[pause beats=8]\n[pause beats=1.5]\n[pause bars=2]\nNext line')
    await page.getByLabel('Song BPM').fill('60')
    await page.getByLabel('Beats per bar').fill('3')
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    await page.getByRole('button', { name: 'Open prompter' }).click()
    // Advance playback only through runFor, independent of runner speed.
    await page.clock.pauseAt(new Date('2026-10-19T12:01:00Z'))
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    // The first lyric takes three beats; include the animation frame crossing its end.
    await page.clock.runFor(3020)
    const wait = page.locator('.pause-row').first()
    await expect(wait).toHaveClass(/active/)
    await expect(wait).toContainText('8 beats remaining')
    await page.clock.runFor(1000)
    await expect(wait).toContainText('7 beats remaining')
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await page.clock.runFor(2000)
    await expect(wait).toContainText('8 beats remaining')
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(wait).toContainText('7 beats remaining')
    await page.clock.runFor(7000)
    await expect(page.locator('.pause-row').nth(1)).toHaveClass(/active/)
    await expect(page.locator('.pause-row').nth(1)).toContainText('2 beats remaining')
    await page.clock.runFor(500)
    await expect(page.locator('.pause-row').nth(1)).toContainText('1 beat remaining')
    await page.clock.runFor(1000)
    await expect(page.locator('.pause-row').nth(2)).toHaveClass(/active/)
    await expect(page.locator('.pause-row').nth(2)).toContainText('6 beats remaining')
    await page.getByRole('button', { name: 'Your library' }).click()
})

test('audible count-in creates audio only on request and begins reading after four beats', async ({
    page,
}) => {
    await page.addInitScript(() => {
        const Real = window.AudioContext
        ;(window as any).audioClicks = 0
        window.AudioContext = class extends Real {
            createOscillator() {
                ;(window as any).audioClicks++
                return super.createOscillator()
            }
        }
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByLabel('Audible count-in').check()
    await page.getByRole('button', { name: 'Open prompter' }).click()
    expect(await page.evaluate(() => (window as any).audioClicks)).toBe(0)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('.count-overlay')).toBeVisible()
    await expect(page.locator('.count-overlay')).not.toBeVisible({ timeout: 5000 })
    expect(await page.evaluate(() => (window as any).audioClicks)).toBe(4)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
})

for (const state of ['stopped', 'playing', 'paused']) {
    test(`an app update preserves a ${state} reader until returning to the library`, async ({
        page,
        context,
    }) => {
        const swPath = new URL('../../public/sw.js', import.meta.url)
        const original = readFileSync(swPath, 'utf8')
        try {
            await page.goto('/')
            await page.getByRole('button', { name: 'Try a sample' }).click()
            await page.getByLabel('Count-in beats (0 = off)').fill('0')
            await page.getByRole('button', { name: 'Save song', exact: true }).click()
            await expect(page.locator('.song-open')).toBeVisible()
            await page.evaluate(async () => {
                await navigator.serviceWorker.ready
            })
            await page.reload()
            const reader = await context.newPage()
            await reader.goto('/')
            await reader.locator('.song-open').click()
            if (state !== 'stopped')
                await reader.getByRole('button', { name: 'Start', exact: true }).click()
            if (state === 'paused')
                await reader.getByRole('button', { name: 'Pause', exact: true }).click()
            await reader.evaluate(() => {
                ;(window as any).readerSession = 'kept'
            })
            writeFileSync(swPath, `${original}\n// update-test-${Date.now()}\n`)
            await page.evaluate(async () => {
                await (await navigator.serviceWorker.ready).update()
            })
            await expect(
                page.getByRole('button', { name: 'Update now', exact: true }),
            ).toBeVisible()
            const control = state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Start'
            await expect(reader.getByRole('button', { name: control, exact: true })).toBeVisible()
            await expect(reader.locator('.pwa-message')).toHaveCount(0)
            await Promise.all([
                page.waitForEvent('load'),
                page.getByRole('button', { name: 'Update now', exact: true }).click(),
            ])
            expect(
                await page.evaluate(async () => !(await navigator.serviceWorker.ready).waiting),
            ).toBe(true)
            await expect(reader.getByRole('button', { name: control, exact: true })).toBeVisible()
            expect(await reader.evaluate(() => (window as any).readerSession)).toBe('kept')
            await expect(reader.locator('.reader-title strong')).toHaveText('A little more light')
            await Promise.all([
                reader.waitForEvent('load'),
                reader.getByRole('button', { name: 'Your library' }).click(),
            ])
            expect(await reader.evaluate(() => (window as any).readerSession)).toBeUndefined()
            await expect(reader.locator('.song-open')).toBeVisible()
            await reader.close()
        } finally {
            writeFileSync(swPath, original)
        }
    })
}
