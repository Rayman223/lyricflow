import { expect, test, type Page } from '@playwright/test'

const clockTime = new Date('2026-10-21T12:00:00Z')

async function openReader(page: Page, beats: number, mode = 'bpm') {
    await page.clock.install({ time: clockTime })
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('First line\nLast line')
    await page.getByLabel('Song BPM', { exact: true }).fill('60')
    await page.getByLabel('Beats per bar').fill(String(beats))
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption(mode)
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await page.clock.pauseAt(new Date(clockTime.getTime() + 60000))
}

for (const beats of [4, 6]) {
    test(`${beats} lights follow the beat, BPM, pause, seek, end and restart`, async ({ page }) => {
        await openReader(page, beats)
        const lights = page.locator('.metronome-light')
        const lit = page.locator('.metronome-light.lit')
        await expect(lights).toHaveCount(beats)
        await expect(lit).toHaveCount(0)
        await expect(
            page.getByRole('img', { name: `Visual metronome: ${beats} beats per bar` }),
        ).toBeVisible()
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await expect(lights.nth(0)).toHaveClass(/lit/)
        await page.clock.runFor(1020)
        await expect(lights.nth(1)).toHaveClass(/lit/)
        await page.clock.runFor(200)
        await expect(lit).toHaveCount(0)
        await page.clock.runFor(800)
        await expect(lights.nth(2)).toHaveClass(/lit/)
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
        await page.clock.runFor(5000)
        await expect(lit).toHaveCount(0)
        await page.getByRole('button', { name: 'Resume', exact: true }).click()
        await expect(lights.nth(2)).toHaveClass(/lit/)
        await page.clock.runFor(1000)
        await expect(lights.nth(3)).toHaveClass(/lit/)
        await page.getByLabel('Song BPM', { exact: true }).fill('120')
        await page.getByLabel('Song BPM', { exact: true }).blur()
        await page.clock.runFor(500)
        await expect(lights.nth(4 % beats)).toHaveClass(/lit/)
        await page
            .getByRole('button', { name: 'Last line', exact: true })
            .evaluate((el: HTMLElement) => el.click())
        await expect(lights.nth(0)).toHaveClass(/lit/)
        await page.clock.runFor(beats * 500 + 20)
        await expect(page.getByText('End of song', { exact: true })).toBeVisible()
        await expect(lit).toHaveCount(0)
        await page.getByRole('button', { name: 'Restart', exact: true }).click()
        await expect(lit).toHaveCount(0)
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await expect(lights.nth(0)).toHaveClass(/lit/)
    })
}

test('pixel mode keeps lights running during a seconds wait and stops in background', async ({
    page,
}) => {
    await openReader(page, 6, 'pixels')
    await page.getByRole('button', { name: 'Your library' }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('[pause seconds=30]\nLast line')
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.clock.runFor(1020)
    await expect(page.locator('.pause-row.active')).toContainText('Wait')
    await expect(page.locator('.metronome-light').nth(1)).toHaveClass(/lit/)
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.clock.runFor(5000)
    await expect(page.locator('.metronome-light.lit')).toHaveCount(0)
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(page.locator('.metronome-light').nth(1)).toHaveClass(/lit/)
})

for (const [beats, width, height, theme] of [
    [6, 320, 640, 'dark'],
    [32, 320, 640, 'light'],
    [6, 915, 412, 'light'],
] as const) {
    test(`${beats} lights fit at ${width}×${height} in ${theme} theme`, async ({
        page,
    }, testInfo) => {
        await page.setViewportSize({ width, height })
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await openReader(page, beats)
        await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme
        }, theme)
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await page.clock.runFor(20)
        for (const light of await page.locator('.metronome-light').all()) {
            await expect(light).toBeInViewport({ ratio: 1 })
        }
        await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeInViewport({
            ratio: 1,
        })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        )
        await page.screenshot({ path: testInfo.outputPath('metronome.png') })
    })
}

test('shared reader displays six lights during count-in and starts lyrics on the first light', async ({
    page,
}) => {
    await page.clock.install({ time: clockTime })
    await page.route('**/api/publications/*/prompter', (route) =>
        route.fulfill({
            json: {
                publication: {
                    id: 'metronome-fixture',
                    revision: 1,
                    author: 'Test musician',
                    content: {
                        formatVersion: 1,
                        title: 'Shared rhythm',
                        artist: 'Test band',
                        lyrics: 'First line\nLast line',
                        music: { bpm: 120, beatsPerBar: 6, barsPerLine: 1 },
                    },
                },
            },
        }),
    )
    await page.goto('/#song=metronome-fixture')
    await expect(page.locator('.metronome-light')).toHaveCount(6)
    await page.clock.pauseAt(new Date(clockTime.getTime() + 60000))
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('.count-overlay')).toBeVisible()
    await page.clock.runFor(520)
    await expect(page.locator('.metronome-light').nth(1)).toHaveClass(/lit/)
    await page.clock.runFor(1500)
    await expect(page.locator('.count-overlay')).toHaveCount(0)
    await expect(page.locator('.metronome-light').nth(0)).toHaveClass(/lit/)
    expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0)
})
