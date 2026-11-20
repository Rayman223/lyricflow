import { expect, test, type Page } from '@playwright/test'

const support = () => ({
    year: 2026,
    goalCents: 26000,
    coveredCents: 6500,
    percent: 25,
    donationUrl: 'https://buy.stripe.com/test_lyricflow',
    automatic: true,
    supporters: [] as { pseudonym: string; since: string }[],
    viewer: null as null | {
        id: string
        supporter: boolean
        public: boolean
        listed: boolean
        admin: boolean
    },
})

async function supportSession(page: Page, data: ReturnType<typeof support>) {
    let reads = 0
    await page.route('**/api/session', async (route) => {
        reads++
        const viewer = data.viewer
        await route.fulfill({
            json: {
                enabled: true,
                googleEnabled: false,
                emailEnabled: false,
                googlePending: false,
                csrfToken: 'support-test-token',
                user: viewer
                    ? {
                          id: viewer.id,
                          pseudonym: viewer.id.endsWith('1') ? 'supporter_one' : 'supporter_two',
                          email: 'support@example.test',
                          verified: true,
                          hasPassword: true,
                          googleLinked: false,
                          role: viewer.admin ? 'admin' : 'member',
                          supporter: viewer.supporter,
                      }
                    : null,
            },
        })
    })
    return () => reads
}

test('opens the public support page, handles missing configuration and keeps the layout within a small screen', async ({
    page,
}) => {
    await page.goto('/')
    await page.locator('.app-footer').getByRole('link', { name: 'Support' }).click()
    await expect(page).toHaveURL('/support')
    await expect(page.getByRole('heading', { name: 'Keep the music flowing.' })).toBeVisible()
    await expect(page.getByText('€260.00', { exact: false })).toBeVisible()
    await expect(page.getByText('Donations will open soon.', { exact: false })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Donate with Stripe' })).toHaveCount(0)
    await page.goto('/support/')
    await expect(page.getByRole('heading', { name: 'Keep the music flowing.' })).toBeVisible()
    await page.setViewportSize({ width: 320, height: 800 })
    for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme
        }, theme)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
            true,
        )
        await page.screenshot({ path: `/tmp/lyricflow-support-${theme}.png`, fullPage: true })
    }
    await page.getByRole('link', { name: 'Back to library' }).click()
    await expect(page.getByRole('heading', { name: 'Your library' })).toBeVisible()
})

test('offers guest donations without granting a badge on a return URL and never caches support API responses', async ({
    page,
}) => {
    await page.route('**/api/support', (route) =>
        route.fulfill({ json: support(), headers: { 'Cache-Control': 'private, no-store' } }),
    )
    await page.goto('/support?donation=returned')
    const donate = page.getByRole('link', { name: 'Donate with Stripe' })
    await expect(donate).toHaveAttribute('href', 'https://buy.stripe.com/test_lyricflow')
    await expect(donate).toHaveAttribute('target', '_blank')
    await expect(donate).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(
        page.getByText('You can donate without an account.', { exact: false }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show my support on the wall' })).toHaveCount(0)
    await expect(page.getByRole('progressbar')).toHaveAttribute('value', '25')
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready
    })
    await page.reload()
    await expect(page.getByRole('link', { name: 'Donate with Stripe' })).toBeVisible()
    const cached = await page.evaluate(async () => {
        const stores = await Promise.all((await caches.keys()).map((key) => caches.open(key)))
        return (await Promise.all(stores.map((store) => store.keys())))
            .flat()
            .map((request) => new URL(request.url).pathname)
    })
    expect(cached.some((path) => path.startsWith('/api/'))).toBe(false)
})

test('lets a confirmed supporter choose and then hide their public presence without displaying amounts', async ({
    page,
}) => {
    const data = support()
    data.viewer = {
        id: '00000000-0000-4000-8000-000000000001',
        supporter: true,
        public: false,
        listed: false,
        admin: false,
    }
    await supportSession(page, data)
    await page.route('**/api/support', (route) => route.fulfill({ json: data }))
    await page.route('**/api/support/visibility', async (route) => {
        const body = route.request().postDataJSON()
        expect(body.accountId).toBe(data.viewer!.id)
        data.viewer!.public = body.public
        data.viewer!.listed = body.public
        data.supporters = body.public ? [{ pseudonym: 'music_supporter', since: '2026-10-31' }] : []
        await route.fulfill({ json: { saved: true } })
    })
    await page.goto('/support')
    await page.getByRole('button', { name: 'Show my support on the wall' }).click()
    const wall = page.locator('.support-wall')
    await expect(wall.getByText('music_supporter', { exact: true })).toBeVisible()
    await expect(wall).not.toContainText('€')
    await page.getByRole('button', { name: 'Hide my support' }).click()
    await expect(wall).toHaveCount(0)
    await expect(
        page.getByText('Your support is currently private.', { exact: false }),
    ).toBeVisible()
})

test('removes stale donation links when refreshing fails and recovers on retry', async ({
    page,
}) => {
    let fail = false
    await page.route('**/api/support', (route) =>
        fail ? route.abort('failed') : route.fulfill({ json: support() }),
    )
    await page.goto('/support')
    await expect(page.getByRole('link', { name: 'Donate with Stripe' })).toBeVisible()
    fail = true
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Support information could not be loaded')
    await expect(page.getByRole('link', { name: 'Donate with Stripe' })).toHaveCount(0)
    fail = false
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Donate with Stripe' })).toBeVisible()
})

test('shows receipt history only in the administrator view', async ({ page }) => {
    const data = support()
    data.viewer = {
        id: '00000000-0000-4000-8000-000000000001',
        supporter: false,
        public: false,
        listed: false,
        admin: true,
    }
    await supportSession(page, data)
    await page.route('**/api/support', (route) => route.fulfill({ json: data }))
    await page.route('**/api/admin/support?*', (route) =>
        route.fulfill({
            json: {
                donations: [
                    {
                        session_id: 'cs_test_private_receipt',
                        amount_cents: 1500,
                        refunded_cents: 500,
                        paid_at: '2026-10-31 00:00:00',
                        pseudonym: null,
                    },
                ],
                more: false,
            },
        }),
    )
    await page.goto('/support')
    await expect(page.getByRole('heading', { name: 'Donation history' })).toBeVisible()
    await expect(page.getByText('cs_test_private_receipt')).toBeVisible()
    data.viewer = null
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Donation history' })).toHaveCount(0)
    await expect(page.getByText('cs_test_private_receipt')).toHaveCount(0)
})

test('loads each receipt page once on rapid clicks and unlocks pagination after an error', async ({
    page,
}) => {
    const data = support()
    data.viewer = {
        id: '00000000-0000-4000-8000-000000000001',
        supporter: false,
        public: false,
        listed: false,
        admin: true,
    }
    await supportSession(page, data)
    await page.route('**/api/support', (route) => route.fulfill({ json: data }))
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    const requestedPages: number[] = []
    let failThird = true
    await page.route('**/api/admin/support?*', async (route) => {
        const number = Number(new URL(route.request().url()).searchParams.get('page'))
        if (number > 1) requestedPages.push(number)
        if (number === 2) await held
        if (number === 3 && failThird) {
            failThird = false
            await route.fulfill({ status: 503, json: { message: 'Try again' } })
            return
        }
        await route.fulfill({
            json: {
                donations: [
                    {
                        session_id: `cs_test_receipt_${number}`,
                        amount_cents: 1500,
                        refunded_cents: 0,
                        paid_at: '2026-10-31 00:00:00',
                        pseudonym: null,
                    },
                ],
                more: number < 3,
            },
        })
    })
    await page.goto('/support')
    await expect(page.getByText('cs_test_receipt_1')).toBeVisible()
    const more = page.getByRole('button', { name: 'Load more', exact: true })
    await expect(more).toBeEnabled()
    // Trigger both clicks in one task, before Vue can update the disabled attribute.
    await more.evaluate((button: HTMLButtonElement) => {
        button.click()
        button.click()
    })
    await expect.poll(() => requestedPages.length).toBeGreaterThan(0)
    await expect(more).toBeDisabled()
    expect(requestedPages).toEqual([2])
    release()
    await expect(page.getByText('cs_test_receipt_2', { exact: true })).toHaveCount(1)
    await expect(more).toBeEnabled()
    await more.click()
    await expect(page.getByRole('alert')).toContainText('Support information could not be loaded')
    await expect(more).toBeEnabled()
    await more.click()
    await expect(page.getByText('cs_test_receipt_3', { exact: true })).toHaveCount(1)
    await expect(page.locator('.support-ledger li')).toHaveCount(3)
    expect(requestedPages).toEqual([2, 3, 3])
    await expect(more).toHaveCount(0)
})

test('replaces a delayed donation link when the account session has changed', async ({ page }) => {
    const data = support()
    data.viewer = {
        id: '00000000-0000-4000-8000-000000000001',
        supporter: true,
        public: false,
        listed: false,
        admin: false,
    }
    data.donationUrl += '?client_reference_id=account_one'
    const reads = await supportSession(page, data)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    let requests = 0
    await page.route('**/api/support', async (route) => {
        const snapshot = structuredClone(data)
        if (++requests === 1) await held
        await route.fulfill({ json: snapshot })
    })
    await page.goto('/support')
    await expect.poll(() => reads()).toBeGreaterThan(0)
    await expect.poll(() => requests).toBe(1)
    data.viewer.id = '00000000-0000-4000-8000-000000000002'
    data.donationUrl = 'https://buy.stripe.com/test_lyricflow?client_reference_id=account_two'
    release()
    await expect(page.getByRole('link', { name: 'Donate with Stripe' })).toHaveAttribute(
        'href',
        data.donationUrl,
        { timeout: 3000 },
    )
})

test('refreshes the confirmed visibility after focus changes while saving', async ({ page }) => {
    const data = support()
    data.viewer = {
        id: '00000000-0000-4000-8000-000000000001',
        supporter: true,
        public: false,
        listed: false,
        admin: false,
    }
    await supportSession(page, data)
    let requests = 0,
        mutationStarted = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
    })
    await page.route('**/api/support', async (route) => {
        requests++
        await route.fulfill({ json: data })
    })
    await page.route('**/api/support/visibility', async (route) => {
        mutationStarted = true
        await held
        data.viewer!.public = true
        data.viewer!.listed = true
        data.supporters = [{ pseudonym: 'supporter_one', since: '2026-10-31' }]
        await route.fulfill({ json: { saved: true } })
    })
    await page.goto('/support')
    await page.getByRole('button', { name: 'Show my support on the wall' }).click()
    await expect.poll(() => mutationStarted).toBe(true)
    const beforeFocus = requests
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => requests).toBeGreaterThan(beforeFocus)
    await expect(
        page.getByText('Your support is currently private.', { exact: false }),
    ).toBeVisible()
    release()
    await expect(page.getByRole('button', { name: 'Hide my support' })).toBeVisible({
        timeout: 3000,
    })
})

test('discards an administrator receipt response when the initial session resolves to another account', async ({
    page,
}) => {
    const data = support()
    data.viewer = {
        id: '00000000-0000-4000-8000-000000000001',
        supporter: false,
        public: false,
        listed: false,
        admin: true,
    }
    data.donationUrl += '?client_reference_id=administrator'
    let releaseSessions!: () => void, releaseLedger!: () => void
    const sessionsHeld = new Promise<void>((resolve) => {
        releaseSessions = resolve
    })
    const ledgerHeld = new Promise<void>((resolve) => {
        releaseLedger = resolve
    })
    let ledgerStarted = false
    await page.route('**/api/session', async (route) => {
        await sessionsHeld
        await route.fulfill({
            json: {
                enabled: true,
                googleEnabled: false,
                emailEnabled: false,
                googlePending: false,
                csrfToken: 'token',
                user: {
                    id: '00000000-0000-4000-8000-000000000002',
                    pseudonym: 'new_member',
                    email: 'member@example.test',
                    verified: true,
                    hasPassword: true,
                    googleLinked: false,
                    role: 'member',
                    supporter: false,
                },
            },
        })
    })
    await page.route('**/api/support', (route) => route.fulfill({ json: data }))
    await page.route('**/api/admin/support?*', async (route) => {
        ledgerStarted = true
        await ledgerHeld
        await route.fulfill({
            json: {
                donations: [
                    {
                        session_id: 'cs_PRIVATE_PREVIOUS_ADMIN',
                        amount_cents: 1500,
                        refunded_cents: 0,
                        paid_at: '2026-10-31 00:00:00',
                        pseudonym: 'private_donor',
                    },
                ],
                more: false,
            },
        })
    })
    await page.goto('/support')
    await expect.poll(() => ledgerStarted).toBe(true)
    data.viewer = {
        id: '00000000-0000-4000-8000-000000000002',
        supporter: false,
        public: false,
        listed: false,
        admin: false,
    }
    data.donationUrl = 'https://buy.stripe.com/test_lyricflow?client_reference_id=member'
    releaseSessions()
    await expect(page.getByRole('link', { name: 'Donate with Stripe' })).toHaveAttribute(
        'href',
        data.donationUrl,
        { timeout: 3000 },
    )
    releaseLedger()
    await expect(page.getByText('cs_PRIVATE_PREVIOUS_ADMIN')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Donation history' })).toHaveCount(0)
})
