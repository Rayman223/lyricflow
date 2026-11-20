import { expect, test } from '@playwright/test'

const timestamp = '2026-01-02T23:04:05.000000Z'
const publication = {
    id: 'publication',
    catalogId: 'catalog-song',
    author: 'Date tester',
    authorId: 'owner',
    revision: 1,
    updatedAt: timestamp,
    average: null,
    ratingCount: 0,
    published: true,
    hidden: false,
    source: null,
    content: {
        formatVersion: 1,
        title: 'Local dates',
        artist: 'Test band',
        lyrics: 'Original test lyrics',
        music: { bpm: 120, beatsPerBar: 4, barsPerLine: 1 },
    },
}

for (const [timezoneId, expected] of [
    ['Europe/Brussels', '03/01/2026, 00:04:05'],
    ['America/New_York', '02/01/2026, 18:04:05'],
    ['Asia/Kathmandu', '03/01/2026, 04:49:05'],
] as const) {
    test.describe(timezoneId, () => {
        test.use({ timezoneId, locale: 'en-US' })

        test('formats publication dates and moderation times in the local timezone', async ({
            page,
        }) => {
            await page.route('**/api/**', async (route) => {
                const path = new URL(route.request().url()).pathname
                const responses: Record<string, unknown> = {
                    '/api/session': {
                        enabled: true,
                        googleEnabled: false,
                        emailEnabled: true,
                        googlePending: false,
                        csrfToken: 'test-token',
                        user: {
                            id: 'date-tester',
                            pseudonym: 'Date tester',
                            email: 'date@example.test',
                            verified: true,
                            hasPassword: true,
                            googleLinked: false,
                            role: 'moderator',
                        },
                    },
                    '/api/community/catalog': {
                        songs: [{ id: 'catalog-song', title: 'Local dates', artist: 'Test band' }],
                        more: false,
                    },
                    '/api/community/catalog/catalog-song': {
                        publications: [publication],
                        more: false,
                    },
                    '/api/community/publications/publication': {
                        publication,
                        ratings: [],
                        ownRating: null,
                        more: false,
                    },
                    '/api/community/mine': { publications: [], more: false },
                    '/api/moderation/reports': { reports: [], more: false },
                    '/api/moderation/events': {
                        events: [
                            {
                                id: 1,
                                action: 'hide',
                                target_type: 'publication',
                                reason: 'Test event',
                                pseudonym: 'Date tester',
                                created_at: timestamp,
                            },
                        ],
                        more: false,
                    },
                }
                if (path in responses) await route.fulfill({ json: responses[path] })
                else await route.abort()
            })
            await page.goto('/')
            await page.getByRole('button', { name: 'Community', exact: true }).click()
            await page.getByRole('button', { name: 'Local dates · Test band', exact: true }).click()
            await expect(page.locator('time')).toHaveText(expected)
            await page.getByRole('button', { name: 'Date tester · V.1', exact: true }).click()
            await expect(
                page.getByRole('heading', { name: 'Local dates', exact: true }),
            ).toBeVisible()
            await expect(page.locator('time')).toHaveText(expected)
            await page.getByRole('button', { name: 'Back to library', exact: true }).click()
            await page.getByRole('button', { name: 'Moderation', exact: true }).click()
            await page.getByRole('button', { name: 'Moderation log', exact: true }).click()
            await expect(page.locator('time')).toHaveText(expected)
        })
    })
}
