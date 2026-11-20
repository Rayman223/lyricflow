import { expect, test } from '@playwright/test'

test('returns to the library when the brand is clicked from Account', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'LyricFlow', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
})

test('returns to the library from every account and community screen with the brand', async ({
    page,
}) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await page.getByLabel('Email address', { exact: true }).fill('browser_admin@example.test')
    await page.getByLabel('Password', { exact: true }).fill('Browser test password 123')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
    const profile = await page.getByLabel('Library on this device').inputValue()
    const title = `Private navigation ${crypto.randomUUID()}`
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Title', { exact: true }).fill(title)
    await page.getByLabel('Lyrics', { exact: true }).fill('Private lyrics stay on this profile')
    await page.getByRole('button', { name: 'Save song', exact: true }).click()

    for (const [button, heading] of [
        ['browser_admin', 'Account'],
        ['Community', 'Community'],
        ['Share song', 'Public preview'],
        ['Moderation', 'Moderation'],
    ]) {
        await page.getByRole('button', { name: button, exact: true }).click()
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
        await page.getByRole('link', { name: 'LyricFlow', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible()
        await expect(page.getByLabel('Library on this device')).toHaveValue(profile)
        await expect(page.getByText(title, { exact: true })).toBeVisible()
    }
    const publications = await (await page.request.get('/api/community/mine')).json()
    expect(
        publications.publications.some(
            (publication: { content: { title: string } }) => publication.content.title === title,
        ),
    ).toBe(false)
})

test('keeps the editor open when draft saving fails and leaving through the brand is declined', async ({
    page,
}) => {
    await page.addInitScript(() => {
        const put = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
            if (this.name === 'drafts')
                throw new DOMException('Test device full', 'QuotaExceededError')
            return put.apply(this, args)
        }
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'New song' }).click()
    await page.getByLabel('Lyrics', { exact: true }).fill('Keep this unsaved lyric')
    page.once('dialog', async (dialog) => {
        expect(dialog.type()).toBe('confirm')
        await dialog.dismiss()
    })
    await page.getByRole('link', { name: 'LyricFlow', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Could not save on this device')
    await expect(page.getByRole('heading', { name: 'Song editor', exact: true })).toBeVisible()
    await expect(page.getByLabel('Lyrics', { exact: true })).toHaveValue('Keep this unsaved lyric')
})
