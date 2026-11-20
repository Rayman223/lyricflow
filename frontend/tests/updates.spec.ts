import { expect, test as base, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'

const test = base.extend<{ waitingUpdate: (page: Page) => Promise<string> }>({
    waitingUpdate: async ({}, use) => {
        const swPath = new URL('../../public/sw.js', import.meta.url)
        const original = readFileSync(swPath, 'utf8')
        try {
            await use(async (page) => {
                const version = crypto.randomUUID()
                writeFileSync(
                    swPath,
                    `${original}\nself.addEventListener('message', event => {
                    if (event.data === 'test-version') event.ports[0].postMessage('${version}')
                });\n`,
                )
                await page.evaluate(async () => {
                    await (await navigator.serviceWorker.ready).update()
                })
                await expect
                    .poll(() =>
                        page.evaluate(async () => !!(await navigator.serviceWorker.ready).waiting),
                    )
                    .toBe(true)
                await expect(
                    page.getByRole('button', { name: 'Update now', exact: true }),
                ).toBeVisible()
                return version
            })
        } finally {
            writeFileSync(swPath, original)
        }
    },
})

async function countLoads(page: Page) {
    await page.addInitScript(() => {
        sessionStorage.setItem(
            'test.loads',
            String(Number(sessionStorage.getItem('test.loads')) + 1),
        )
    })
}
async function loads(page: Page) {
    return duringReload(
        page.evaluate(() => Number(sessionStorage.getItem('test.loads'))),
        -1,
    )
}
async function controlled(page: Page) {
    await page.goto('/')
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
}
function duringReload<T>(result: Promise<T>, pending: T): Promise<T> {
    return result.catch((error: Error) => {
        if (error.message.includes('Execution context was destroyed')) return pending
        throw error
    })
}
async function version(page: Page) {
    return duringReload(
        page.evaluate(
            () =>
                new Promise<string>((resolve) => {
                    const channel = new MessageChannel()
                    const timer = setTimeout(() => {
                        channel.port1.close()
                        resolve('')
                    }, 1000)
                    channel.port1.onmessage = (event) => {
                        clearTimeout(timer)
                        channel.port1.close()
                        resolve(event.data)
                    }
                    navigator.serviceWorker.controller!.postMessage('test-version', [channel.port2])
                }),
        ),
        '',
    )
}
async function sample(page: Page) {
    await page.getByRole('button', { name: 'Try a sample' }).click()
    await page.getByLabel('Count-in beats (0 = off)').fill('0')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await expect(page.locator('.song-open')).toBeVisible()
}

// Withhold confirmation after the native transaction completes. This exposes the queued
// write without relying on runner speed or keeping an IndexedDB transaction alive artificially.
async function holdDrafts(page: Page) {
    await page.evaluate(() => {
        const listen = IDBTransaction.prototype.addEventListener
        const put = IDBObjectStore.prototype.put
        const drafts = new WeakSet<IDBTransaction>()
        ;(window as any).draftCompletions = []
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
            if (this.name === 'drafts') drafts.add(this.transaction)
            return put.apply(this, args)
        }
        IDBTransaction.prototype.addEventListener = function (
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
        ) {
            return listen.call(
                this,
                type,
                (event) => {
                    const complete = () =>
                        typeof listener === 'function'
                            ? listener.call(this, event)
                            : listener.handleEvent(event)
                    if (type === 'complete' && drafts.has(this))
                        (window as any).draftCompletions.push(complete)
                    else complete()
                },
                options,
            )
        }
        // Leave the newest edit queued until reload preparation flushes it.
        const schedule = window.setTimeout.bind(window)
        window.setTimeout = ((callback: TimerHandler, delay: number, ...args: unknown[]) =>
            schedule(callback, delay === 350 ? 60000 : delay, ...args)) as typeof window.setTimeout
    })
}

test('app update activates only on request, reloads each library once and preserves local data offline', async ({
    page,
    context,
    waitingUpdate,
}) => {
    await countLoads(page)
    await page.goto('/')
    await sample(page)
    // First installation itself leaves the page and editor session intact.
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready
    })
    expect(await loads(page)).toBe(1)
    await page.reload()
    await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    const snapshot = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve) => {
            const request = indexedDB.open('lyricflow')
            request.onsuccess = () => resolve(request.result)
        })
        const tx = db.transaction(['profiles', 'sync'], 'readwrite')
        tx.objectStore('profiles').put({ id: 'kept-profile', label: 'Kept profile' })
        const request = tx.objectStore('sync').getAll()
        const entries = await new Promise((resolve) => {
            request.onsuccess = () => resolve(request.result)
        })
        await new Promise((resolve) => {
            tx.oncomplete = resolve
        })
        db.close()
        return entries
    })
    const second = await context.newPage()
    await countLoads(second)
    // Simulate an existing tab that missed the waiting event: controllerchange must suffice.
    await second.addInitScript(() => {
        const listen = ServiceWorkerRegistration.prototype.addEventListener
        ServiceWorkerRegistration.prototype.addEventListener = function (
            this: ServiceWorkerRegistration,
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
        ) {
            if (type !== 'updatefound') return listen.call(this, type, listener, options)
        } as typeof listen
    })
    await second.goto('/')
    await expect(second.locator('.song-open')).toBeVisible()
    const expected = await waitingUpdate(page)
    const late = await context.newPage()
    await countLoads(late)
    await late.goto('/')
    await expect(late.getByRole('button', { name: 'Update now', exact: true })).toBeVisible()
    expect(await loads(page)).toBe(2)
    expect(await loads(second)).toBe(1)
    await page.setViewportSize({ width: 320, height: 700 })
    const banner = await page.locator('.pwa-message').boundingBox()
    expect(banner!.x).toBeGreaterThanOrEqual(0)
    expect(banner!.x + banner!.width).toBeLessThanOrEqual(320)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    // Repeated clicks in the same event turn cannot start duplicate reloads.
    await page
        .getByRole('button', { name: 'Update now', exact: true })
        .evaluate((button: HTMLButtonElement) => {
            button.click()
            button.click()
        })
    await expect.poll(() => loads(page)).toBe(3)
    await expect.poll(() => loads(second)).toBe(2)
    await expect.poll(() => loads(late)).toBe(2)
    await expect.poll(() => version(page)).toBe(expected)
    await expect.poll(() => version(second)).toBe(expected)
    await expect(page.locator('.song-open')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByLabel('Library on this device')).toContainText('Kept profile')
    expect(
        await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((resolve) => {
                const request = indexedDB.open('lyricflow')
                request.onsuccess = () => resolve(request.result)
            })
            const request = db.transaction('sync').objectStore('sync').getAll()
            const entries = await new Promise((resolve) => {
                request.onsuccess = () => resolve(request.result)
            })
            db.close()
            return entries
        }),
    ).toEqual(snapshot)
    await context.setOffline(true)
    await page.reload()
    await expect.poll(() => version(page)).toBe(expected)
    await expect(page.locator('.song-open')).toBeVisible()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await page.getByLabel('Lyrics', { exact: true }).inputValue()).toContain('light')
})

for (const initiator of ['library', 'editor']) {
    test(`app update from ${initiator} saves the latest editor input after a slow write, even with its banner dismissed`, async ({
        page,
        context,
        waitingUpdate,
    }) => {
        await controlled(page)
        const editor = await context.newPage()
        await countLoads(editor)
        await editor.goto('/')
        await editor.getByRole('button', { name: 'New song' }).click()
        const expected = await waitingUpdate(page)
        await expect(editor.getByRole('button', { name: 'Update now', exact: true })).toBeVisible()
        if (initiator === 'library')
            await editor
                .locator('.pwa-message')
                .getByRole('button', { name: 'Close', exact: true })
                .click()
        await holdDrafts(editor)
        await editor.getByLabel('Lyrics', { exact: true }).fill('Earlier edit')
        // pagehide flushes the earlier snapshot; the last edit stays queued behind it.
        await editor.evaluate(() => window.dispatchEvent(new Event('pagehide')))
        await expect
            .poll(() => editor.evaluate(() => (window as any).draftCompletions.length))
            .toBe(1)
        await editor
            .getByLabel('Lyrics', { exact: true })
            .fill('Latest words [invalid code retained]')
        await (initiator === 'library' ? page : editor)
            .getByRole('button', { name: 'Update now', exact: true })
            .click()
        await expect(editor.getByLabel('Lyrics', { exact: true })).toBeDisabled()
        expect(await loads(editor)).toBe(1)
        await editor.evaluate(() => (window as any).draftCompletions[0]())
        await expect
            .poll(() => editor.evaluate(() => (window as any).draftCompletions.length))
            .toBe(2)
        expect(await loads(editor)).toBe(1)
        await editor.evaluate(() => (window as any).draftCompletions[1]())
        await expect.poll(() => loads(editor)).toBe(2)
        await expect.poll(() => version(editor)).toBe(expected)
        await editor.getByRole('button', { name: 'Continue editing', exact: true }).click()
        await expect(editor.getByLabel('Lyrics', { exact: true })).toHaveValue(
            'Latest words [invalid code retained]',
        )
        expect(await loads(editor)).toBe(2)
    })
}

test('app update keeps a failed draft open and retries the same snapshot after storage recovers', async ({
    page,
    context,
    waitingUpdate,
}) => {
    await controlled(page)
    const editor = await context.newPage()
    await countLoads(editor)
    await editor.goto('/')
    await editor.getByRole('button', { name: 'New song' }).click()
    await editor.evaluate(() => {
        const put = IDBObjectStore.prototype.put
        ;(window as any).failDraft = true
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
            if (this.name === 'drafts' && (window as any).failDraft)
                throw new DOMException('Test full device', 'QuotaExceededError')
            return put.apply(this, args)
        }
    })
    await editor.getByLabel('Lyrics', { exact: true }).fill('Keep these words after failure')
    await expect(editor.getByRole('alert')).toContainText('Could not save on this device')
    const expected = await waitingUpdate(page)
    await page.getByRole('button', { name: 'Update now', exact: true }).click()
    await expect(editor.locator('.pwa-message')).toContainText('could not finish saving')
    await expect(editor.getByLabel('Lyrics', { exact: true })).toBeEnabled()
    await expect(editor.getByLabel('Lyrics', { exact: true })).toHaveValue(
        'Keep these words after failure',
    )
    expect(await loads(editor)).toBe(1)
    await editor.evaluate(() => {
        ;(window as any).failDraft = false
    })
    await editor.getByRole('button', { name: 'Update now', exact: true }).click()
    await expect.poll(() => loads(editor)).toBe(2)
    await expect.poll(() => version(editor)).toBe(expected)
    await editor.getByRole('button', { name: 'Continue editing', exact: true }).click()
    await expect(editor.getByLabel('Lyrics', { exact: true })).toHaveValue(
        'Keep these words after failure',
    )
})

test('app update preserves an account form until returning to the library', async ({
    page,
    context,
    waitingUpdate,
}) => {
    await controlled(page)
    const form = await context.newPage()
    await countLoads(form)
    await form.goto('/')
    await form.getByRole('button', { name: 'Account', exact: true }).click()
    await form.getByLabel('Email address', { exact: true }).fill('unfinished@example.test')
    const expected = await waitingUpdate(page)
    await expect(form.locator('.pwa-message')).toContainText('Return to your library')
    await expect(form.getByRole('button', { name: 'Update now', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Update now', exact: true }).click()
    await expect.poll(() => version(page)).toBe(expected)
    await expect(form.getByLabel('Email address', { exact: true })).toHaveValue(
        'unfinished@example.test',
    )
    expect(await loads(form)).toBe(1)
    await form.getByRole('button', { name: 'Back to library', exact: true }).click()
    await expect.poll(() => loads(form)).toBe(2)
    await expect.poll(() => version(form)).toBe(expected)
})

test('app update also saves an editor left uncontrolled since its first installation', async ({
    page,
    context,
    waitingUpdate,
}) => {
    await countLoads(page)
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('First visit draft')
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready
    })
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
    expect(await loads(page)).toBe(1)
    const library = await context.newPage()
    await library.goto('/')
    const expected = await waitingUpdate(library)
    await expect(page.getByRole('button', { name: 'Update now', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Update now', exact: true }).click()
    await expect.poll(() => loads(page)).toBe(2)
    await expect.poll(() => version(page)).toBe(expected)
    await page.getByRole('button', { name: 'Continue editing', exact: true }).click()
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue('First visit draft')
})

test('app update preserves account operations without waiting for an online synchronization', async ({
    page,
    waitingUpdate,
}) => {
    await countLoads(page)
    await controlled(page)
    const name = `update_${crypto.randomUUID().slice(0, 8)}`
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByRole('button', { name: 'Create a free account', exact: true }).click()
    await page.getByLabel('Public pseudonym', { exact: true }).fill(name)
    await page.getByLabel('Email address', { exact: true }).fill(`${name}@example.test`)
    await page.getByLabel('Password', { exact: true }).fill('A private password 123')
    await page.getByLabel('Confirm password', { exact: true }).fill('A private password 123')
    await page.getByRole('button', { name: 'Create a free account', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
    await expect(page.locator('.sync-status')).toContainText('Synced')
    // A settled access-refresh error must not permanently poison later update attempts.
    await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put
        ;(window as any).failProfileRefresh = true
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
            if (this.name === 'profiles' && (window as any).failProfileRefresh)
                throw new DOMException('Test profile storage failure', 'QuotaExceededError')
            return put.apply(this, args)
        }
        window.dispatchEvent(new Event('online'))
    })
    await expect(page.getByRole('alert')).toContainText('Could not save on this device')
    await page.evaluate(() => {
        ;(window as any).failProfileRefresh = false
    })
    let requests = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    await page.route('**/api/sync', async (route) => {
        requests++
        await held
        await route.abort().catch(() => {})
    })
    try {
        await sample(page)
        await expect.poll(() => requests).toBeGreaterThan(0)
        const profile = await page.getByLabel('Library on this device').inputValue()
        const readOperations = () =>
            page.evaluate(async (profile) => {
                const db = await new Promise<IDBDatabase>((resolve) => {
                    const request = indexedDB.open(`lyricflow.profile.${profile}`)
                    request.onsuccess = () => resolve(request.result)
                })
                const request = db.transaction('sync').objectStore('sync').getAll()
                const result = await new Promise((resolve) => {
                    request.onsuccess = () => resolve(request.result)
                })
                db.close()
                return result
            }, profile)
        const operations = await readOperations()
        expect(operations).toEqual(
            expect.arrayContaining([expect.objectContaining({ operation: expect.any(Object) })]),
        )
        const expected = await waitingUpdate(page)
        await page.getByRole('button', { name: 'Update now', exact: true }).click()
        await expect.poll(() => loads(page)).toBe(3)
        await expect.poll(() => version(page)).toBe(expected)
        await expect(page.getByLabel('Library on this device')).toHaveValue(profile)
        expect(await readOperations()).toEqual(operations)
        await expect(page.locator('.song-open')).toBeVisible()
    } finally {
        release()
    }
})
