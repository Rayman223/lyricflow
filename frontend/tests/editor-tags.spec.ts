import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '+ New song', exact: true }).click()
    await page.getByLabel('Title', { exact: true }).fill('Contextual tags')
})

test('opens on hover beside the caret and inserts on the selected line', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 1000 })
    const lyrics = page.getByLabel('Lyrics', { exact: true })
    await lyrics.fill('First line\nSecond line\nThird line')
    await lyrics.focus()
    await lyrics.press('Home')
    await lyrics.press('ArrowUp')
    const trigger = page.getByRole('button', { name: 'Add a tag', exact: true })
    await expect(trigger).toBeVisible()
    const collapsed = await trigger.boundingBox()
    await trigger.hover()
    const options = page.getByRole('group', { name: 'Tag options' })
    await expect(options).toBeVisible()
    expect((await trigger.boundingBox())!.width).toBeGreaterThan(collapsed!.width)
    await options.getByRole('button', { name: 'Line timing', exact: true }).click()
    await page.getByLabel('Duration (optional)').fill('1.5')
    await page.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect(lyrics).toHaveValue('First line\n[line bars=1.5] Second line\nThird line')
    await expect(lyrics).toBeFocused()
})

test('touch opens the choices and preserves a multiline selection through the dialog', async ({
    page,
}) => {
    const lyrics = page.getByLabel('Lyrics', { exact: true })
    await lyrics.fill('First line\nSecond line\nThird line\nLast line')
    await lyrics.evaluate((element: HTMLTextAreaElement) => {
        element.focus()
        element.setSelectionRange(11, 34)
    })
    await page.getByRole('button', { name: 'Add a tag', exact: true }).tap()
    const options = page.getByRole('group', { name: 'Tag options' })
    await options.getByRole('button', { name: 'Timing passage', exact: true }).tap()
    await page.getByLabel('Tempo (optional)').fill('75%')
    await page.getByRole('button', { name: 'Insert', exact: true }).tap()
    await expect(lyrics).toHaveValue(
        'First line\n[tempo=75%]\nSecond line\nThird line\n[/tempo]\nLast line',
    )
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await page.getByRole('button', { name: 'Continue editing', exact: true }).click()
    await expect(lyrics).toHaveValue(
        'First line\n[tempo=75%]\nSecond line\nThird line\n[/tempo]\nLast line',
    )
})

test('supports keyboard choices, cancellation, escape and outside dismissal', async ({ page }) => {
    const lyrics = page.getByLabel('Lyrics', { exact: true })
    await lyrics.fill('First line\nSecond line')
    await lyrics.press('Home')
    await lyrics.press('Tab')
    const trigger = page.getByRole('button', { name: 'Add a tag', exact: true })
    await expect(trigger).toBeFocused()
    await trigger.press('Tab')
    await page
        .getByRole('group', { name: 'Tag options' })
        .getByRole('button', { name: 'Section', exact: true })
        .press('Enter')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(lyrics).toBeFocused()
    await lyrics.press('ArrowRight')
    await lyrics.press('Tab')
    await trigger.press('Escape')
    await expect(trigger).toBeHidden()
    await expect(lyrics).toBeFocused()
    await lyrics.press('ArrowRight')
    await expect(trigger).toBeVisible()
    await page.getByLabel('Title', { exact: true }).click()
    await expect(trigger).toBeHidden()
    await expect(lyrics).toHaveValue('First line\nSecond line')
})

test('keeps the popup within narrow screens after textarea scrolling and wrapped lines', async ({
    page,
}) => {
    await page.setViewportSize({ width: 360, height: 800 })
    const lyrics = page.getByLabel('Lyrics', { exact: true })
    await lyrics.fill(
        Array.from(
            { length: 40 },
            (_, i) => `Line ${i} with enough text to wrap across the narrow editor.`,
        ).join('\n'),
    )
    await lyrics.press('Control+End')
    await page.getByRole('button', { name: 'Add a tag', exact: true }).tap()
    const options = page.getByRole('group', { name: 'Tag options' })
    await expect(options).toBeInViewport({ ratio: 1 })
    const box = (await options.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(360)
    await options.getByRole('button', { name: 'Pause', exact: true }).tap()
    await page.getByRole('button', { name: 'Insert', exact: true }).tap()
    await expect(lyrics).toHaveValue(/Line 38[^]*\n\[pause beats=4\]\nLine 39/)
    await expect(lyrics).toBeFocused()
    // Flush the native scroll queued by focus/selection before the next keyboard action.
    await lyrics.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    await lyrics.press('ArrowLeft')
    await expect(page.getByRole('button', { name: 'Add a tag', exact: true })).toBeVisible()
    await lyrics.evaluate((element: HTMLTextAreaElement) => {
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
    })
    await expect(page.getByRole('button', { name: 'Add a tag', exact: true })).toBeHidden()
})

test('keeps tag choices and selection while the mobile viewport shrinks and pans', async ({
    page,
}) => {
    const lyrics = page.getByLabel('Lyrics', { exact: true })
    await lyrics.fill('First line\nSecond line\nThird line')
    await lyrics.evaluate((element: HTMLTextAreaElement) => {
        window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 80)
        element.setSelectionRange(11, 22)
    })
    await lyrics.press('ArrowLeft')
    await lyrics.press('Shift+End')
    const trigger = page.getByRole('button', { name: 'Add a tag', exact: true })
    await expect(trigger).toBeVisible()
    await trigger.tap()
    const options = page.getByRole('group', { name: 'Tag options' })
    await expect(options).toBeVisible()
    await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 60 })
        window.visualViewport!.dispatchEvent(new Event('resize'))
    })
    await expect(options).toBeHidden()
    await page.evaluate(() => {
        Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 400 })
        window.visualViewport!.dispatchEvent(new Event('resize'))
        Object.defineProperty(window.visualViewport!, 'offsetTop', {
            configurable: true,
            value: 40,
        })
        window.visualViewport!.dispatchEvent(new Event('scroll'))
    })
    await expect(options).toBeVisible()
    expect(
        await lyrics.evaluate((element: HTMLTextAreaElement) => [
            element.selectionStart,
            element.selectionEnd,
        ]),
    ).toEqual([11, 22])
    await options.getByRole('button', { name: 'Line timing', exact: true }).tap()
    await page.getByLabel('Duration (optional)').fill('2')
    await page.getByRole('button', { name: 'Insert', exact: true }).tap()
    await expect(lyrics).toHaveValue('First line\n[line bars=2] Second line\nThird line')
    await lyrics.press('Escape')
    // A selection event queued by insertion can arrive after Escape.
    await lyrics.dispatchEvent('select')
    await page.evaluate(() => window.visualViewport!.dispatchEvent(new Event('resize')))
    await expect(trigger).toBeHidden()
})

test('fits the expanded menu inside the visual viewport after pinch zoom', async ({
    page,
    context,
}) => {
    const lyrics = page.getByLabel('Lyrics', { exact: true })
    await lyrics.fill('First line\nSecond line\nThird line')
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2.5 })
    await lyrics.press('Home')
    // Playwright's tap hit test shifts layout coordinates under CDP pinch zoom.
    await page.getByRole('button', { name: 'Add a tag', exact: true }).dispatchEvent('click')
    const options = page.getByRole('group', { name: 'Tag options' })
    await expect(options).toBeVisible()
    const bounds = await options.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const viewport = window.visualViewport!
        return {
            left: box.left,
            right: box.right,
            viewportLeft: viewport.offsetLeft,
            viewportRight: viewport.offsetLeft + viewport.width,
        }
    })
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.viewportLeft)
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportRight)
})
