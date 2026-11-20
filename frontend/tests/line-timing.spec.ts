import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '+ New song', exact: true }).click()
    await page.getByLabel('Title', { exact: true }).fill('Line timing')
})

test('replaces duration units while preserving tempo, and keeps the draft after reload', async ({
    page,
}) => {
    const lyrics = page.getByLabel('Lyrics', { exact: true })
    await lyrics.fill('  [line tempo=80% bars=2] First\nLast')
    for (const [unit, value, expected] of [
        ['beats', '6', '[line tempo=80% beats=6] First\nLast'],
        ['bars', '1.5', '[line tempo=80% bars=1.5] First\nLast'],
    ]) {
        await lyrics.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(0, 0))
        await page.getByRole('button', { name: '+ Line timing', exact: true }).click()
        await page.getByLabel('Duration (optional)').fill(value!)
        await page.getByRole('combobox', { name: 'Unit', exact: true }).selectOption(unit!)
        await page.getByRole('button', { name: 'Insert', exact: true }).click()
        await expect(lyrics).toHaveValue(expected!)
    }
    // Changing only tempo keeps the current duration and its unit.
    await lyrics.fill('[line beats=6] First\nLast')
    await lyrics.evaluate((input: HTMLTextAreaElement) => input.setSelectionRange(0, 0))
    await page.getByRole('button', { name: '+ Line timing', exact: true }).click()
    await page.getByLabel('Tempo (optional)').fill('90')
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect(lyrics).toHaveValue('[line tempo=90 beats=6] First\nLast')
    await expect(page.getByText('Draft saved on device', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Continue editing', exact: true }).click()
    await expect(lyrics).toHaveValue('[line tempo=90 beats=6] First\nLast')
})

for (const unit of ['bars', 'beats']) {
    test(`wraps selected lines with ${unit} timing and retains the selection`, async ({ page }) => {
        const lyrics = page.getByLabel('Lyrics', { exact: true })
        await lyrics.fill('First\nSecond\nThird\nLast')
        await lyrics.evaluate((input: HTMLTextAreaElement) => {
            input.focus()
            input.setSelectionRange(6, 18)
        })
        await page.getByRole('button', { name: '+ Timing passage', exact: true }).click()
        await page.getByLabel('Tempo (optional)').fill('80%')
        await page.getByLabel('Duration (optional)').fill('4')
        await page.getByRole('combobox', { name: 'Unit', exact: true }).selectOption(unit)
        await page.getByRole('button', { name: 'Insert', exact: true }).click()
        await expect(lyrics).toHaveValue(
            `First\n[line tempo=80% ${unit}=4]\nSecond\nThird\n[/line]\nLast`,
        )
        expect(
            await lyrics.evaluate((input: HTMLTextAreaElement) =>
                input.value.slice(input.selectionStart, input.selectionEnd),
            ),
        ).toBe('Second\nThird')
        await expect(page.getByRole('alert')).toHaveCount(0)
    })
}

test('inserts a duration-only passage and prevents playback of invalid codes', async ({ page }) => {
    const lyrics = page.getByLabel('Lyrics', { exact: true })
    await lyrics.fill('First')
    await page.getByRole('button', { name: '+ Timing passage', exact: true }).click()
    await page.getByLabel('Duration (optional)').fill('6')
    await page.getByRole('combobox', { name: 'Unit', exact: true }).selectOption('beats')
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect(lyrics).toHaveValue('[line beats=6]\nFirst\n[/line]')
    for (const invalid of [
        '[line beats=6]\nFirst\n[/tempo]',
        '[line beats=6]\n[line bars=2]\nFirst\n[/line]',
        '[line beats=6 bars=2] First',
        '[line beats=0] First',
    ]) {
        await lyrics.fill(invalid)
        await expect(page.getByRole('alert')).toBeVisible()
        await expect(
            page.getByRole('button', { name: 'Open prompter', exact: true }),
        ).toBeDisabled()
    }
})

for (const movement of ['line', 'continuous']) {
    test(`reads six beats in ${movement} movement with three beats per bar`, async ({ page }) => {
        await page.clock.install({ time: new Date('2026-10-30T12:00:00Z') })
        await page
            .getByLabel('Lyrics', { exact: true })
            .fill('[line beats=6]\nFirst\nSecond\n[line bars=1] Third\n[/line]')
        await page.getByLabel('Beats per bar').fill('3')
        await page.getByLabel('Count-in beats (0 = off)').fill('0')
        await page.getByRole('combobox', { name: 'Movement', exact: true }).selectOption(movement)
        await page.getByRole('button', { name: 'Open prompter', exact: true }).click()
        await expect(page.locator('.lyric-row')).toHaveText(['First', 'Second', 'Third'])
        await page.clock.pauseAt(new Date('2026-10-30T12:01:00Z'))
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await page.clock.runFor(2900)
        await expect(page.locator('.lyric-row').nth(0)).toHaveClass(/active/)
        await page.clock.runFor(120)
        await expect(page.locator('.lyric-row').nth(1)).toHaveClass(/active/)
        await page.clock.runFor(3000)
        await expect(page.locator('.lyric-row').nth(2)).toHaveClass(/active/)
    })
}
