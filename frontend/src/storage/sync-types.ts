import type { Song } from '../domain/song'

export type SyncValue =
    { song: Song | null; draft: Song | null } | { theme: 'light' | 'dark' } | null
export interface RemoteRecord {
    key: string
    revision: number
    value: SyncValue
}
export interface SyncOperation {
    id: string
    key: string
    baseRevision: number
    value: SyncValue
}
export interface SyncEntry {
    key: string
    revision: number
    operation?: SyncOperation
    inFlight?: SyncOperation
    conflict?: RemoteRecord
}
export interface SyncResponse {
    accountId: string
    result:
        | { status: 'applied'; revision: number }
        | { status: 'conflict'; record: RemoteRecord }
        | null
    records: RemoteRecord[]
    cursor: number
    more: boolean
}
