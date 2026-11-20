import { expect, test } from '@playwright/test'

test('releases stale screen-lock requests when the reader is closed and reopened', async ({
    page,
}) => {
    await page.addInitScript(() => {
        const pending: ((lock: object) => void)[] = []
        const released: boolean[] = []
        ;(window as any).wakeTest = { pending, released }
        Object.defineProperty(navigator, 'wakeLock', {
            value: {
                request: () => new Promise((resolve) => pending.push(resolve)),
            },
        })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await page.getByRole('button', { name: '← Your library', exact: true }).click()
    await page.locator('.song-open').click()
    await page.evaluate(() => {
        const { pending, released } = (window as any).wakeTest
        pending.forEach((resolve: (lock: object) => void, index: number) => {
            released[index] = false
            resolve(
                Object.assign(new EventTarget(), {
                    release: async () => {
                        released[index] = true
                    },
                }),
            )
        })
    })
    await expect
        .poll(() => page.evaluate(() => (window as any).wakeTest.released))
        .toEqual([true, false])
    await page.getByRole('button', { name: '← Your library', exact: true }).click()
    await expect
        .poll(() => page.evaluate(() => (window as any).wakeTest.released))
        .toEqual([true, true])
})

test('keeps the screen awake before start, during pauses and after the end of the song', async ({
    page,
}) => {
    await page.addInitScript(() => {
        const locks: (EventTarget & { released: boolean; release: () => Promise<void> })[] = []
        ;(window as any).wakeTest = { locks }
        Object.defineProperty(navigator, 'wakeLock', {
            value: {
                request: async () => {
                    const lock = Object.assign(new EventTarget(), {
                        released: false,
                        release: async () => {
                            lock.released = true
                            lock.dispatchEvent(new Event('release'))
                        },
                    })
                    locks.push(lock)
                    return lock
                },
            },
        })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('One short line')
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await expect(page.getByText('Screen kept awake', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('Screen kept awake', { exact: true })).toBeHidden()
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(page.getByText('Screen kept awake', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as any).wakeTest.locks[0].released)).toBe(false)
    await page.getByRole('button', { name: 'Restart', exact: true }).click()
    await page.getByLabel('Song BPM', { exact: true }).fill('1000')
    await page.getByLabel('Song BPM', { exact: true }).dispatchEvent('change')
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.getByText('End of song', { exact: true })).toBeVisible()
    await expect(page.getByText('Screen kept awake', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as any).wakeTest.locks.length)).toBe(1)
    await page.getByRole('button', { name: '← Your library', exact: true }).click()
    expect(await page.evaluate(() => (window as any).wakeTest.locks[0].released)).toBe(true)
})

test('reports a denied screen lock and allows retrying without starting playback', async ({
    page,
}) => {
    await page.addInitScript(() => {
        let attempts = 0
        Object.defineProperty(navigator, 'wakeLock', {
            value: {
                request: async () => {
                    if (++attempts === 1) throw new DOMException('Denied', 'NotAllowedError')
                    return Object.assign(new EventTarget(), { release: async () => {} })
                },
            },
        })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await expect(page.getByText(/Screen lock unavailable/)).toBeVisible()
    await page.getByRole('button', { name: 'Keep screen awake', exact: true }).click()
    await expect(page.getByText('Screen kept awake', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
})

test('reacquires the screen lock on foreground return while leaving playback paused', async ({
    page,
}) => {
    await page.addInitScript(() => {
        const locks: any[] = []
        ;(window as any).wakeTest = { locks }
        Object.defineProperty(navigator, 'wakeLock', {
            value: {
                request: async () => {
                    const lock = Object.assign(new EventTarget(), {
                        released: false,
                        release: async () => {
                            lock.released = true
                            lock.dispatchEvent(new Event('release'))
                        },
                    })
                    locks.push(lock)
                    return lock
                },
            },
        })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect
        .poll(() => page.evaluate(() => (window as any).wakeTest.locks[0].released))
        .toBe(true)
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page.getByText('Screen kept awake', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
    expect(await page.evaluate(() => (window as any).wakeTest.locks.length)).toBe(2)
})

test('allows retrying a screen lock released during playback', async ({ page }) => {
    await page.addInitScript(() => {
        const locks: EventTarget[] = []
        Object.assign(window, { wakeLocks: locks })
        Object.defineProperty(navigator, 'wakeLock', {
            value: {
                request: async () => {
                    const lock = Object.assign(new EventTarget(), {
                        release: async () => lock.dispatchEvent(new Event('release')),
                    })
                    locks.push(lock)
                    return lock
                },
            },
        })
    })
    await page.setViewportSize({ width: 320, height: 640 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await expect(page.getByText('Screen kept awake', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.evaluate(() => (window as any).wakeLocks[0].release())
    const retry = page.getByRole('button', { name: 'Keep screen awake', exact: true })
    await expect(retry).toBeInViewport({ ratio: 1 })
    await expect(retry).toHaveAttribute('title', /browser released the screen lock/)
    await expect(page.locator('.reader-controls .wake-status')).toBeHidden()
    await retry.click()
    await expect(retry).toBeHidden()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeInViewport()
    expect(await page.evaluate(() => (window as any).wakeLocks.length)).toBe(2)
})

test('fits a narrow phone, landscape and tablet without horizontal overflow', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '/tmp/lyricflow-library.png', fullPage: true })
    await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    await page.locator('.song-open').click()
    await page.screenshot({ path: '/tmp/lyricflow-prompter.png' })
    for (const viewport of [
        { width: 360, height: 800 },
        { width: 915, height: 412 },
        { width: 820, height: 1180 },
    ]) {
        await page.setViewportSize(viewport)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        )
        await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeInViewport()
    }
})
