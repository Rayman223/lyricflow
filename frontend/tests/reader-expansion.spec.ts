import { expect, test, type Page } from '@playwright/test'

async function openReader(page: Page, mode = 'line', countIn = '0', lyrics?: string) {
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page
        .getByLabel('Lyrics', { exact: true })
        .fill(lyrics ?? Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n'))
    await page.getByLabel('Count-in beats (0 = off)').fill(countIn)
    await page.getByLabel('Song BPM', { exact: true }).fill('60')
    if (mode === 'pixels')
        await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('pixels')
    else await page.getByLabel('Movement').selectOption(mode)
    await page.getByRole('button', { name: 'Open prompter' }).click()
}

async function height(page: Page) {
    return page.getByTestId('lyrics-viewport').evaluate((element) => element.clientHeight)
}

async function expectControls(page: Page) {
    for (const control of [
        page.getByRole('button', { name: 'Pause', exact: true }),
        page.getByRole('button', { name: 'Restart', exact: true }),
        page.getByRole('button', { name: '← Your library', exact: true }),
        page.getByRole('button', { name: /Switch to .* mode/ }),
        page.getByLabel('Song BPM', { exact: true }),
        page.getByLabel('Text size', { exact: true }),
    ]) {
        await expect(control).toBeInViewport({ ratio: 1 })
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

for (const [mode, width, screenHeight] of [
    ['line', 360, 800],
    ['continuous', 915, 412],
    ['pixels', 1440, 900],
] as const) {
    test(`${mode}: expands at ${width}px and restores the layout on pause and restart`, async ({
        page,
    }, testInfo) => {
        await page.setViewportSize({ width, height: screenHeight })
        await openReader(page, mode)
        const initial = await height(page)
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await expect.poll(() => height(page)).toBeGreaterThan(initial + 30)
        await expectControls(page)
        await expect(page.getByRole('button', { name: 'Share link', exact: true })).toHaveCount(0)
        await expect
            .poll(() =>
                page
                    .locator('.reader')
                    .evaluate((el) => el.getAnimations({ subtree: true }).length),
            )
            .toBe(0)
        await page.screenshot({ path: testInfo.outputPath('playing.png') })
        if (mode === 'pixels') {
            await expect(page.getByLabel('Pixels / second')).toBeInViewport({ ratio: 1 })
            await expect
                .poll(() => page.locator('.reader').evaluate((el) => el.clientWidth))
                .toBe(width)
        }
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Share link', exact: true })).toBeVisible()
        await expect.poll(() => height(page)).toBe(initial)
        await page.getByRole('button', { name: 'Resume', exact: true }).click()
        await expect.poll(() => height(page)).toBeGreaterThan(initial + 30)
        await page.getByRole('button', { name: 'Restart', exact: true }).click()
        await expect.poll(() => height(page)).toBe(initial)
        await expect(page.locator('.lyric-row.active')).toHaveText('Line 1')
    })
}

test('expands during count-in, restores on background pause and natural end', async ({ page }) => {
    await page.clock.install()
    await openReader(page, 'line', '4')
    const initial = await height(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('.count-overlay')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Share link', exact: true })).toHaveCount(0)
    await expect.poll(() => height(page)).toBeGreaterThan(initial + 30)
    const expanded = await height(page)
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Share link', exact: true })).toBeVisible()
    await expect(page.getByText(/Paused while the app was in the background/)).toBeVisible()
    await expect.poll(() => height(page)).toBeLessThan(expanded)
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await page.clock.runFor(4500)
    await page
        .getByRole('button', { name: 'Line 20', exact: true })
        .evaluate((el: HTMLElement) => el.click())
    await page.clock.runFor(4500)
    await expect(page.getByText('End of song', { exact: true })).toBeVisible()
    await expect.poll(() => height(page)).toBe(initial)
})

test('keeps the expanded layout through a timed wait and viewport rotation', async ({ page }) => {
    await page.clock.install()
    await openReader(page, 'continuous', '0', '[pause seconds=30]\nLine after wait')
    const initial = await height(page)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('.pause-row.active')).toContainText('Wait')
    await expect.poll(() => height(page)).toBeGreaterThan(initial + 30)
    await page.clock.runFor(1000)
    await page.setViewportSize({ width: 915, height: 412 })
    await expectControls(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await expectControls(page)
    await page.clock.runFor(1000)
    await expect(page.locator('.pause-row.active')).toContainText('Wait')
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByText('Paused', { exact: true })).toBeVisible()
})

test('animates expansion and restoration and respects reduced motion', async ({ page }) => {
    await openReader(page)
    const animations = () =>
        page
            .locator('.reader')
            .evaluate((el) =>
                el
                    .getAnimations({ subtree: true })
                    .some((animation) => Number(animation.effect?.getTiming().duration) > 0),
            )
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    expect(await animations()).toBe(true)
    await expect.poll(animations).toBe(false)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    expect(await animations()).toBe(true)
    await expect.poll(animations).toBe(false)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const initial = await height(page)
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    expect(await animations()).toBe(false)
    expect(await height(page)).toBeGreaterThan(initial + 30)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    expect(await animations()).toBe(false)
    expect(await height(page)).toBe(initial)
})

test('keeps the current wrapped lyric visible when pausing on a wide screen', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openReader(
        page,
        'line',
        '0',
        Array.from(
            { length: 20 },
            (_, i) => `Line ${i + 1}: ${'Words that wrap on the screen. '.repeat(6)}`,
        ).join('\n'),
    )
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect
        .poll(() =>
            page.locator('.reader').evaluate((el) => el.getAnimations({ subtree: true }).length),
        )
        .toBe(0)
    await page
        .locator('.lyric-row')
        .nth(15)
        .evaluate((el: HTMLElement) => el.click())
    const active = page.locator('.lyric-row.active')
    await expect(active).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect
        .poll(() =>
            page.locator('.reader').evaluate((el) => el.getAnimations({ subtree: true }).length),
        )
        .toBe(0)
    await expect(active).toBeInViewport({ ratio: 1 })
    const viewport = page.getByTestId('lyrics-viewport')
    const beforeBrowse = await viewport.evaluate((el) => el.scrollTop)
    const box = (await viewport.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -500)
    await expect
        .poll(() => viewport.evaluate((el) => el.scrollTop))
        .toBeLessThan(beforeBrowse - 100)
    const browsedTop = await viewport.evaluate((el) => el.scrollTop)
    await page.setViewportSize({ width: 1000, height: 900 })
    await expect
        .poll(() =>
            page.locator('.reader').evaluate((el) => el.getAnimations({ subtree: true }).length),
        )
        .toBe(0)
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(browsedTop)
})
