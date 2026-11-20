import { AccountError, accountGet, accountRequest } from '../accounts/client'
import { t } from '../i18n/en'
import type { Library } from '../storage/library'
import type { OwnedPublication } from './model'

export async function synchronizeSharing(
    library: Library,
    accountId: string,
    current: () => boolean,
    settingsOnly = false,
) {
    const exchange = async () => {
        if (!current()) return
        const listedBefore = (await library.sharingEntries()).map((entry) => entry.publication)
        const publications: OwnedPublication[] = []
        let page = 1,
            more = true
        while (current() && more) {
            const data = await accountGet<{
                accountId: string
                publications: OwnedPublication[]
                more: boolean
            }>(`/api/community/mine?sort=id&page=${page++}`)
            if (data.accountId !== accountId) throw new AccountError(t('accountChangedError'), 401)
            publications.push(...data.publications)
            more = data.more
        }
        if (!current() || !(await library.isCurrent()) || !(await library.isMember())) return
        await library.rememberPublications(publications, true, false, listedBefore)
        while (current()) {
            const next = await library.nextSharingOperation(settingsOnly)
            if (!next || !current()) return
            const { entry, operation, kind } = next
            try {
                const data = await accountRequest<{ publication: OwnedPublication }>(
                    `/api/community/publications/${entry.publication.id}/${kind === 'setting' ? 'auto-share' : 'auto-update'}`,
                    {
                        accountId,
                        localSongId: entry.localSongId,
                        ...operation,
                        ...(kind === 'setting' ? { operationId: operation.id } : {}),
                    },
                )
                if (!current()) return
                await library.acceptSharing(entry.localSongId, operation, data.publication)
            } catch (error) {
                if (!current()) return
                if (error instanceof AccountError && [404, 409, 422].includes(error.status)) {
                    await library.blockSharing(entry.localSongId, operation.id, error.message)
                    continue
                }
                throw error
            }
        }
    }
    if (navigator.locks) await navigator.locks.request(`lyricflow.sharing.${accountId}`, exchange)
    else await exchange()
}
