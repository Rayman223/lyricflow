import { expect, test, type Page, type BrowserContext } from '@playwright/test'

const lyrics = 'Public first line\n[pause beats=2]\nPublic second line'
async function register(context: BrowserContext, prefix = 'links') {
    const name = `${prefix}_${crypto.randomUUID().slice(0, 8)}`
    const session = await (await context.request.get('/api/session')).json()
    const response = await context.request.post('/api/register', {
        headers: { 'X-CSRF-TOKEN': session.csrfToken },
        data: {
            pseudonym: name,
            email: `${name}@example.test`,
            password: 'A private password 123',
            password_confirmation: 'A private password 123',
        },
    })
    expect(response.ok()).toBe(true)
    return name
}
async function mutate(context: BrowserContext, path: string, data: Record<string, unknown>) {
    const session = await (await context.request.get('/api/session')).json()
    const response = await context.request.post(path, {
        headers: { 'X-CSRF-TOKEN': session.csrfToken },
        data: { accountId: session.user?.id, ...data },
    })
    expect(response.ok()).toBe(true)
    return response.json()
}
async function activate(page: Page) {
    await page.goto('/')
    const session = await (await page.request.get('/api/session')).json()
    if (session.user) {
        await expect(
            page.getByRole('option', { name: session.user.pseudonym, exact: true }),
        ).toBeAttached()
        await page
            .getByRole('combobox', { name: 'Library on this device', exact: true })
            .selectOption(session.user.id)
        await expect(page.getByText('Loading library…', { exact: true })).toHaveCount(0)
    }
}
async function create(page: Page, source = lyrics) {
    await activate(page)
    await page.getByRole('button', { name: '+ New song', exact: true }).click()
    await page.getByLabel('Title', { exact: true }).fill('A direct shared song')
    await page.getByLabel('Artist', { exact: true }).fill('Link test band')
    await page.getByLabel('Lyrics', { exact: true }).fill(source)
    await page.getByRole('button', { name: 'Open prompter', exact: true }).click()
}
async function publish(page: Page) {
    await page.getByRole('button', { name: 'Share link', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Public preview' })).toBeVisible()
    await page
        .getByLabel(
            'I understand how sharing and private copies work, and confirm that I can share this content.',
            { exact: true },
        )
        .check()
    await page.getByRole('button', { name: 'Publish this version', exact: true }).click()
    await expect(page.getByText('Publication saved · V.1.', { exact: true })).toBeVisible()
    return (await (await page.request.get('/api/community/mine')).json()).publications[0]
}
async function clipboard(page: Page, reject = false) {
    await page.addInitScript((reject) => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: async (value: string) => {
                    if (reject) throw new Error('Clipboard refused')
                    ;(window as any).copiedLink = value
                },
            },
        })
    }, reject)
}

test('publishes from the reader, copies a stable link and opens the latest public music anonymously', async ({
    page,
    context,
    browser,
    baseURL,
}) => {
    await clipboard(page)
    await register(context)
    await create(page)
    const publication = await publish(page)
    await page.getByRole('button', { name: 'Share link', exact: true }).click()
    const url = `${baseURL}/#song=${publication.id}`
    await expect.poll(() => page.evaluate(() => (window as any).copiedLink)).toBe(url)
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await expect(page.locator('.reader')).toBeVisible()
    await page.getByRole('button', { name: 'Share link', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Link copied.' })).toBeVisible()

    const guest = await browser.newContext({ baseURL })
    const viewer = await guest.newPage()
    try {
        await viewer.goto(url)
        await expect(viewer.locator('.lyric-row').first()).toHaveText('Public first line')
        await expect(viewer.getByRole('button', { name: 'Start', exact: true })).toBeVisible()
        expect(await viewer.evaluate(async () => (await indexedDB.databases()).length)).toBe(0)
        await viewer.getByLabel('Song BPM', { exact: true }).fill('95')
        await viewer.getByLabel('Song BPM', { exact: true }).blur()
        await viewer.reload()
        await expect(viewer.getByLabel('Song BPM', { exact: true })).toHaveValue('120')
        const changed = { ...publication.content, lyrics: 'New public revision' }
        await mutate(context, '/api/community/publish', {
            localSongId: publication.localSongId,
            expectedRevision: 1,
            content: changed,
            sharingAccepted: true,
        })
        await viewer.reload()
        await expect(viewer.locator('.lyric-row')).toHaveText('New public revision')
        const cached = await viewer.evaluate(async () => {
            const urls: string[] = []
            for (const key of await caches.keys())
                for (const request of await (await caches.open(key)).keys()) urls.push(request.url)
            return urls
        })
        expect(cached.some((url) => url.includes('/api/'))).toBe(false)
        await viewer.getByRole('button', { name: '← Your library', exact: true }).click()
        await expect(
            viewer.getByRole('heading', { name: 'Your library', exact: true }),
        ).toBeVisible()
        await expect(viewer.locator('.song-card')).toHaveCount(0)
        expect(new URL(viewer.url()).hash).toBe('')
        await mutate(context, `/api/community/publications/${publication.id}/unpublish`, {
            expectedRevision: 2,
        })
        await viewer.goto(url)
        await expect(viewer.getByRole('alert')).toContainText('This shared song is unavailable.')
    } finally {
        await guest.close()
    }
})

test('offers public link or explicit publication when private saved changes differ', async ({
    page,
    context,
}) => {
    await clipboard(page)
    await register(context)
    await create(page)
    const publication = await publish(page)
    await mutate(context, `/api/community/publications/${publication.id}/auto-share`, {
        enabled: false,
        expectedSharingVersion: publication.sharingVersion,
        operationId: crypto.randomUUID(),
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('Unpublished private changes')
    await page.getByRole('button', { name: 'Open prompter', exact: true }).click()
    await page.getByRole('button', { name: 'Share link', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Share link', exact: true })
    await expect(dialog).toContainText('The published version differs')
    await dialog.getByRole('button', { name: 'Copy public link', exact: true }).click()
    await expect
        .poll(() => page.evaluate(() => (window as any).copiedLink))
        .toContain(publication.id)
    expect(
        (await (await page.request.get(`/api/publications/${publication.id}/prompter`)).json())
            .publication.content.lyrics,
    ).toBe(lyrics)
    await page.getByRole('button', { name: 'Share link', exact: true }).click()
    await dialog.getByRole('button', { name: 'Share song', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Public preview' })).toBeVisible()
    await expect(
        page.getByLabel(
            'I understand how sharing and private copies work, and confirm that I can share this content.',
            { exact: true },
        ),
    ).not.toBeChecked()
})

test('keeps guest songs private and provides manual copying when clipboard is refused', async ({
    page,
    context,
    baseURL,
}) => {
    await clipboard(page, true)
    await create(page)
    await page.getByRole('button', { name: 'Share link', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Publish this song with an active account')
    expect((await (await context.request.get('/api/session')).json()).user).toBeNull()
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
    await register(context)
    await activate(page)
    await page.getByRole('button', { name: '+ New song', exact: true }).click()
    await page.getByLabel('Title', { exact: true }).fill('Published fallback song')
    await page.getByLabel('Lyrics', { exact: true }).fill(lyrics)
    await page.getByRole('button', { name: 'Open prompter', exact: true }).click()
    const publication = await publish(page)
    await page.goto(`${baseURL}/#song=${publication.id}`)
    await page.getByRole('button', { name: 'Share link', exact: true }).click()
    await expect(page.getByLabel('Copy this link manually')).toHaveValue(
        `${baseURL}/#song=${publication.id}`,
    )
})

test('a delayed clipboard failure cannot cover a running public reader', async ({
    page,
    context,
    baseURL,
}) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
            value: {
                writeText: () =>
                    new Promise<void>((_resolve, reject) => {
                        Object.assign(window, {
                            rejectClipboard: () => reject(new Error('Clipboard refused')),
                        })
                    }),
            },
        })
    })
    await register(context)
    await create(page)
    const publication = await publish(page)
    await page.goto(`${baseURL}/#song=${publication.id}`)
    const share = page.getByRole('button', { name: 'Share link', exact: true })
    await share.click()
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.evaluate(() => (window as any).rejectClipboard())
    const dialog = page.getByRole('dialog', { name: 'Share link' })
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(dialog).toBeHidden()
    await share.click()
    await page.evaluate(() => (window as any).rejectClipboard())
    await expect(page.getByLabel('Copy this link manually')).toHaveValue(
        `${baseURL}/#song=${publication.id}`,
    )
})

test('ignores delayed public loads after another link and after leaving the reader', async ({
    page,
    baseURL,
}) => {
    const first = crypto.randomUUID(),
        second = crypto.randomUUID()
    let release: () => void = () => {}
    let requested: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
        requested = resolve
    })
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    await page.route(`**/api/publications/${first}/prompter`, async (route) => {
        requested()
        await gate
        await route.fulfill({
            json: {
                publication: {
                    id: first,
                    revision: 1,
                    author: 'Test',
                    content: {
                        formatVersion: 1,
                        title: 'Old response',
                        artist: '',
                        lyrics: 'Must not appear',
                        music: { bpm: 120, beatsPerBar: 4, barsPerLine: 1 },
                    },
                },
            },
        })
    })
    await page.route(`**/api/publications/${second}/prompter`, (route) =>
        route.fulfill({ status: 404, json: {} }),
    )
    await page.goto(`${baseURL}/#song=${first}`)
    await pending
    await page.evaluate((id) => {
        location.hash = `song=${id}`
    }, second)
    await expect(page.getByRole('alert')).toContainText('This shared song is unavailable.')
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    release()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
    await expect(page.locator('.reader')).toHaveCount(0)
    await expect(page.getByText('Must not appear', { exact: true })).toHaveCount(0)
})

test('shares the source of a private copy and publishes customized copies only after consent', async ({
    page,
    context,
    browser,
    baseURL,
}) => {
    const owner = await register(context)
    await create(page)
    const publication = await publish(page)
    const reader = await browser.newContext({ baseURL })
    const copyPage = await reader.newPage()
    try {
        await clipboard(copyPage)
        await register(reader, 'copylinks')
        await activate(copyPage)
        await copyPage.getByRole('button', { name: 'Community', exact: true }).click()
        await copyPage
            .getByLabel('Search by title or artist', { exact: true })
            .fill('A direct shared song')
        await copyPage.getByRole('button', { name: 'Search', exact: true }).click()
        await copyPage
            .getByRole('button', { name: 'A direct shared song · Link test band', exact: true })
            .click()
        await copyPage.getByRole('button', { name: new RegExp(`^${owner} · V\\.`) }).click()
        await copyPage.getByRole('button', { name: 'Save a private copy', exact: true }).click()
        await copyPage.locator('.song-open').click()
        await copyPage.getByRole('button', { name: 'Share link', exact: true }).click()
        await expect
            .poll(() => copyPage.evaluate(() => (window as any).copiedLink))
            .toBe(`${baseURL}/#song=${publication.id}`)
        expect(
            (await (await reader.request.get('/api/community/mine')).json()).publications,
        ).toHaveLength(0)
        await copyPage.getByRole('button', { name: '← Your library', exact: true }).click()
        await copyPage.getByRole('button', { name: 'Edit', exact: true }).click()
        await copyPage.getByLabel('Lyrics', { exact: true }).fill('My private adaptation')
        await copyPage.getByRole('button', { name: 'Open prompter', exact: true }).click()
        await copyPage.getByRole('button', { name: 'Share link', exact: true }).click()
        await expect(copyPage.getByRole('dialog')).toContainText('The published version differs')
        await copyPage
            .getByRole('dialog')
            .getByRole('button', { name: 'Share song', exact: true })
            .click()
        await copyPage
            .getByLabel(
                'I understand how sharing and private copies work, and confirm that I can share this content.',
                { exact: true },
            )
            .check()
        await copyPage.getByRole('button', { name: 'Publish this version', exact: true }).click()
        await expect(copyPage.getByText('Publication saved · V.1.', { exact: true })).toBeVisible()
        const own = (await (await reader.request.get('/api/community/mine')).json()).publications[0]
        expect(own.source.publicationId).toBe(publication.id)
        expect(own.id).not.toBe(publication.id)
    } finally {
        await reader.close()
    }
})

test('discards sharing information delayed across an account change', async ({
    page,
    context,
    browser,
    baseURL,
}) => {
    await clipboard(page)
    await register(context)
    await create(page)
    await publish(page)
    const replacement = await browser.newContext({ baseURL })
    const name = await register(replacement, 'newlinks')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    let intercepted: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
        intercepted = resolve
    })
    await page.route('**/api/community/mine?songId=*', async (route) => {
        const response = await route.fetch()
        intercepted()
        await gate
        await route.fulfill({ response })
    })
    try {
        await page.getByRole('button', { name: 'Back to library', exact: true }).click()
        await pending
        await mutate(context, '/api/logout', {})
        await mutate(context, '/api/login', {
            email: `${name}@example.test`,
            password: 'A private password 123',
        })
        await page.evaluate(() => window.dispatchEvent(new Event('online')))
        await expect(page.getByRole('button', { name: 'Share link', exact: true })).toBeEnabled()
        release()
        await page.getByRole('button', { name: 'Share link', exact: true }).click()
        await expect(page.getByRole('dialog')).toContainText(
            'Publish this song with an active account',
        )
        expect(await page.evaluate(() => (window as any).copiedLink)).toBeUndefined()
    } finally {
        release()
        await replacement.close()
    }
})

for (const failDraft of [false, true]) {
    test(`preserves editor drafts before opening a shared link${failDraft ? ' after storage recovers' : ''}`, async ({
        page,
    }) => {
        const id = crypto.randomUUID()
        await page.route(`**/api/publications/${id}/prompter`, (route) =>
            route.fulfill({
                json: {
                    publication: {
                        id,
                        revision: 1,
                        author: 'Test',
                        content: {
                            formatVersion: 1,
                            title: 'Shared reader',
                            artist: '',
                            lyrics: 'Public music',
                            music: { bpm: 120, beatsPerBar: 4, barsPerLine: 1 },
                        },
                    },
                },
            }),
        )
        await page.goto('/')
        await page.getByRole('button', { name: '+ New song', exact: true }).click()
        if (failDraft)
            await page.evaluate(() => {
                const put = IDBObjectStore.prototype.put
                ;(window as any).failDraft = true
                IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
                    if (this.name === 'drafts' && (window as any).failDraft)
                        throw new DOMException('Test full device', 'QuotaExceededError')
                    return put.apply(this, args)
                }
            })
        await page.getByLabel('Title', { exact: true }).fill('Unfinished private song')
        await page.getByLabel('Lyrics', { exact: true }).fill('Private draft to preserve')
        if (failDraft) page.once('dialog', (dialog) => dialog.dismiss())
        await page.evaluate((id) => {
            location.hash = `song=${id}`
        }, id)
        if (failDraft) {
            await expect.poll(() => page.evaluate(() => location.hash)).toBe('')
            await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue(
                'Private draft to preserve',
            )
            await page.evaluate(() => {
                ;(window as any).failDraft = false
            })
            await page.evaluate((id) => {
                location.hash = `song=${id}`
            }, id)
        }
        await expect(page.locator('.lyric-row')).toHaveText('Public music')
        await page.getByRole('button', { name: '← Your library', exact: true }).click()
        await page.getByRole('button', { name: 'Continue editing', exact: true }).click()
        await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue(
            'Private draft to preserve',
        )
    })
}

test('freezes the editor while a shared-link navigation waits for a draft write', async ({
    page,
}) => {
    const id = crypto.randomUUID()
    await page.route(`**/api/publications/${id}/prompter`, (route) =>
        route.fulfill({
            json: {
                publication: {
                    id,
                    revision: 1,
                    author: 'Test',
                    content: {
                        formatVersion: 1,
                        title: 'Shared reader',
                        artist: '',
                        lyrics: 'Public music',
                        music: { bpm: 120, beatsPerBar: 4, barsPerLine: 1 },
                    },
                },
            },
        }),
    )
    await page.goto('/')
    await page.getByRole('button', { name: '+ New song', exact: true }).click()
    await holdDraftWrites(page)
    await page.getByLabel('Lyrics', { exact: true }).fill('Private draft before navigation')
    await page.evaluate((id) => {
        location.hash = `song=${id}`
    }, id)
    await expect
        .poll(() => page.evaluate(() => (window as any).draftCompletions.length))
        .toBeGreaterThan(0)
    await expect(page.getByLabel('Lyrics', { exact: true })).toBeDisabled()
    await page.evaluate(() => {
        for (const complete of (window as any).draftCompletions.splice(0)) complete()
    })
    await expect(page.locator('.lyric-row')).toHaveText('Public music')
    await page.getByRole('button', { name: '← Your library', exact: true }).click()
    await page.getByRole('button', { name: 'Continue editing', exact: true }).click()
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue(
        'Private draft before navigation',
    )
})

async function holdDraftWrites(page: Page) {
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
    })
}

test('opens the shared reader after an already pending Save song finishes', async ({ page }) => {
    const id = crypto.randomUUID()
    await page.route(`**/api/publications/${id}/prompter`, (route) =>
        route.fulfill({
            json: {
                publication: {
                    id,
                    revision: 1,
                    author: 'Test',
                    content: {
                        formatVersion: 1,
                        title: 'Shared reader',
                        artist: '',
                        lyrics: 'Public music',
                        music: { bpm: 120, beatsPerBar: 4, barsPerLine: 1 },
                    },
                },
            },
        }),
    )
    await page.goto('/')
    await page.getByRole('button', { name: '+ New song', exact: true }).click()
    await holdDraftWrites(page)
    await page.getByLabel('Lyrics', { exact: true }).fill('Private song being saved')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await expect
        .poll(() => page.evaluate(() => (window as any).draftCompletions.length))
        .toBeGreaterThan(0)
    await page.evaluate((id) => {
        location.hash = `song=${id}`
    }, id)
    await page.evaluate(() => {
        for (const complete of (window as any).draftCompletions.splice(0)) complete()
    })
    await expect(page.locator('.lyric-row')).toHaveText('Public music')
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '← Your library', exact: true }).click()
    await expect(page.locator('.song-card')).toHaveCount(1)
})

test('publishes beat timing and line passages for anonymous playback', async ({
    page,
    context,
    browser,
    baseURL,
}) => {
    await register(context)
    await create(page, '[line tempo=80% beats=6]\nFirst\n[line bars=2] Second\n[/line]\nLast')
    const publication = await publish(page)
    const guest = await browser.newContext({ baseURL })
    const viewer = await guest.newPage()
    try {
        await viewer.clock.install({ time: new Date('2026-10-30T12:00:00Z') })
        const path = `/api/publications/${publication.id}/prompter`
        const legacy = await guest.request.get(path)
        expect(legacy.status()).toBe(409)
        expect((await legacy.json()).error).toBe('client_update_required')
        expect((await legacy.json()).publication).toBeUndefined()
        expect(legacy.headers()['cache-control']).toContain('no-store')
        const loading = viewer.waitForRequest((request) => new URL(request.url()).pathname === path)
        await viewer.goto(`/#song=${publication.id}`)
        expect((await loading).headers()['x-lyricflow-capabilities']).toBe('line-timing')
        await expect(viewer.locator('.lyric-row')).toHaveText(['First', 'Second', 'Last'])
        await expect(viewer.locator('.passage-bpm strong')).toHaveText('96')
        await viewer.clock.pauseAt(new Date('2026-10-30T12:01:00Z'))
        await viewer.getByRole('button', { name: 'Start', exact: true }).click()
        // Shared readers use the default four-beat count-in at the passage BPM.
        await viewer.clock.runFor(6200)
        await expect(viewer.locator('.lyric-row').nth(0)).toHaveClass(/active/)
        await viewer.clock.runFor(70)
        await expect(viewer.locator('.lyric-row').nth(1)).toHaveClass(/active/)
        await viewer.clock.runFor(5000)
        await expect(viewer.locator('.lyric-row').nth(2)).toHaveClass(/active/)
        await expect(viewer.locator('.passage-bpm strong')).toHaveText('120')
    } finally {
        await guest.close()
    }
})

test('shows an update message and prevents playback when timing capability is refused', async ({
    page,
}) => {
    const id = crypto.randomUUID()
    await page.route(`**/api/publications/${id}/prompter`, (route) =>
        route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'client_update_required', message: 'Update LyricFlow.' }),
        }),
    )
    await page.goto(`/#song=${id}`)
    await expect(page.getByRole('alert')).toHaveText(
        'Update LyricFlow to read this shared song with its timing indications.',
    )
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0)
    await expect(page.locator('.lyric-row')).toHaveCount(0)
})
