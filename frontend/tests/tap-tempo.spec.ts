import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Title', { exact: true }).fill('Measured tempo')
    await page.getByLabel('Artist', { exact: true }).fill('Tempo artist')
    await page.getByLabel('Lyrics', { exact: true }).fill('First line\nSecond line')
    await page.getByLabel('Song BPM', { exact: true }).fill('90')
    await page.getByLabel('Beats per bar', { exact: true }).fill('3')
    await page.getByRole('button', { name: 'Tap tempo', exact: true }).scrollIntoViewIfNeeded()
    await page.clock.install()
    await page.clock.pauseAt(new Date())
})

test('touch measures tempo offline and applies only BPM to the saved song', async ({
    page,
    context,
}) => {
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready
    })
    await context.setOffline(true)
    const tool = page.locator('.tap-tempo')
    const tap = tool.getByRole('button', { name: 'Tap tempo', exact: true })
    const apply = tool.getByRole('button', { name: 'Use this BPM' })
    await expect(apply).toBeDisabled()
    await tap.tap()
    await expect(apply).toBeDisabled()
    for (let i = 0; i < 3; i++) {
        await page.clock.runFor(500)
        await tap.tap()
    }
    await expect(tool.getByRole('status')).toHaveText('120 BPM')
    await expect(page.getByLabel('Song BPM', { exact: true })).toHaveValue('90')
    await apply.tap()
    await expect(page.getByLabel('Song BPM', { exact: true })).toHaveValue('120')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    // The click starts asynchronous IndexedDB writes; reload only after confirmation.
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByLabel('Song BPM', { exact: true })).toHaveValue('120')
    await expect(page.getByLabel('Beats per bar', { exact: true })).toHaveValue('3')
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Measured tempo')
    await expect(page.getByLabel('Artist', { exact: true })).toHaveValue('Tempo artist')
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue('First line\nSecond line')
    await expect(tool.getByRole('button', { name: 'Use this BPM' })).toBeDisabled()
})

test('an idle gap and backgrounding discard the measurement without editing the song', async ({
    page,
}) => {
    const tool = page.locator('.tap-tempo')
    const tap = tool.getByRole('button', { name: 'Tap tempo', exact: true })
    const apply = tool.getByRole('button', { name: 'Use this BPM' })
    await tap.click()
    await page.clock.runFor(500)
    await tap.click()
    await expect(tool.getByRole('status')).toHaveText('120 BPM')
    await page.clock.runFor(5000)
    await tap.click()
    await expect(apply).toBeDisabled()
    await page.clock.runFor(250)
    await tap.click()
    await expect(tool.getByRole('status')).toHaveText('240 BPM')
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true })
        document.dispatchEvent(new Event('visibilitychange'))
        Object.defineProperty(document, 'hidden', { configurable: true, value: false })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(apply).toBeDisabled()
    await tap.click()
    await expect(apply).toBeDisabled()
    await expect(page.getByLabel('Song BPM', { exact: true })).toHaveValue('90')
})

test('supports keyboard taps and keeps the applied BPM in an autosaved draft', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    const tool = page.locator('.tap-tempo')
    const tap = tool.getByRole('button', { name: 'Tap tempo', exact: true })
    await tap.focus()
    await tap.press('Space')
    await page.clock.runFor(400)
    await tap.press('Space')
    await expect(tool.getByRole('status')).toHaveText('150 BPM')
    await tap.press('Tab')
    const apply = tool.getByRole('button', { name: 'Use this BPM' })
    await expect(apply).toBeFocused()
    await apply.press('Enter')
    await expect(page.getByLabel('Song BPM', { exact: true })).toHaveValue('150')
    await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true)
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await page.getByRole('button', { name: 'Continue editing', exact: true }).click()
    await expect(page.getByLabel('Song BPM', { exact: true })).toHaveValue('150')
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue('First line\nSecond line')
})
