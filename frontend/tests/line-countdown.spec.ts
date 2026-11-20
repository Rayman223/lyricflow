import { expect, test, type Page } from '@playwright/test'

const clockTime = new Date('2026-10-30T12:00:00Z')

async function openReader(
    page: Page,
    mode = 'line',
    lyrics = '[line bars=2] First line\nLast line',
) {
    await page.clock.install({ time: clockTime })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill(lyrics)
    await page.getByLabel('Song BPM', { exact: true }).fill('60')
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    if (mode === 'pixels') {
        await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('pixels')
        await page.getByLabel('Pixels / second').fill('20')
    } else await page.getByLabel('Movement').selectOption(mode)
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await page.clock.pauseAt(new Date(clockTime.getTime() + 60000))
}

async function expectFraction(page: Page, beats: number, bars: number) {
    await expect(page.locator('.line-countdown')).toHaveCount(1)
    await expect(page.locator('.line-countdown-beats')).toHaveText(String(beats))
    await expect(page.locator('.line-countdown-bars')).toHaveText(String(bars))
    await expect(
        page.getByRole('img', { name: `Remaining beats: ${beats}; remaining bars: ${bars}` }),
    ).toBeVisible()
}

for (const mode of ['line', 'continuous']) {
    test(`${mode}: cycles beats and bars, shows full duration on Pause and resumes the real remainder`, async ({
        page,
    }) => {
        await openReader(page, mode)
        await expectFraction(page, 4, 2)
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await page.clock.runFor(1020)
        await expectFraction(page, 3, 2)
        await page.clock.runFor(1000)
        await expectFraction(page, 2, 2)
        await page.clock.runFor(1000)
        await expectFraction(page, 1, 2)
        await page.clock.runFor(1000)
        await expectFraction(page, 4, 1)
        await page.clock.runFor(1000)
        await expectFraction(page, 3, 1)
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
        await expectFraction(page, 4, 2)
        await page.clock.runFor(10000)
        await expectFraction(page, 4, 2)
        await page.getByRole('button', { name: 'Resume', exact: true }).click()
        await expectFraction(page, 3, 1)
        await page.clock.runFor(2000)
        await expectFraction(page, 1, 1)
        await page.clock.runFor(1000)
        await expect(page.locator('.lyric-row.active')).toHaveText('Last line')
        await expectFraction(page, 4, 1)
        await page.clock.runFor(4000)
        await expect(page.locator('.line-countdown')).toHaveCount(0)
        await page.getByRole('button', { name: 'Restart', exact: true }).click()
        await expectFraction(page, 4, 2)
    })
}

test('waits use the same fraction and seconds waits use whole seconds', async ({ page }) => {
    await openReader(page, 'line', '[pause bars=2]\n[pause seconds=3]\nLast line')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('.pause-row.active')).toContainText('Wait')
    await expectFraction(page, 4, 2)
    await page.clock.runFor(5020)
    await expectFraction(page, 3, 1)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expectFraction(page, 4, 2)
    await expect(page.locator('.pause-row.active')).toContainText('8 beats remaining')
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expectFraction(page, 3, 1)
    await page.clock.runFor(3000)
    await expect(page.locator('.line-countdown-seconds')).toHaveText('3s')
    await page.clock.runFor(1000)
    await expect(page.locator('.line-countdown-seconds')).toHaveText('2s')
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.locator('.line-countdown-seconds')).toHaveText('3s')
    await expect(page.locator('.pause-row.active')).toContainText('3s remaining')
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(page.locator('.line-countdown-seconds')).toHaveText('2s')
    await page.clock.runFor(2000)
    await expect(page.locator('.lyric-row.active')).toHaveText('Last line')
    await expectFraction(page, 4, 1)
})

test('pixel mode uses seconds from visual distance and speed, including pauses', async ({
    page,
}) => {
    await openReader(page, 'pixels', 'First line\n[pause bars=2]\nLast line')
    const total = Number(
        (await page.locator('.line-countdown-seconds').textContent())!.replace('s', ''),
    )
    expect(total).toBeGreaterThan(2)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.clock.runFor(1020)
    const remaining = Number(
        (await page.locator('.line-countdown-seconds').textContent())!.replace('s', ''),
    )
    expect(remaining).toBe(total - 1)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.locator('.line-countdown-seconds')).toHaveText(`${total}s`)
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(page.locator('.line-countdown-seconds')).toHaveText(`${remaining}s`)
    await page.getByLabel('Song BPM', { exact: true }).fill('120')
    await page.getByLabel('Song BPM', { exact: true }).blur()
    await expect(page.locator('.line-countdown-seconds')).toHaveText(`${remaining}s`)
    await page.clock.runFor(remaining * 1000)
    await expect(page.locator('.pause-row.active')).toContainText('Wait')
    await expect(page.locator('.line-countdown-fraction')).toHaveCount(0)
    await expect(page.locator('.line-countdown-seconds')).toHaveText('4s')
    await page.clock.runFor(1000)
    await expect(page.locator('.line-countdown-seconds')).toHaveText('3s')
})

for (const theme of ['dark', 'light']) {
    test(`${theme}: fraction stays left of wrapped lyrics on a 320px screen`, async ({
        page,
    }, testInfo) => {
        await page.setViewportSize({ width: 320, height: 640 })
        await openReader(
            page,
            'line',
            '[line bars=2] A long lyric line wrapping over several visual lines\nLast line',
        )
        await page.evaluate((value) => {
            document.documentElement.dataset.theme = value
        }, theme)
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await page.clock.runFor(20)
        await expectFraction(page, 4, 2)
        const counter = (await page.locator('.line-countdown').boundingBox())!
        const lyric = (await page.locator('.lyric-row.active').boundingBox())!
        expect(counter.x + counter.width).toBeLessThan(lyric.x)
        await expect(page.locator('.line-countdown')).toBeInViewport({ ratio: 1 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        )
        await page.screenshot({ path: testInfo.outputPath('line-countdown.png') })
    })
}

test('shared reader displays the countdown without opening a local library', async ({ page }) => {
    await page.clock.install({ time: clockTime })
    await page.route('**/api/publications/*/prompter', (route) =>
        route.fulfill({
            json: {
                publication: {
                    id: 'countdown-fixture',
                    revision: 1,
                    author: 'Test musician',
                    content: {
                        formatVersion: 1,
                        title: 'Shared rhythm',
                        artist: '',
                        lyrics: 'First line\nLast line',
                        music: { bpm: 60, beatsPerBar: 4, barsPerLine: 2 },
                    },
                },
            },
        }),
    )
    await page.goto('/#song=countdown-fixture')
    await page.clock.pauseAt(new Date(clockTime.getTime() + 60000))
    await expectFraction(page, 4, 2)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.clock.runFor(5020)
    await expectFraction(page, 3, 2)
    expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0)
})

for (const mode of ['continuous', 'pixels']) {
    test(`${mode}: countdown remains visible while a tall active lyric scrolls`, async ({
        page,
    }) => {
        await page.setViewportSize({ width: 320, height: 640 })
        const lyric = 'A long lyric wrapping across the small screen. '.repeat(12)
        await openReader(page, mode, `[line bars=8] ${lyric}\nLast line`)
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await page.clock.runFor(8020)
        await expect(page.locator('.lyric-row.active')).toHaveText(lyric.trim())
        await expect(page.locator('.line-countdown')).toBeInViewport({ ratio: 1 })
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
        await expect(page.locator('.line-countdown')).toBeInViewport({ ratio: 1 })
    })

    test(`${mode}: countdown remains visible through consecutive timed waits`, async ({ page }) => {
        await openReader(page, mode, '[pause bars=2]\n[pause seconds=5]\n[pause bars=2]\nLast line')
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await page.clock.runFor(20)
        await expect(page.locator('.pause-row').nth(0)).toHaveClass(/active/)
        await expect(page.locator('.line-countdown')).toBeInViewport({ ratio: 1 })
        await page.clock.runFor(8000)
        await expect(page.locator('.pause-row').nth(1)).toHaveClass(/active/)
        await expect(page.locator('.line-countdown')).toBeInViewport({ ratio: 1 })
        await page.clock.runFor(5000)
        await expect(page.locator('.pause-row').nth(2)).toHaveClass(/active/)
        await expect(page.locator('.line-countdown')).toBeInViewport({ ratio: 1 })
    })
}
