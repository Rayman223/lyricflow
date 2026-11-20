import { expect, test, type Page } from '@playwright/test'

async function openReader(page: Page, mode = 'line', lyrics?: string, countIn = '0') {
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page
        .getByLabel('Lyrics', { exact: true })
        .fill(lyrics ?? Array.from({ length: 30 }, (_, i) => `Lyric number ${i + 1}`).join('\n'))
    await page.getByLabel('Count-in beats (0 = off)').fill(countIn)
    await page.getByLabel('Song BPM', { exact: true }).fill('60')
    if (mode === 'pixels') {
        await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('pixels')
        await page.getByLabel('Pixels / second').fill('30')
    } else await page.getByLabel('Movement').selectOption(mode === 'line' ? 'line' : 'continuous')
    await page.getByRole('button', { name: 'Open prompter' }).click()
}

async function wheel(page: Page, delta: number) {
    const box = await page.getByTestId('lyrics-viewport').boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, delta)
}

for (const mode of ['line', 'continuous', 'pixels']) {
    test(`${mode}: browses at rest and resumes the suspended position`, async ({ page }) => {
        await page.clock.install()
        await openReader(page, mode)
        const viewport = page.getByTestId('lyrics-viewport')
        const top = () => viewport.evaluate((element) => element.scrollTop)
        await wheel(page, 700)
        await expect.poll(top).toBeGreaterThan(300)
        await expect(page.locator('.lyric-row.active')).toHaveText('Lyric number 1')
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await expect.poll(top).toBeLessThan(100)
        await page.clock.runFor(500)
        await wheel(page, 1000)
        await expect.poll(top).toBeLessThan(100)
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
        const pausedTop = await top()
        const progress = await page.getByRole('progressbar').getAttribute('aria-valuenow')
        await wheel(page, 10000)
        await expect(
            page.getByRole('button', { name: 'Lyric number 30', exact: true }),
        ).toBeInViewport()
        await page.clock.runFor(1500)
        await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', progress!)
        await expect(page.locator('.lyric-row.active')).toHaveText('Lyric number 1')
        await page.getByRole('button', { name: 'Resume', exact: true }).click()
        await expect.poll(top).toBeLessThan(pausedTop + 100)
        await expect(page.locator('.lyric-row.active')).toHaveText('Lyric number 1')
        await page.getByRole('button', { name: 'Pause', exact: true }).click()
        await viewport.focus()
        await page.keyboard.press('End')
        await expect(
            page.getByRole('button', { name: 'Lyric number 30', exact: true }),
        ).toBeInViewport()
        await page.getByRole('button', { name: 'Lyric number 30', exact: true }).click()
        await expect(page.locator('.lyric-row.active')).toHaveText('Lyric number 30')
        await page.getByRole('button', { name: 'Resume', exact: true }).click()
        await page.clock.runFor(15000)
        await expect(page.getByText('End of song', { exact: true })).toBeVisible()
        await viewport.focus()
        await page.keyboard.press('Home')
        await expect(
            page.getByRole('button', { name: 'Lyric number 1', exact: true }),
        ).toBeInViewport()
        await page.getByRole('button', { name: 'Restart', exact: true }).click()
        await expect.poll(top).toBeLessThan(100)
        await expect(page.locator('.lyric-row.active')).toHaveText('Lyric number 1')
    })
}

for (const mode of ['continuous', 'pixels']) {
    for (const width of [390, 915]) {
        test(`${mode} at ${width}px: continues moving through the final lyric's remaining duration`, async ({
            page,
        }) => {
            await page.clock.install({ time: new Date('2026-10-19T12:00:00Z') })
            await page.setViewportSize({ width, height: width === 390 ? 844 : 412 })
            await openReader(page, mode, 'Final lyric')
            // Advance playback only through runFor, independent of runner speed.
            await page.clock.pauseAt(new Date('2026-10-19T12:01:00Z'))
            const distance = await page
                .locator('.lyric-row')
                .evaluate((row) => row.clientHeight + 24)
            const duration = mode === 'pixels' ? (distance / 30) * 1000 : 4000
            await page.getByRole('button', { name: 'Start', exact: true }).click()
            await page.clock.runFor(duration * 0.8)
            const before = await page
                .getByTestId('lyrics-viewport')
                .evaluate((element) => element.scrollTop)
            await page.clock.runFor(duration * 0.1)
            const after = await page
                .getByTestId('lyrics-viewport')
                .evaluate((element) => element.scrollTop)
            expect(after - before).toBeGreaterThan(distance * 0.07)
            await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
        })
    }
}

test('locks manual scrolling during count-in and timed musical waits', async ({ page }) => {
    await page.clock.install()
    await openReader(
        page,
        'continuous',
        '[pause seconds=30]\n' + Array.from({ length: 20 }, (_, i) => `Line ${i}`).join('\n'),
        '4',
    )
    const viewport = page.getByTestId('lyrics-viewport')
    const top = () => viewport.evaluate((element) => element.scrollTop)
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('.count-overlay')).toBeVisible()
    const countingTop = await top()
    await wheel(page, 600)
    await page.clock.runFor(300)
    expect(await top()).toBe(countingTop)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await wheel(page, 600)
    await expect.poll(top).toBeGreaterThan(countingTop + 100)
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect.poll(top).toBe(countingTop)
    await page.clock.runFor(4500)
    await expect(page.locator('.pause-row')).toHaveClass(/active/)
    const waitingTop = await top()
    await wheel(page, 600)
    await viewport.focus()
    await page.keyboard.press('End')
    await page.clock.runFor(300)
    expect(await top()).toBe(waitingTop)
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
})

test('touch browses a tall lyric through resizing without changing the playback point', async ({
    page,
}) => {
    const longLine = 'A long lyric that keeps wrapping on this small screen. '.repeat(45)
    await openReader(page, 'line', `First\n${longLine}\nLast`)
    const viewport = page.getByTestId('lyrics-viewport')
    const top = () => viewport.evaluate((element) => element.scrollTop)
    const client = await page.context().newCDPSession(page)
    const swipe = async () => {
        const box = (await viewport.boundingBox())!
        const x = box.x + box.width / 2
        const y = box.y + box.height * 0.8
        await client.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x, y }],
        })
        for (let step = 1; step <= 10; step++) {
            await client.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [{ x, y: y - step * Math.min(22, box.height / 20) }],
            })
            // Give the compositor a frame between finger positions.
            await page.waitForTimeout(20)
        }
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    await swipe()
    await expect.poll(top).toBeGreaterThan(100)
    await expect(page.locator('.lyric-row.active')).toHaveText('First')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await swipe()
    await expect.poll(top).toBeLessThan(10)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await swipe()
    await expect.poll(top).toBeGreaterThan(100)
    await page.getByLabel('Text size', { exact: true }).fill('48')
    await page.getByLabel('Text size', { exact: true }).blur()
    await page.setViewportSize({ width: 915, height: 412 })
    await expect.poll(top).toBeGreaterThan(100)
    await expect(page.locator('.lyric-row.active')).toHaveText('First')
    await page.setViewportSize({ width: 390, height: 844 })
    await viewport.focus()
    await page.keyboard.press('End')
    await expect(page.getByRole('button', { name: 'Last', exact: true })).toBeInViewport()
    await page.keyboard.press('Home')
    await expect(page.getByRole('button', { name: 'First', exact: true })).toBeInViewport()
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect.poll(top).toBeLessThan(10)
    await expect(page.locator('.lyric-row.active')).toHaveText('First')
    await client.detach()
})
