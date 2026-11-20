import { expect, test, type Page } from '@playwright/test'
import ensemble from '../../tests/fixtures/score.json' with { type: 'json' }
import { defaults, newSong } from '../src/domain/song'

async function seed(page: Page) {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'New song' })).toBeVisible()
    const song = {
        ...newSong(),
        title: 'Instrumental ensemble',
        settings: { ...defaults },
        arrangements: [structuredClone(ensemble)],
    }
    await page.evaluate(async (song) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open('lyricflow')
            r.onsuccess = () => resolve(r.result)
            r.onerror = () => reject(r.error)
        })
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('songs', 'readwrite')
            tx.objectStore('songs').put(song)
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
        })
        db.close()
    }, song)
    await page.reload()
    return song
}

test('creates visual scores, retains incomplete drafts and supports independent arrangements and undo', async ({
    page,
}) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Title', { exact: true }).fill('Visual score')
    await page.getByRole('button', { name: 'New arrangement' }).click()
    const workspace = page.getByRole('dialog', { name: 'Score workspace' })
    await expect(workspace).toBeVisible()
    await workspace.getByLabel('Arrangement name', { exact: true }).fill('Guitar study')
    await workspace.getByLabel('Arrangement tempo').click()
    await expect(workspace.getByRole('button', { name: 'Play / resume' })).toBeDisabled()
    await workspace.getByRole('button', { name: 'Append note', exact: true }).click()
    await workspace.getByRole('button', { name: 'Fill remaining time with rests' }).click()
    await expect(workspace.getByText('Musical errors')).toHaveCount(0)
    await workspace.getByRole('button', { name: 'Add measure', exact: true }).click()
    await expect(workspace.getByText(/Musical errors/)).toBeVisible()
    await workspace.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(workspace.getByText(/Musical errors/)).toHaveCount(0)
    await workspace.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect(workspace.getByText(/Musical errors/)).toBeVisible()
    await workspace.getByRole('button', { name: 'Back to song' }).click()
    await expect(page.getByText('Draft saved on device', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Continue editing', exact: true }).click()
    await expect(page.getByRole('button', { name: /Guitar study · 1 tracks/ })).toBeVisible()
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click()
    await expect(page.locator('.score-list-row')).toHaveCount(2)
    page.once('dialog', (d) => d.dismiss())
    await page.getByRole('button', { name: 'Delete arrangement', exact: true }).first().click()
    await expect(page.locator('.score-list-row')).toHaveCount(2)
    page.once('dialog', (d) => d.accept())
    await page.getByRole('button', { name: 'Delete arrangement', exact: true }).first().click()
    await expect(page.locator('.score-list-row')).toHaveCount(1)
    await expect(page.getByText('Draft saved on device', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: 'Continue editing', exact: true }).click()
    await expect(page.locator('.score-list-row')).toHaveCount(1)
})

test('renders and plays five tracks, separates visibility and sound, loops and resumes offline', async ({
    page,
    context,
}, testInfo) => {
    const failures: string[] = []
    page.on('pageerror', (e) => failures.push(e.message))
    await page.addInitScript(() => {
        const connect = AudioNode.prototype.connect
        ;(window as any).scoreMeters = []
        ;(window as any).scorePeak = 0
        // Sample every animation frame so short drum attacks cannot fall between
        // Playwright polling intervals. Reading peak consumes the collected window.
        const sample = () => {
            for (const meter of (window as any).scoreMeters as AnalyserNode[]) {
                if (meter.context.state !== 'running') continue
                const samples = new Float32Array(2048)
                meter.getFloatTimeDomainData(samples)
                ;(window as any).scorePeak = Math.max(
                    (window as any).scorePeak,
                    ...samples.map(Math.abs),
                )
            }
            requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
        AudioNode.prototype.connect = function (this: AudioNode, ...args: any[]) {
            if (args[0] instanceof AudioDestinationNode) {
                const analyser = this.context.createAnalyser()
                analyser.fftSize = 2048
                ;(window as any).scoreMeters.push(analyser)
                Reflect.apply(connect, analyser, args)
                return Reflect.apply(connect, this, [analyser])
            }
            return Reflect.apply(connect, this, args)
        } as typeof connect
    })
    const peak = () =>
        page.evaluate(() => {
            const value = (window as any).scorePeak as number
            ;(window as any).scorePeak = 0
            return value
        })
    await seed(page)
    await page.locator('.song-open').click()
    await page.getByRole('button', { name: /Ensemble · 5 tracks/ }).click()
    const workspace = page.getByRole('dialog', { name: 'Score workspace' })
    await expect(workspace.locator('.alpha-score svg').first()).toBeVisible()
    const play = workspace.getByRole('button', { name: 'Play / resume' })
    await expect(play).toBeEnabled({ timeout: 20000 })
    expect(await peak()).toBe(0)
    await play.click()
    await expect.poll(peak).toBeGreaterThan(0.00001)
    await workspace.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect.poll(peak).toBeLessThan(0.00001)
    await workspace.getByText('Visible tracks and sound', { exact: true }).click()
    const mix = workspace.locator('.score-mix-row')
    await expect(mix).toHaveCount(5)
    await mix.nth(0).getByLabel('Visible', { exact: true }).uncheck()
    await expect(mix.nth(0).getByLabel('Sound', { exact: true })).toBeChecked()
    await mix.nth(1).getByLabel('Sound', { exact: true }).uncheck()
    await mix.nth(2).getByLabel('Sound', { exact: true }).uncheck()
    await mix.nth(3).getByLabel('Sound', { exact: true }).uncheck()
    await mix.nth(0).getByLabel('Volume').fill('50')
    await mix.nth(0).getByLabel('Solo', { exact: true }).check()
    await mix.nth(0).getByLabel('Solo', { exact: true }).uncheck()
    // Check hidden guitar alone, then percussion alone, using real PCM output.
    await mix.nth(4).getByLabel('Sound', { exact: true }).uncheck()
    await workspace.getByRole('button', { name: 'Stop', exact: true }).click()
    await play.click()
    await expect.poll(peak).toBeGreaterThan(0.00001)
    await workspace.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect.poll(peak).toBeLessThan(0.00001)
    await mix.nth(4).getByLabel('Sound', { exact: true }).check()
    await mix.nth(0).getByLabel('Sound', { exact: true }).uncheck()
    await workspace.getByRole('button', { name: 'Stop', exact: true }).click()
    await play.click()
    await expect.poll(peak).toBeGreaterThan(0.00001)
    await workspace.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect.poll(peak).toBeLessThan(0.00001)
    await mix.nth(0).getByLabel('Sound', { exact: true }).check()

    await workspace.getByLabel('Play from measure').fill('2')
    await workspace.getByLabel('Through measure').fill('2')
    await workspace.getByLabel('Loop passage').check()
    await play.click()
    await expect(workspace.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await workspace.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(play).toBeVisible()
    await play.click()
    await expect(workspace.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.waitForTimeout(2300) // More than the selected 4/4 measure at 120 BPM.
    await expect(workspace.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await workspace.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(peak).toBeLessThan(0.00001)
    await workspace.getByText('Visible tracks and sound', { exact: true }).click()
    for (const width of [320, 820, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        expect(await workspace.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath(`score-${width}.png`) })
        await workspace
            .locator('.score-paper')
            .screenshot({ path: testInfo.outputPath(`notation-${width}.png`) })
    }
    await workspace.getByRole('button', { name: 'Back to song' }).click()
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready
    })
    await page.reload()
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
    const cached = await page.evaluate(async () =>
        (
            await Promise.all(
                (await caches.keys()).map(async (key) =>
                    (await (await caches.open(key)).keys()).map((r) => r.url),
                ),
            )
        ).flat(),
    )
    expect(cached.some((url) => new URL(url).pathname.endsWith('/soundfont/sonivox.sf2'))).toBe(
        true,
    )
    expect(cached.some((url) => /\/(api|auth)\//.test(new URL(url).pathname))).toBe(false)
    await context.setOffline(true)
    await page.reload()
    await page.locator('.song-open').click()
    await page.getByRole('button', { name: /Ensemble · 5 tracks/ }).click()
    await expect(page.getByRole('button', { name: 'Play / resume' })).toBeEnabled({
        timeout: 20000,
    })
    await page.getByRole('button', { name: 'Play / resume' }).click()
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to song', exact: true }).click()
    await expect.poll(peak).toBeLessThan(0.00001)
    expect(failures).toEqual([])
})

test('opens an instrumental public score without a private copy or IndexedDB', async ({ page }) => {
    const id = crypto.randomUUID()
    await page.route(`**/api/publications/${id}/prompter`, (route) =>
        route.fulfill({
            json: {
                publication: {
                    id,
                    revision: 1,
                    author: 'Musician',
                    content: {
                        formatVersion: 1,
                        title: 'Public instrumental',
                        artist: '',
                        lyrics: '',
                        music: { bpm: 120, beatsPerBar: 4, barsPerLine: 1 },
                        arrangements: [ensemble],
                    },
                },
            },
        }),
    )
    await page.goto(`/#song=${id}`)
    await page.getByRole('button', { name: /Ensemble · 5 tracks/ }).click()
    await expect(page.locator('.alpha-score svg').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Play / resume' })).toBeEnabled({
        timeout: 20000,
    })
    expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0)
})

test('keeps score edits visible after a device quota failure and retries the latest draft', async ({
    page,
}) => {
    await seed(page)
    await page.evaluate(() => {
        const put = IDBObjectStore.prototype.put
        ;(window as any).failScoreWrites = true
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
            if ((window as any).failScoreWrites && this.name === 'drafts')
                throw new DOMException('Device full', 'QuotaExceededError')
            return put.apply(this, args)
        }
    })
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: /Ensemble · 5 tracks/ }).click()
    const w = page.getByRole('dialog', { name: 'Score workspace' })
    await w.getByLabel('Arrangement tempo').fill('85')
    await w.getByLabel('Arrangement name', { exact: true }).click()
    await expect(w.getByRole('status').filter({ hasText: /Could not save/ })).toBeVisible()
    await expect(w.getByLabel('Arrangement tempo')).toHaveValue('85')
    await page.evaluate(() => {
        ;(window as any).failScoreWrites = false
    })
    await w.getByLabel('Arrangement tempo').fill('86')
    await w.getByLabel('Arrangement name', { exact: true }).click()
    await expect(w.getByText('Draft saved on device', { exact: true })).toBeVisible()
    await w.getByRole('button', { name: 'Back to song' }).click()
    await page.reload()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: /Ensemble · 5 tracks · 86 BPM/ }).click()
    await expect(page.getByLabel('Arrangement tempo')).toHaveValue('86')
})

async function memberSong(page: Page) {
    const request = page.context().request,
        name = `score_${crypto.randomUUID().slice(0, 8)}`
    const guest = await (await request.get('/api/session')).json()
    const registered = await request.post('/api/register', {
        headers: { 'X-CSRF-TOKEN': guest.csrfToken },
        data: {
            pseudonym: name,
            email: `${name}@example.test`,
            password: 'A private password 123',
            password_confirmation: 'A private password 123',
        },
    })
    expect(registered.ok()).toBe(true)
    const session = await (await request.get('/api/session')).json()
    const song = {
        ...newSong(),
        title: `Synced instrumental ${name}`,
        arrangements: [structuredClone(ensemble)],
    }
    const response = await request.post('/api/sync', {
        headers: { 'X-CSRF-TOKEN': session.csrfToken },
        data: {
            accountId: session.user.id,
            cursor: 0,
            operation: {
                id: crypto.randomUUID(),
                key: `song.${song.id}`,
                baseRevision: 0,
                value: { song, draft: null },
            },
        },
    })
    expect(response.ok()).toBe(true)
    await page.goto('/')
    await page
        .getByRole('combobox', { name: 'Library on this device' })
        .selectOption(session.user.id)
    await expect(page.locator('.song-open')).toHaveCount(1)
    return { session, song }
}
async function changeTempo(page: Page, tempo: number) {
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: /Ensemble · 5 tracks/ }).click()
    await page.getByLabel('Arrangement tempo').fill(String(tempo))
    await page.getByRole('button', { name: 'Back to song' }).click()
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    await expect(page.locator('.song-open')).toHaveCount(1)
}
async function sync(page: Page) {
    await page.getByRole('button', { name: 'Sync now', exact: true }).click()
    await expect(page.locator('.sync-status')).toContainText('Synced')
}
test('synchronizes two devices, preserves score conflicts and separates Guest', async ({
    page,
    browser,
    baseURL,
}) => {
    test.setTimeout(60000)
    const { session } = await memberSong(page)
    const second = await browser.newContext({
        baseURL,
        storageState: await page.context().storageState(),
    })
    try {
        const other = await second.newPage()
        await other.goto('/')
        await other
            .getByRole('combobox', { name: 'Library on this device' })
            .selectOption(session.user.id)
        await expect(other.locator('.song-open')).toHaveCount(1)
        await other.evaluate(async () => {
            await navigator.serviceWorker.ready
        })
        await other.reload()
        await expect
            .poll(() => other.evaluate(() => !!navigator.serviceWorker.controller))
            .toBe(true)
        await second.setOffline(true)
        await changeTempo(other, 85)
        await changeTempo(page, 90)
        await sync(page)
        await second.setOffline(false)
        await other.getByRole('button', { name: 'Sync now', exact: true }).click()
        await expect(
            other.getByRole('heading', { name: 'Choose a version', exact: true }),
        ).toBeVisible()
        await other.getByText('Compare song versions', { exact: true }).click()
        await expect(other.locator('.conflict-card')).toContainText('85 BPM')
        await expect(other.locator('.conflict-card')).toContainText('90 BPM')
        await other
            .getByRole('button', { name: 'Keep both as separate songs', exact: true })
            .click()
        await expect(other.locator('.song-open')).toHaveCount(2)
        await other.getByRole('combobox', { name: 'Library on this device' }).selectOption('guest')
        await expect(other.locator('.song-open')).toHaveCount(0)
    } finally {
        await second.close()
    }
})

test('publishes an instrumental, reads and copies it, and protects a private adaptation on revision update', async ({
    page,
    browser,
    baseURL,
}) => {
    test.setTimeout(60000)
    const { session, song } = await memberSong(page)
    await page.getByRole('button', { name: 'Share song', exact: true }).click()
    await page
        .getByLabel(
            'I understand how sharing and private copies work, and confirm that I can share this content.',
            { exact: true },
        )
        .check()
    await page.getByRole('button', { name: 'Publish this version', exact: true }).click()
    await expect(page.getByText('Publication saved · V.1.', { exact: true })).toBeVisible()
    const request = page.context().request,
        publication = (await (await request.get('/api/community/mine')).json()).publications[0]
    const guest = await browser.newContext({ baseURL })
    try {
        const viewer = await guest.newPage()
        await viewer.goto(`/#song=${publication.id}`)
        await viewer.getByRole('button', { name: /Ensemble · 5 tracks/ }).click()
        await expect(viewer.locator('.alpha-score svg').first()).toBeVisible()
        expect(await viewer.evaluate(async () => (await indexedDB.databases()).length)).toBe(0)
    } finally {
        await guest.close()
    }
    await page.getByRole('button', { name: 'Back to library', exact: true }).click()
    await page.getByRole('button', { name: 'Community', exact: true }).click()
    await page.getByLabel('Search by title or artist', { exact: true }).fill(song.title)
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(song.title) }).click()
    await page
        .getByRole('button', { name: / · V\.1$/ })
        .first()
        .click()
    await page.getByRole('button', { name: 'Save a private copy', exact: true }).click()
    await expect(page.locator('.song-open')).toHaveCount(2)
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    await page.getByRole('button', { name: /Ensemble · 5 tracks/ }).click()
    await page.getByLabel('Arrangement tempo').fill('80')
    await page.getByRole('button', { name: 'Back to song' }).click()
    await page.getByRole('button', { name: 'Save song', exact: true }).click()
    const content = {
        formatVersion: 1,
        title: song.title,
        artist: '',
        lyrics: '',
        music: { bpm: 120, beatsPerBar: 4, barsPerLine: 1 },
        arrangements: [{ ...ensemble, tempo: 100 }],
    }
    const response = await request.post('/api/community/publish', {
        headers: { 'X-CSRF-TOKEN': session.csrfToken },
        data: {
            accountId: session.user.id,
            localSongId: song.id,
            expectedRevision: 1,
            sharingAccepted: true,
            content,
        },
    })
    expect(response.ok()).toBe(true)
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await page.getByRole('button', { name: 'Update from source', exact: true }).click()
    await expect(
        page.getByText(
            'This copy has been customized. Keep it or download the new revision as another private copy.',
            { exact: true },
        ),
    ).toBeVisible()
})

test('edits piano chords and voices, bass tablature, drum triplets and passage copies on a tablet', async ({
    page,
}) => {
    await page.setViewportSize({ width: 820, height: 1180 })
    await seed(page)
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('button', { name: /Ensemble · 5 tracks/ }).click()
    const w = page.getByRole('dialog', { name: 'Score workspace' })
    await w
        .getByRole('combobox', { name: 'Selected track', exact: true })
        .selectOption({ value: '3' })
    await w
        .getByRole('combobox', { name: 'Note duration', exact: true })
        .selectOption({ value: '2' })
    await w.getByRole('button', { name: 'Apply rhythm to selected event' }).click()
    await w.getByRole('combobox', { name: 'Pitch', exact: true }).selectOption({ value: '4' })
    await w.getByRole('button', { name: 'Add note to selected chord' }).click()
    await w.getByRole('button', { name: 'Append rest', exact: true }).click()
    await expect(w.getByText(/Musical errors/)).toHaveCount(0)
    await w.getByRole('button', { name: 'Add voice', exact: true }).click()
    await expect(w.getByRole('combobox', { name: 'Voice', exact: true })).toHaveValue('1')
    await w.getByRole('button', { name: 'Fill remaining time with rests' }).click()
    await w.getByRole('combobox', { name: 'Measure', exact: true }).selectOption({ value: '1' })
    await expect(w.getByRole('combobox', { name: 'Measure', exact: true })).toHaveValue('1')
    await w.getByRole('combobox', { name: 'Voice', exact: true }).selectOption({ value: '1' })
    await expect(w.getByRole('combobox', { name: 'Voice', exact: true })).toHaveValue('1')
    await w.getByRole('button', { name: 'Fill remaining time with rests' }).click()
    await expect(w.getByText(/Musical errors/)).toHaveCount(0)
    await w
        .getByRole('combobox', { name: 'Selected track', exact: true })
        .selectOption({ value: '2' })
    await w.getByLabel('Fret', { exact: true }).fill('2')
    await w.getByRole('button', { name: 'Delete note', exact: true }).click()
    await w.getByRole('button', { name: 'Add note to selected chord' }).click()
    await expect(w.getByText(/Musical errors/)).toHaveCount(0)
    await w
        .getByRole('combobox', { name: 'Selected track', exact: true })
        .selectOption({ value: '4' })
    await w.getByRole('combobox', { name: 'Drum piece', exact: true }).selectOption({ value: '38' })
    await w.getByRole('button', { name: 'Delete note', exact: true }).click()
    await w.getByRole('button', { name: 'Add note to selected chord' }).click()
    await w
        .getByRole('combobox', { name: 'Note duration', exact: true })
        .selectOption({ value: '8' })
    await w.getByLabel('Triplet (3:2)', { exact: true }).check()
    await w.getByRole('button', { name: 'Apply rhythm to selected event' }).click()
    await w.getByRole('button', { name: 'Append note', exact: true }).click()
    await w.getByRole('button', { name: 'Append note', exact: true }).click()
    await w.getByRole('button', { name: 'Fill remaining time with rests' }).click()
    await expect(w.getByText(/Musical errors/)).toHaveCount(0)
    await w.getByLabel('Copy from measure', { exact: true }).fill('1')
    await w.getByLabel('Through measure', { exact: true }).first().fill('2')
    await w.getByRole('button', { name: 'Append passage copy' }).click()
    await expect(
        w.getByRole('combobox', { name: 'Measure', exact: true }).locator('option'),
    ).toHaveCount(4)
    await w.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(
        w.getByRole('combobox', { name: 'Measure', exact: true }).locator('option'),
    ).toHaveCount(2)
    await expect(w.getByText(/Musical errors/)).toHaveCount(0)
})
