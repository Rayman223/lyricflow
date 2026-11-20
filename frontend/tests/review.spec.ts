import { expect, test, type Page } from '@playwright/test'

async function delayDraftAcknowledgements(page: Page) {
    await page.addInitScript(() => {
        const listen = IDBTransaction.prototype.addEventListener
        const put = IDBObjectStore.prototype.put
        const draftWrites = new WeakSet<IDBTransaction>()
        const songWrites = new WeakSet<IDBTransaction>()
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
            if (this.name === 'drafts') draftWrites.add(this.transaction)
            if (this.name === 'songs') songWrites.add(this.transaction)
            return put.apply(this, args)
        }
        ;(window as any).draftCompletions = []
        IDBTransaction.prototype.addEventListener = function (
            this: IDBTransaction,
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
        ) {
            if (
                type === 'complete' &&
                this.mode === 'readwrite' &&
                this.objectStoreNames.contains('drafts')
            ) {
                return listen.call(
                    this,
                    type,
                    (event) => {
                        const complete = () =>
                            typeof listener === 'function'
                                ? listener.call(this, event)
                                : listener.handleEvent(event)
                        if (draftWrites.has(this) && !songWrites.has(this))
                            (window as any).draftCompletions.push(complete)
                        else complete()
                    },
                    options,
                )
            }
            return listen.call(this, type, listener, options)
        } as typeof IDBTransaction.prototype.addEventListener
    })
}

test('does not mark a newer queued draft saved when an earlier write finishes', async ({
    page,
}) => {
    await page.clock.install()
    await delayDraftAcknowledgements(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('First edit')
    await page.clock.runFor(400)
    await expect.poll(() => page.evaluate(() => (window as any).draftCompletions.length)).toBe(1)
    await page.getByLabel('Lyrics', { exact: true }).fill('More recent edit')
    await page.clock.runFor(400)
    await page.evaluate(() => (window as any).draftCompletions[0]())
    await expect.poll(() => page.evaluate(() => (window as any).draftCompletions.length)).toBe(2)
    await expect(page.getByText('Saving draft…', { exact: true })).toBeVisible()
    await page.evaluate(() => (window as any).draftCompletions[1]())
    await expect(page.getByText('Draft saved on device', { exact: true })).toBeVisible()
})

for (const action of ['Save song', 'Back to library', 'LyricFlow']) {
    test(`protects pending lyrics while ${action} waits for a slow write`, async ({ page }) => {
        await page.clock.install()
        await delayDraftAcknowledgements(page)
        await page.goto('/')
        await page.getByRole('button', { name: 'New song' }).click()
        await page.getByLabel('Lyrics', { exact: true }).fill('Lyrics being saved')
        await page.clock.runFor(400)
        await expect
            .poll(() => page.evaluate(() => (window as any).draftCompletions.length))
            .toBe(1)
        await page
            .getByRole(action === 'LyricFlow' ? 'link' : 'button', { name: action, exact: true })
            .click()
        await expect(page.getByLabel('Lyrics', { exact: true })).toBeDisabled()
        await expect(page.getByRole('button', { name: 'Back to library' })).toBeDisabled()
        await page.evaluate(() => (window as any).draftCompletions[0]())
        await expect(page.getByRole('heading', { name: 'Your library' })).toBeVisible()
        await page
            .getByRole('button', {
                name: action === 'Save song' ? 'Edit' : 'Continue editing',
                exact: true,
            })
            .click()
        await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue('Lyrics being saved')
    })
}

test('pixel movement resumes smoothly after a pause followed by a section heading', async ({
    page,
}) => {
    await page.clock.install()
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page
        .getByLabel('Lyrics', { exact: true })
        .fill('First\n[pause seconds=5]\n[section=Chorus]\nLast')
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    await page.getByRole('combobox', { name: 'Speed', exact: true }).selectOption('pixels')
    await page.getByLabel('Pixels / second').fill('100')
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('.pause-row')).toHaveClass(/active/, { timeout: 4000 })
    // Pause displays the full duration; the progress bar retains the real position.
    const progress = Number(await page.getByRole('progressbar').getAttribute('aria-valuenow'))
    const remaining = 5 * (1 - progress / 100)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    const before = await page
        .getByTestId('lyrics-viewport')
        .evaluate((element) => element.scrollTop)
    await page.getByRole('button', { name: 'Resume', exact: true }).click()
    await page.clock.runFor((remaining + 0.12) * 1000)
    await expect(page.getByRole('button', { name: 'Last', exact: true })).toHaveClass(/active/)
    const after = await page.getByTestId('lyrics-viewport').evaluate((element) => element.scrollTop)
    expect(after - before).toBeGreaterThanOrEqual(0)
    expect(after - before).toBeLessThan(40)
})

test('reader timing changes keep an unfinished lyrics draft', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('Unfinished lyrics that must survive')
    await page.getByRole('button', { name: 'Back to library' }).click()
    await page.locator('.song-open').click()
    await page.getByLabel('Song BPM').fill('150')
    await page.getByLabel('Song BPM').blur()
    await page.getByRole('button', { name: 'Your library' }).click()
    // Hold the next library read to expose the editor's intermediate loading state.
    await page.evaluate(() => {
        const listen = IDBRequest.prototype.addEventListener
        IDBRequest.prototype.addEventListener = function (
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
        ) {
            if (
                type === 'success' &&
                this.source instanceof IDBObjectStore &&
                this.source.name === 'songs'
            ) {
                IDBRequest.prototype.addEventListener = listen
                return listen.call(
                    this,
                    type,
                    (event) => {
                        ;(window as any).finishEditorLoad = () =>
                            typeof listener === 'function'
                                ? listener.call(this, event)
                                : listener.handleEvent(event)
                    },
                    options,
                )
            }
            return listen.call(this, type, listener, options)
        }
    })
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect
        .poll(() => page.evaluate(() => typeof (window as any).finishEditorLoad))
        .toBe('function')
    await expect(page.getByTestId('lyrics-viewport')).toHaveCount(0)
    await page.evaluate(() => (window as any).finishEditorLoad())
    await expect(page.getByRole('textbox', { name: 'Lyrics', exact: true })).toHaveValue(
        'Unfinished lyrics that must survive',
    )
    await expect(page.getByLabel('Song BPM')).toHaveValue('150')
})

test('an unavailable audio device cannot block the visual count-in', async ({ page }) => {
    await page.addInitScript(() => {
        window.AudioContext = class {
            state = 'suspended'
            resume() {
                return new Promise(() => {})
            }
            close() {
                return Promise.resolve()
            }
        } as unknown as typeof AudioContext
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByLabel('Audible count-in').check()
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(page.locator('.count-overlay')).toBeVisible()
    await expect(page.locator('.count-overlay')).not.toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
})

test('shows the audio failure during the visual count-in', async ({ page }) => {
    await page.addInitScript(() => {
        window.AudioContext = class {
            constructor() {
                throw new Error('Audio is unavailable')
            }
        } as unknown as typeof AudioContext
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByLabel('Audible count-in').check()
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    const warning = page.getByText('Sound is unavailable. The visual count-in will continue.')
    await expect(warning).toBeVisible()
    await expect(warning).toHaveCSS('opacity', '1')
    await expect(page.locator('.count-overlay')).toBeVisible()
})

test('remeasures active rows even when the total track height stays the same', async ({ page }) => {
    await page.goto('/')
    await page.addStyleTag({
        content:
            '.lyric-row { height: 70px !important; } .lyric-row.active { height: 140px !important; }',
    })
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('First\nSecond')
    await page.getByRole('button', { name: 'Open prompter' }).click()
    await page.evaluate(
        () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
    )
    await page.getByRole('button', { name: 'Second', exact: true }).click({ force: true })
    await expect
        .poll(() =>
            page.evaluate(() => {
                const viewport = document.querySelector('.lyrics-viewport')!
                const row = document.querySelector('.lyric-row.active')!
                const anchor = Number.parseFloat(
                    getComputedStyle(document.querySelector('.reader')!).getPropertyValue(
                        '--reader-anchor',
                    ),
                )
                return Math.abs(
                    row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor,
                )
            }),
        )
        .toBeLessThan(1)
})

test('flushes a pending draft before the mobile page is hidden', async ({ page }) => {
    await page.addInitScript(() => {
        const schedule = window.setTimeout.bind(window)
        window.setTimeout = ((callback: TimerHandler, delay: number, ...args: unknown[]) =>
            schedule(callback, delay === 350 ? 60000 : delay, ...args)) as typeof window.setTimeout
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('Last words before leaving the app')
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page.getByText('Draft saved on device', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Continue editing' }).click()
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue(
        'Last words before leaving the app',
    )
})
