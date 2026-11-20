import { accountRequest } from './client'
import type { Library } from '../storage/library'
import type { SyncResponse } from '../storage/sync-types'

export async function synchronize(library: Library, accountId: string, current: () => boolean) {
    const exchange = async () => {
        if (!current() || !(await library.isMember())) return
        await library.prepareSync()
        let more = true
        // Yield between bounded exchanges; interrupted work remains durable in IndexedDB.
        while (current() && (await library.isMember())) {
            const operation = await library.nextSyncOperation()
            if (!operation && !more) break
            const response = await accountRequest<SyncResponse>('/api/sync', {
                accountId,
                cursor: await library.syncCursor(),
                ...(operation ? { operation } : {}),
            })
            if (response.accountId !== accountId) throw new Error('accountChanged')
            if (!current()) return
            await library.acceptSync(response, operation)
            more = response.more
        }
    }
    // Web Locks serializes tabs on this origin; server revisions remain the fallback.
    if (navigator.locks) await navigator.locks.request(`lyricflow.sync.${accountId}`, exchange)
    else await exchange()
}
