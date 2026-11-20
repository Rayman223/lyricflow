<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, toRaw, watch } from 'vue'
import { useRegisterSW } from 'virtual:pwa-register/vue'
import { newSong, type Song, type ReaderSettings } from './domain/song'
import { validSettings } from './domain/song'
import { parseLyrics } from './domain/parser'
import { demoSong } from './domain/demo'
import {
    Library,
    openLibrary,
    profileDatabase,
    QuotaError,
    type LocalProfile,
} from './storage/library'
import {
    AccountError,
    accountGet,
    accountRequest,
    session as fetchSession,
    type Account,
    type AccountSession,
} from './accounts/client'
import { t } from './i18n/en'
import { synchronize } from './accounts/sync'
import { synchronizeSharing } from './community/sharing'
import type { SyncEntry } from './storage/sync-types'
import SongEditor from './components/SongEditor.vue'
import SharingStatus from './components/SharingStatus.vue'
import Prompter from './components/Prompter.vue'
import SharedPrompter from './components/SharedPrompter.vue'
import ShareLink from './components/ShareLink.vue'
import AccountPanel from './components/AccountPanel.vue'
import SyncVersion from './components/SyncVersion.vue'
import CommunityPanel from './components/CommunityPanel.vue'
import PublishPanel from './components/PublishPanel.vue'
import ModerationPanel from './components/ModerationPanel.vue'
import SupportPanel from './components/SupportPanel.vue'
import {
    copyPublication,
    type Publication,
    type OwnedPublication,
    type SharingEntry,
    type SourceUpdate,
    type ModerationTarget,
} from './community/model'

const songs = ref<Song[]>([]),
    drafts = ref<Song[]>([])
const sharedId = ref<string | undefined>(sharedHash())
const sharingReturn = ref<'library' | 'reader'>('library')
const screen = ref<
    | 'library'
    | 'editor'
    | 'reader'
    | 'account'
    | 'community'
    | 'publish'
    | 'moderation'
    | 'shared'
    | 'support'
>(
    location.pathname.replace(/\/+$/, '') === '/support'
        ? 'support'
        : sharedId.value !== undefined
          ? 'shared'
          : location.hash.startsWith('#account') || location.hash.startsWith('#reset-password')
            ? 'account'
            : 'library',
)
const sharing = ref<Song>(),
    initialPublication = ref<string>(),
    moderationTarget = ref<ModerationTarget>()
const sharingEntries = ref<Record<string, SharingEntry>>({})
const sharingNetworkError = ref('')
const sharingStatusKnown = ref(false)
const sharingSaving = ref(false)
async function publicationChanged(publication: OwnedPublication) {
    const target = library,
        revision = profileRevision
    if (
        !target ||
        publication.authorId !== activeProfile.value ||
        accountSession.value?.user?.id !== publication.authorId
    )
        return
    try {
        await target.rememberPublications([publication], false, true)
        if (target === library && revision === profileRevision) await refresh()
        void checkSourceUpdates()
    } catch {
        if (target === library && revision === profileRevision)
            sharingNetworkError.value = t('storageError')
    }
}
async function changeAutoSharing(enabled: boolean) {
    const target = library,
        id = activeProfile.value,
        revision = profileRevision,
        identity = accountRevision,
        songId = editing.value?.id
    if (!target || !songId || sharingSaving.value) return
    const current = () =>
        library === target &&
        profileRevision === revision &&
        accountRevision === identity &&
        accountSession.value?.user?.id === id &&
        !profileSwitching.value &&
        !updateBusy.value
    sharingSaving.value = true
    try {
        await trackLocalWrite(target.setAutoSharing(songId, enabled))
        if (!current()) return
        await refresh()
        if (online.value) await synchronizeSharing(target, id, current, true)
        if (current()) {
            sharingNetworkError.value = ''
            await refresh()
        }
    } catch {
        if (current()) sharingNetworkError.value = t('sharingNetworkError')
    } finally {
        sharingSaving.value = false
    }
}
const sourceUpdates = ref<Record<string, SourceUpdate>>({}),
    librarySearch = ref('')
const filteredSongs = computed(() => {
    const query = librarySearch.value.trim().toLocaleLowerCase('en')
    return songs.value.filter((song) =>
        `${song.title} ${song.artist}`.toLocaleLowerCase('en').includes(query),
    )
})
async function checkSourceUpdates() {
    const target = library,
        id = activeProfile.value
    if (!target || !online.value || accountSession.value?.user?.id !== id) return
    const ids = [
        ...new Set(
            (await target.list()).flatMap((song) =>
                song.source ? [song.source.publicationId] : [],
            ),
        ),
    ]
    try {
        const updates: SourceUpdate[] = []
        for (let start = 0; start < ids.length; start += 100) {
            const data = await accountRequest<{ updates: SourceUpdate[] }>(
                '/api/community/updates',
                { ids: ids.slice(start, start + 100) },
            )
            updates.push(...data.updates)
        }
        if (library === target && activeProfile.value === id)
            sourceUpdates.value = Object.fromEntries(updates.map((update) => [update.id, update]))
    } catch {
        /* An unavailable source never blocks local reading or editing. */
    }
}
function openCommunity(publicationId?: string) {
    if (!online.value || !accountSession.value?.user) {
        error.value = t('communityOffline')
        return
    }
    initialPublication.value = publicationId
    screen.value = 'community'
}
function openSharing(song: Song, fromReader = false) {
    if (accountSession.value?.user?.id !== activeProfile.value || !online.value) {
        error.value = t('communityOffline')
        return
    }
    sharingReturn.value = fromReader ? 'reader' : 'library'
    sharing.value = structuredClone(toRaw(song))
    screen.value = 'publish'
}
function openModeration() {
    moderationTarget.value = undefined
    screen.value = 'moderation'
}
function moderate(target: ModerationTarget) {
    moderationTarget.value = target
    screen.value = 'moderation'
}
async function currentCommunityAccount() {
    const expected = accountSession.value?.user?.id,
        identityRevision = accountRevision
    let expectedProfileRevision = profileRevision
    const unchanged = () =>
        profileRevision === expectedProfileRevision &&
        accountRevision === identityRevision &&
        accountSession.value?.user?.id === expected
    const data = await fetchSession()
    if (!unchanged()) throw new AccountError(t('communityContextChanged'), 401)
    if (!expected || data.user?.id !== expected) {
        await syncAccount()
        throw new AccountError(t('accountChangedError'), 401)
    }
    if (activeProfile.value !== expected) {
        expectedProfileRevision++
        await selectProfile(expected)
    }
    const target = library
    const current = () =>
        unchanged() &&
        library === target &&
        activeProfile.value === expected &&
        !profileSwitching.value
    if (!target || !current()) throw new AccountError(t('communityContextChanged'), 401)
    return { target, current }
}
async function download(publication: Publication) {
    try {
        const { target, current } = await currentCommunityAccount()
        if (!current()) throw new AccountError(t('communityContextChanged'), 401)
        await target.save(copyPublication(structuredClone(toRaw(publication))))
        if (!current()) return
        await refresh()
        screen.value = 'library'
        profileMessage.value = t('privateCopySaved')
        scheduleSync()
    } catch (e) {
        error.value =
            e instanceof QuotaError
                ? t('quota')
                : e instanceof Error
                  ? e.message
                  : t('storageError')
    }
}
async function updateCopy(song: Song) {
    if (!song.source) return
    try {
        const { target, current } = await currentCommunityAccount()
        const data = await accountGet<{ publication: Publication }>(
            `/api/community/publications/${song.source.publicationId}`,
        )
        if (!current()) throw new AccountError(t('communityContextChanged'), 401)
        const result = await target.updateFromPublication(song.id, data.publication)
        if (!current()) return
        profileMessage.value = t(
            result === 'customized'
                ? 'customizedCopy'
                : result === 'current'
                  ? 'copyCurrent'
                  : result === 'updated'
                    ? 'copyUpdated'
                    : 'sourceUnavailable',
        )
        await refresh()
        scheduleSync()
    } catch (e) {
        error.value = e instanceof Error ? e.message : t('accountNetworkError')
    }
}
async function downloadSource(song: Song) {
    if (!song.source) return
    try {
        const { current } = await currentCommunityAccount()
        const data = await accountGet<{ publication: Publication }>(
            `/api/community/publications/${song.source.publicationId}`,
        )
        if (!current()) throw new AccountError(t('communityContextChanged'), 401)
        await download(data.publication)
    } catch (e) {
        error.value = e instanceof Error ? e.message : t('accountNetworkError')
    }
}
const accountSession = ref<AccountSession | null>(null)
const profiles = ref<LocalProfile[]>([])
const activeProfile = ref('guest'),
    member = ref(false)
const profileMessage = ref('')
const profileChannel =
    typeof BroadcastChannel === 'function' ? new BroadcastChannel('lyricflow.profiles') : undefined
const syncState = ref<'saved' | 'pending' | 'syncing' | 'synced' | 'signin' | 'error'>('saved')
const conflicts = ref<SyncEntry[]>([])
let syncTimer: ReturnType<typeof setTimeout> | undefined
let syncTask: Promise<void> | undefined
let syncAgain = false
function scheduleSync() {
    clearTimeout(syncTimer)
    syncTimer = setTimeout(() => void syncPrivate(), 700)
}
async function syncPrivate() {
    if (syncTask) {
        syncAgain = true
        return syncTask
    }
    const target = library
    const id = activeProfile.value
    const revision = profileRevision
    if (
        !target ||
        id === 'guest' ||
        screen.value === 'editor' ||
        profileSwitching.value ||
        updateBusy.value
    )
        return
    const current = () =>
        library === target &&
        profileRevision === revision &&
        accountSession.value?.user?.id === id &&
        !profileSwitching.value &&
        screen.value !== 'editor' &&
        !updateBusy.value
    if (!current()) {
        syncState.value = 'signin'
        return
    }
    if (!online.value) {
        syncState.value = 'pending'
        return
    }
    syncState.value = 'syncing'
    syncTask = (async () => {
        try {
            await synchronize(target, id, current)
            if (!current()) return
            if (!(await target.isMember())) {
                syncState.value = 'signin'
                return
            }
            await refresh()
            const entries = await target.syncEntries()
            conflicts.value = entries.filter((entry) => entry.conflict)
            void checkSourceUpdates()
            syncState.value = entries.some((entry) => entry.operation || entry.conflict)
                ? 'pending'
                : 'synced'
            const storedTheme = await target.getPreference('theme')
            if (storedTheme === 'light' || storedTheme === 'dark') applyTheme(storedTheme)
            try {
                await synchronizeSharing(target, id, current)
                if (current()) {
                    sharingNetworkError.value = ''
                    await refresh()
                }
            } catch {
                if (current()) {
                    sharingNetworkError.value = t('sharingNetworkError')
                    await refresh()
                }
            }
        } catch (e) {
            if (!current()) return
            syncState.value =
                e instanceof AccountError && [401, 403].includes(e.status) ? 'signin' : 'error'
            if (syncState.value === 'signin') await syncAccount()
        } finally {
            syncTask = undefined
            if (syncAgain) {
                syncAgain = false
                scheduleSync()
            }
        }
    })()
    return syncTask
}
function applyTheme(value: string) {
    theme.value = value
    document.documentElement.dataset.theme = value
    try {
        localStorage.setItem('lyricflow.theme', value)
    } catch {
        /* Optional snapshot. */
    }
}
const resolveConflict = localAction(
    async (entry: SyncEntry, choice: 'local' | 'server' | 'both') => {
        try {
            await library?.resolveConflict(
                entry.key,
                choice,
                entry.conflict!.revision,
                entry.operation?.id,
            )
            await refresh()
            conflicts.value = (await library!.syncEntries()).filter((entry) => entry.conflict)
            scheduleSync()
        } catch (e) {
            error.value =
                e instanceof QuotaError
                    ? t('quota')
                    : e instanceof Error && e.message === 'conflictChanged'
                      ? t('conflictChanged')
                      : t('storageError')
            await refresh()
            if (library)
                conflicts.value = (await library.syncEntries()).filter((entry) => entry.conflict)
        }
    },
)
async function accountDeleted(user: Account, erase: boolean) {
    try {
        const target =
            user.id === activeProfile.value && library
                ? library
                : new Library(await openLibrary(profileDatabase(user.id)))
        try {
            await target.detach(erase)
        } finally {
            if (target !== library) target.close()
        }
        if (accountSession.value?.user?.id === user.id)
            await accountChanged(null, t('accountDeleted'))
        else await syncAccount()
    } catch {
        error.value = t('storageError')
    }
}
watch(screen, (value) => {
    if (value !== 'editor') scheduleSync()
})
const profileSwitching = ref(false)
let profileRevision = 0
let registry: Library | undefined
let accountRevision = 0
let accountWrites: Promise<void> = Promise.resolve()
const editing = ref<Song>(),
    reading = ref<Song>()
const theme = ref(document.documentElement.dataset.theme || 'light')
const error = ref(''),
    ready = ref(false),
    saveError = ref('')
const savedState = ref<'saved' | 'pending' | 'error'>('saved')
const saving = ref(false)
const online = ref(navigator.onLine)
const deleting = ref<Song>()
const updateBusy = ref(false),
    updateActivated = ref(false),
    updateDismissed = ref(false),
    updateError = ref('')
const canUpdate = computed(() => screen.value === 'library' || screen.value === 'editor')
const localTasks = new Set<Promise<void>>()
// These actions contain only local work. Never wait for a network synchronization to reload.
function localAction<Args extends unknown[]>(action: (...args: Args) => Promise<void>) {
    return (...args: Args) => {
        if (updateBusy.value) return Promise.resolve()
        const task = action(...args)
        return trackLocalWrite(task)
    }
}
function trackLocalWrite(task: Promise<void>) {
    localTasks.add(task)
    void task.finally(() => localTasks.delete(task)).catch(() => {})
    return task
}
let controller = navigator.serviceWorker?.controller
const { offlineReady, needRefresh, updateServiceWorker } = useRegisterSW({
    onNeedReload: updateControlled,
    onNeedRefresh() {
        updateDismissed.value = false
        // A tab from the first installation may still have no controller (clientsClaim is off).
        // Only observe a waiting update, so installing the app alone never reloads it.
        void navigator.serviceWorker
            .getRegistration()
            .then((registration) => {
                const waiting = registration?.waiting
                waiting?.addEventListener('statechange', () => {
                    if (waiting.state === 'activated') updateControlled()
                })
            })
            .catch(() => {})
    },
})
function updateControlled() {
    if (updateActivated.value) return
    updateActivated.value = true
    void reloadUpdatedApp()
}
function controllerChanged() {
    const next = navigator.serviceWorker.controller
    if (controller && next && next !== controller) updateControlled()
    controller = next
}
let reloadTask: Promise<void> | undefined
let reloading = false
function reloadUpdatedApp() {
    if (reloadTask || reloading || !ready.value || profileSwitching.value || !canUpdate.value)
        return reloadTask
    updateBusy.value = true
    updateError.value = ''
    reloadTask = (async () => {
        try {
            // Freeze interactions before draining actions that may still be preparing a write.
            await Promise.all([...localTasks])
            // Access refreshes contain no user input; a previous failure must not poison retries.
            await accountWrites.catch(() => {})
            if (!canUpdate.value) return
            if (screen.value === 'editor') {
                // A failed autosave still owns its latest snapshot and may be retried.
                await flushDraft()
                if (draftFailure) throw new Error('draftNotSaved')
            }
            await Promise.all([library?.whenIdle(), registry?.whenIdle()])
            reloading = true
            window.location.reload()
        } catch {
            updateError.value = t('updateSaveError')
            updateDismissed.value = false
        } finally {
            if (!reloading) updateBusy.value = false
            reloadTask = undefined
        }
    })()
    return reloadTask
}
async function applyUpdate() {
    if (updateBusy.value || !canUpdate.value) return
    if (updateActivated.value) {
        await reloadUpdatedApp()
        return
    }
    updateBusy.value = true
    updateError.value = ''
    try {
        await updateServiceWorker(false)
    } catch {
        updateBusy.value = false
        updateError.value = t('updateError')
    }
}
watch([screen, ready, profileSwitching], () => {
    if (updateActivated.value && !updateError.value) void reloadUpdatedApp()
})
function dismissPwa() {
    updateDismissed.value = true
    offlineReady.value = false
}
let library: Library | undefined
let draftTimer: ReturnType<typeof setTimeout> | undefined
let pendingDraft: Song | undefined
let writingDraft: Promise<void> = Promise.resolve()
let draftFailure = false
let draftRevision = 0
const unpublishedDrafts = computed(() =>
    drafts.value.filter((d) => !songs.value.some((s) => s.id === d.id)),
)

function net() {
    online.value = navigator.onLine
    if (online.value) void syncAccount()
}
function hasUnsaved() {
    return savedState.value !== 'saved'
}
function beforeUnload(event: BeforeUnloadEvent) {
    if (screen.value === 'editor' && hasUnsaved()) event.preventDefault()
}
async function refresh() {
    const target = library,
        revision = profileRevision
    if (!target) return
    const [nextSongs, nextDrafts, nextMember, nextSharing, knownSharing] = await Promise.all([
        target.list(),
        target.drafts(),
        target.isMember(),
        target.sharingEntries(),
        target.getPreference('communityLoaded'),
    ])
    if (target !== library || revision !== profileRevision) return
    songs.value = nextSongs
    drafts.value = nextDrafts
    member.value = nextMember
    sharingStatusKnown.value = knownSharing === '1'
    sharingEntries.value = Object.fromEntries(
        nextSharing.map((entry) => [entry.localSongId, entry]),
    )
}
async function init() {
    try {
        registry?.close()
        registry = new Library(await openLibrary())
        profiles.value = await registry.profiles()
        const stored = await registry.getPreference('activeProfile')
        await selectProfile(profiles.value.some((p) => p.id === stored) ? stored! : 'guest', false)
        const googleReturn = location.hash.startsWith('#account')
        ready.value = true
        error.value = ''
        void syncAccount(googleReturn)
    } catch {
        error.value = t('openError')
    }
}

const selectProfile = localAction(async (id: string, remember = true) => {
    const revision = ++profileRevision
    profileSwitching.value = true
    let next: Library | undefined
    let committed = false
    try {
        if (screen.value === 'editor') await flushDraft()
        if (revision !== profileRevision) return
        next = new Library(await openLibrary(profileDatabase(id)))
        const [nextSongs, nextDrafts, nextMember, storedTheme, nextSharing, knownSharing] =
            await Promise.all([
                next.list(),
                next.drafts(),
                next.isMember(),
                next.getPreference('theme'),
                next.sharingEntries(),
                next.getPreference('communityLoaded'),
            ])
        if (revision !== profileRevision) return
        if (remember) await registry?.setPreference('activeProfile', id)
        if (revision !== profileRevision) return
        library?.close()
        library = next
        committed = true
        songs.value = nextSongs
        drafts.value = nextDrafts
        member.value = nextMember
        activeProfile.value = id
        sourceUpdates.value = {}
        sharingEntries.value = Object.fromEntries(
            nextSharing.map((entry) => [entry.localSongId, entry]),
        )
        sharingNetworkError.value = ''
        sharingStatusKnown.value = knownSharing === '1'
        librarySearch.value = ''
        syncState.value = id === 'guest' ? 'saved' : 'pending'
        conflicts.value = (await next.syncEntries()).filter((entry) => entry.conflict)
        scheduleSync()
        if (storedTheme === 'light' || storedTheme === 'dark') {
            theme.value = storedTheme
            document.documentElement.dataset.theme = storedTheme
            try {
                localStorage.setItem('lyricflow.theme', storedTheme)
            } catch {
                /* Optional snapshot. */
            }
        }
    } catch (e) {
        throw e
    } finally {
        if (!committed) next?.close()
        if (revision === profileRevision) profileSwitching.value = false
    }
})
async function profileChanged(event: Event) {
    try {
        await selectProfile((event.target as HTMLSelectElement).value)
        profileMessage.value = ''
        error.value = ''
    } catch {
        error.value = t('openError')
    }
}
const removeLocalLibrary = localAction(async () => {
    const id = activeProfile.value,
        target = library,
        name = profiles.value.find((profile) => profile.id === id)?.label ?? t('guestProfile')
    if (!target || !registry || profileSwitching.value || accountSession.value?.user?.id === id)
        return
    if (!confirm(t('removeLocalLibraryConfirm', { name }))) return
    profileRevision++
    accountRevision++
    profileSwitching.value = true
    clearTimeout(syncTimer)
    try {
        await accountWrites.catch(() => {})
        await target.eraseLocal()
        applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        await registry.forgetProfile(id)
        // Erasing Guest also invalidates the registry's old library handle.
        registry.close()
        registry = new Library(await openLibrary())
        await registry.setPreference('activeProfile', 'guest')
        profileChannel?.postMessage(id)
        await init()
        profileMessage.value = t('localLibraryRemoved')
    } catch {
        error.value = t('storageError')
        // Reopen even after a partial failure so no invalidated handle remains active.
        await init()
        error.value = t('storageError')
    } finally {
        profileSwitching.value = false
    }
})
async function profileRemoved(event: MessageEvent<unknown>) {
    if (typeof event.data !== 'string' || !registry) return
    const target = library,
        revision = profileRevision
    try {
        const removed = target && !(await target.isCurrent())
        if (target !== library || revision !== profileRevision) return
        accountRevision++
        if (event.data === activeProfile.value && removed) {
            profileRevision++
            draftRevision++
            clearTimeout(draftTimer)
            pendingDraft = undefined
            editing.value = undefined
            reading.value = undefined
            deleting.value = undefined
            savedState.value = 'saved'
            screen.value = 'library'
            ready.value = false
            await init()
            profileMessage.value = t('localLibraryRemoved')
        } else {
            registry.close()
            registry = new Library(await openLibrary())
            profiles.value = await registry.profiles()
        }
    } catch {
        error.value = t('storageError')
    }
}

async function accountAccess(user: Account | null) {
    if (!registry) return
    if (user) await registry.rememberProfile({ id: user.id, label: user.pseudonym })
    profiles.value = await registry.profiles()
    for (const profile of profiles.value) {
        if (profile.id === 'guest') continue
        const target =
            profile.id === activeProfile.value && library
                ? library
                : new Library(await openLibrary(profileDatabase(profile.id)))
        try {
            const permitted = profile.id === user?.id
            if ((await target.isMember()) !== permitted) await target.setMember(permitted)
        } finally {
            if (target !== library) target.close()
        }
    }
    await refresh()
}
function applyAccountAccess(user: Account | null, revision: number) {
    const update = accountWrites
        .catch(() => {})
        .then(async () => {
            if (revision === accountRevision) await accountAccess(user)
        })
    accountWrites = update
    return update
}
async function syncAccount(activate = false) {
    const revision = ++accountRevision
    let data: AccountSession
    try {
        data = await fetchSession()
    } catch {
        // A transport/server failure does not revoke offline account access.
        return
    }
    if (revision !== accountRevision || updateBusy.value) return
    try {
        if (accountSession.value?.user?.id !== data.user?.id) {
            // A preview belongs to the account that opened it, including after reconnecting.
            if (['community', 'publish', 'moderation'].includes(screen.value))
                screen.value = 'library'
            sharing.value = undefined
            initialPublication.value = undefined
            moderationTarget.value = undefined
        }
        accountSession.value = data
        await applyAccountAccess(data.user, revision)
        if (!data.user && ['community', 'publish', 'moderation'].includes(screen.value))
            screen.value = 'library'
        if (screen.value === 'moderation' && data.user?.role === 'member') screen.value = 'library'
        if (revision === accountRevision && activate && data.user) await selectProfile(data.user.id)
        scheduleSync()
    } catch {
        error.value = t('storageError')
    }
}
async function accountChanged(user: Account | null, notice = '') {
    const revision = ++accountRevision
    try {
        if (accountSession.value)
            accountSession.value = { ...accountSession.value, user, googlePending: false }
        await applyAccountAccess(user, revision)
        if (revision !== accountRevision) return
        if (user) await selectProfile(user.id)
        screen.value = 'library'
        profileMessage.value = notice
        scheduleSync()
        error.value = ''
    } catch {
        error.value = t('storageError')
    }
}
const copyGuest = localAction(async () => {
    if (!library || !registry || accountSession.value?.user?.id !== activeProfile.value) return
    if (!confirm(t('copyGuestConfirm', { name: accountSession.value.user.pseudonym }))) return
    try {
        await library.copyFrom(registry)
        await refresh()
        profileMessage.value = t('guestCopied')
        scheduleSync()
    } catch {
        error.value = t('storageError')
    }
})

const setTheme = localAction(async () => {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = theme.value
    try {
        localStorage.setItem('lyricflow.theme', theme.value)
    } catch {
        /* IndexedDB is the authoritative preference. */
    }
    try {
        await library?.setPreference('theme', theme.value)
        scheduleSync()
    } catch {
        error.value = t('storageError')
    }
})
const begin = localAction(async (song?: Song) => {
    if (profileSwitching.value) return
    const revision = profileRevision
    saveError.value = ''
    error.value = ''
    if (!song && !member.value && songs.value.length >= 3) {
        error.value = t('quota')
        return
    }
    // Opening the editor stays local, even if an online request is slow.
    // Any response still in flight is deferred until the editor has been left.
    const existed = song && songs.value.some((s) => s.id === song!.id)
    editing.value = undefined
    screen.value = 'editor'
    try {
        await refresh()
    } catch {
        screen.value = 'library'
        error.value = t('storageError')
        return
    }
    if (profileSwitching.value || revision !== profileRevision) return
    if (existed && !songs.value.some((s) => s.id === song!.id)) {
        screen.value = 'library'
        error.value = t('songRemoved')
        return
    }
    song = song ? (songs.value.find((s) => s.id === song!.id) ?? song) : undefined
    const draft = song ? drafts.value.find((d) => d.id === song.id) : undefined
    editing.value = structuredClone(toRaw(draft ?? song ?? newSong()))
    writingDraft = Promise.resolve()
    savedState.value = 'saved'
    draftFailure = false
    screen.value = 'editor'
})
function queueDraft(song: Song) {
    if (profileSwitching.value || updateBusy.value) return
    draftRevision++
    pendingDraft = { ...song, updatedAt: new Date().toISOString() }
    editing.value = song
    savedState.value = 'pending'
    clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
        void flushDraft()
    }, 350)
}
async function flushDraft() {
    clearTimeout(draftTimer)
    const value = pendingDraft
    const target = library
    const revision = draftRevision
    pendingDraft = undefined
    if (value) {
        writingDraft = writingDraft
            .catch(() => {})
            .then(async () => {
                if (!target) throw new Error('storageUnavailable')
                await target.saveDraft(value)
            })
    }
    try {
        await writingDraft
        if (revision === draftRevision) {
            draftFailure = false
            savedState.value = 'saved'
            if (saveError.value === t('storageError')) saveError.value = ''
        }
        await refresh()
    } catch {
        if (revision === draftRevision) {
            if (value && !pendingDraft) pendingDraft = value
            savedState.value = 'error'
            draftFailure = true
            saveError.value = t('storageError')
        }
    }
}
async function persist(song: Song) {
    if (profileSwitching.value) return false
    const target = library,
        revision = profileRevision
    await flushDraft()
    if (target !== library || revision !== profileRevision) return false
    try {
        if (!target) throw new Error('storageUnavailable')
        const value = structuredClone(toRaw(song))
        value.updatedAt = new Date().toISOString()
        await target.save(value, true)
        pendingDraft = undefined
        syncState.value = activeProfile.value === 'guest' ? 'saved' : 'pending'
        scheduleSync()
        await refresh()
        savedState.value = 'saved'
        saveError.value = ''
        draftFailure = false
        return true
    } catch (e) {
        saveError.value = e instanceof QuotaError ? t('quota') : t('storageError')
        return false
    }
}
const save = localAction(async (song: Song) => {
    if (saving.value || profileSwitching.value) return
    saving.value = true
    try {
        if (await persist(song)) screen.value = 'library'
    } finally {
        saving.value = false
    }
})
const read = localAction(async (song: Song) => {
    if (saving.value || profileSwitching.value) return
    saving.value = true
    try {
        if (await persist(song)) {
            reading.value = structuredClone(song)
            screen.value = 'reader'
        }
    } finally {
        saving.value = false
    }
})
const back = localAction(async () => {
    if (profileSwitching.value || saving.value) return
    if (screen.value === 'support') {
        location.assign('/')
        return
    }
    saving.value = true
    try {
        if (screen.value === 'editor') {
            await flushDraft()
            if (draftFailure && !window.confirm(t('unsaved'))) return
            if (draftFailure) pendingDraft = undefined
        }
        screen.value = 'library'
        saveError.value = ''
    } finally {
        saving.value = false
    }
})
function openReader(song: Song) {
    if (profileSwitching.value) return
    const parsed = parseLyrics(song.lyrics)
    if (
        !validSettings(song.settings) ||
        parsed.errors.length ||
        !parsed.items.some((i) => i.kind === 'lyric')
    ) {
        void begin(song)
        saveError.value = !validSettings(song.settings)
            ? t('settingsError')
            : parsed.errors.length
              ? t('invalidCodes')
              : t('noLyrics')
        return
    }
    reading.value = structuredClone(toRaw(song))
    screen.value = 'reader'
}
const remove = localAction(async () => {
    if (profileSwitching.value) return
    try {
        if (library && deleting.value) {
            await library.remove(deleting.value.id)
            await refresh()
            deleting.value = undefined
            scheduleSync()
        }
    } catch {
        error.value = t('storageError')
    }
})
const discard = localAction(async (id: string) => {
    if (profileSwitching.value) return
    try {
        await library?.discardDraft(id)
        scheduleSync()
        await refresh()
    } catch {
        error.value = t('storageError')
    }
})
const readerSettings = localAction(async (settings: ReaderSettings) => {
    if (!reading.value || profileSwitching.value) return
    reading.value.settings = { ...reading.value.settings, ...settings }
    try {
        if (!library) throw new Error('storageUnavailable')
        if (!(await library.updateReaderSettings(reading.value.id, settings)))
            error.value = t('songRemoved')
        await refresh()
        scheduleSync()
    } catch {
        error.value = t('storageError')
    }
})
function stashDraft() {
    if (screen.value === 'editor' && pendingDraft) void flushDraft()
}
function visibilityChanged() {
    if (document.visibilityState === 'hidden') stashDraft()
}
async function remoteLibraryChange() {
    try {
        // Also recover suspended tabs or browsers without BroadcastChannel.
        if (library && !(await library.isCurrent())) {
            await profileRemoved(new MessageEvent('message', { data: activeProfile.value }))
            return
        }
        if (registry && !(await registry.isCurrent())) {
            registry.close()
            registry = new Library(await openLibrary())
        }
        if (registry) profiles.value = await registry.profiles()
    } catch {
        error.value = t('storageError')
        return
    }
    if (screen.value === 'library') {
        void syncAccount()
        void refresh().catch(() => {
            error.value = t('storageError')
        })
    }
}
function sharedHash() {
    return location.hash.startsWith('#song=')
        ? (new URLSearchParams(location.hash.slice(1)).get('song') ?? '')
        : undefined
}
let sharedNavigation = 0
const hashChanged = localAction(async () => {
    const navigation = ++sharedNavigation
    const id = sharedHash()
    if (id === undefined) {
        if (screen.value === 'shared') closeShared(false)
        return
    }
    // Finish earlier local actions before they can navigate away from the shared reader.
    // localAction registers this navigation only after this snapshot has been captured.
    await Promise.allSettled([...localTasks])
    if (navigation !== sharedNavigation) return
    if (screen.value === 'editor') {
        saving.value = true
        try {
            await flushDraft()
            if (navigation !== sharedNavigation) return
            if (draftFailure && !window.confirm(t('unsaved'))) {
                history.replaceState(null, '', location.pathname + location.search)
                return
            }
            if (draftFailure) pendingDraft = undefined
        } finally {
            saving.value = false
        }
    }
    if (navigation !== sharedNavigation) return
    sharedId.value = id
    screen.value = 'shared'
})
function closeShared(clearHash = true) {
    sharedNavigation++
    if (clearHash) history.replaceState(null, '', location.pathname + location.search)
    sharedId.value = undefined
    screen.value = 'library'
    if (!ready.value) void init()
}
onMounted(() => {
    if (sharedId.value === undefined) void init()
    window.addEventListener('hashchange', hashChanged)
    navigator.serviceWorker?.addEventListener('controllerchange', controllerChanged)
    profileChannel?.addEventListener('message', profileRemoved)
    window.addEventListener('online', net)
    window.addEventListener('offline', net)
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('focus', remoteLibraryChange)
    window.addEventListener('pagehide', stashDraft)
    document.addEventListener('visibilitychange', visibilityChanged)
})
onBeforeUnmount(() => {
    sharedNavigation++
    window.removeEventListener('hashchange', hashChanged)
    clearTimeout(draftTimer)
    clearTimeout(syncTimer)
    profileRevision++
    library?.close()
    registry?.close()
    profileChannel?.close()
    navigator.serviceWorker?.removeEventListener('controllerchange', controllerChanged)
    window.removeEventListener('online', net)
    window.removeEventListener('offline', net)
    window.removeEventListener('beforeunload', beforeUnload)
    window.removeEventListener('focus', remoteLibraryChange)
    window.removeEventListener('pagehide', stashDraft)
    document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
    <div class="app-shell" :class="{ 'reading-shell': screen === 'reader' || screen === 'shared' }">
        <header
            v-if="screen !== 'reader' && screen !== 'shared'"
            class="app-header"
            :inert="updateBusy"
        >
            <a href="/" class="brand" @click.prevent="back"
                ><span class="brand-mark" aria-hidden="true">≋</span>LyricFlow</a
            >
            <div class="header-actions">
                <a v-if="screen === 'library'" class="support-nav" href="/support">{{
                    t('support')
                }}</a>
                <button
                    v-if="screen === 'library' && accountSession?.enabled"
                    class="quiet account-button"
                    :disabled="profileSwitching"
                    :title="accountSession.user?.pseudonym ?? t('account')"
                    @click="screen = 'account'"
                >
                    {{ accountSession.user?.pseudonym ?? t('account') }}
                    <span
                        v-if="accountSession.user?.supporter"
                        class="supporter-badge"
                        :title="t('supporter')"
                        >♡</span
                    >
                </button>
                <span class="connectivity"
                    ><i :class="{ disconnected: !online }" />{{
                        online ? t('local') : t('offline')
                    }}</span
                ><button
                    class="theme-toggle"
                    :disabled="profileSwitching"
                    :aria-label="theme === 'dark' ? t('lightTheme') : t('darkTheme')"
                    @click="setTheme"
                >
                    {{ theme === 'dark' ? '☀' : '☾' }}
                </button>
            </div>
        </header>
        <div v-if="error" class="notice error global-error" role="alert">
            {{ error }} <button v-if="!ready" @click="init">{{ t('retry') }}</button
            ><button v-else class="quiet" :aria-label="t('close')" @click="error = ''">×</button>
        </div>
        <p v-if="ready && profileSwitching" class="notice" role="status">
            {{ t('loadingLibrary') }}
        </p>
        <SupportPanel
            v-if="screen === 'support'"
            :account="accountSession?.user"
            @refresh="syncAccount()"
        />
        <SharedPrompter
            v-else-if="screen === 'shared' && sharedId !== undefined"
            :id="sharedId"
            :theme="theme"
            @close="closeShared()"
            @theme="applyTheme(theme === 'light' ? 'dark' : 'light')"
        />
        <template v-else-if="ready && !profileSwitching">
            <main
                v-if="screen === 'library'"
                class="screen library"
                :inert="updateBusy"
                :aria-busy="updateBusy"
            >
                <div class="profile-controls">
                    <label
                        >{{ t('localProfile')
                        }}<select :value="activeProfile" @change="profileChanged">
                            <option
                                v-for="profile in profiles"
                                :key="profile.id"
                                :value="profile.id"
                            >
                                {{ profile.id === 'guest' ? t('guestProfile') : profile.label }}
                            </option>
                        </select></label
                    >
                    <button
                        v-if="member && accountSession?.user?.id === activeProfile"
                        class="quiet"
                        @click="copyGuest"
                    >
                        {{ t('copyGuest') }}
                    </button>
                    <button
                        class="quiet"
                        :disabled="accountSession?.user?.id === activeProfile"
                        @click="removeLocalLibrary"
                    >
                        {{ t('removeLocalLibrary') }}
                    </button>
                </div>
                <p v-if="accountSession?.user?.id === activeProfile" class="local-note">
                    {{ t('removeLocalLibrarySignOut') }}
                </p>
                <nav
                    v-if="accountSession?.user"
                    class="actions library-navigation"
                    :aria-label="t('community')"
                >
                    <button @click="openCommunity()">{{ t('community') }}</button>
                    <button v-if="accountSession.user.role !== 'member'" @click="openModeration">
                        {{ t('moderation') }}
                    </button>
                    <button v-if="songs.some((song) => song.source)" @click="checkSourceUpdates">
                        {{ t('checkUpdates') }}
                    </button>
                </nav>
                <p v-if="profileMessage" role="status" class="notice">{{ profileMessage }}</p>
                <div class="sync-status" role="status">
                    {{
                        t(
                            (
                                {
                                    saved: 'saved',
                                    pending: 'syncPending',
                                    syncing: 'syncing',
                                    synced: 'synced',
                                    signin: 'signInToSync',
                                    error: 'syncError',
                                } as const
                            )[syncState],
                        )
                    }}
                    <button
                        v-if="activeProfile !== 'guest'"
                        class="quiet"
                        :disabled="syncState === 'syncing'"
                        @click="syncPrivate"
                    >
                        {{ t('syncNow') }}
                    </button>
                </div>
                <section v-if="conflicts.length" class="notice" :aria-label="t('syncConflicts')">
                    <h2>{{ t('syncConflicts') }}</h2>
                    <p>{{ t('conflictHint') }}</p>
                    <article v-for="entry in conflicts" :key="entry.key" class="conflict-card">
                        <h3>
                            {{
                                songs.find((s) => `song.${s.id}` === entry.key)?.title ||
                                t('untitled')
                            }}
                        </h3>
                        <details>
                            <summary>{{ t('compareVersions') }}</summary>
                            <h4>{{ t('deviceVersion') }}</h4>
                            <SyncVersion
                                :value="{
                                    song: songs.find((s) => `song.${s.id}` === entry.key) ?? null,
                                    draft: drafts.find((s) => `song.${s.id}` === entry.key) ?? null,
                                }"
                            />
                            <h4>{{ t('serverVersion') }}</h4>
                            <SyncVersion :value="entry.conflict?.value ?? null" />
                        </details>
                        <div class="actions">
                            <button @click="resolveConflict(entry, 'local')">
                                {{ t('keepDevice') }}
                            </button>
                            <button @click="resolveConflict(entry, 'server')">
                                {{ t('keepServer') }}
                            </button>
                            <button @click="resolveConflict(entry, 'both')">
                                {{ t('keepBoth') }}
                            </button>
                        </div>
                    </article>
                </section>
                <p v-if="sharingNetworkError" class="notice error" role="status">
                    {{ sharingNetworkError }}
                </p>
                <div class="screen-heading">
                    <div>
                        <p class="eyebrow">{{ t('tagline') }}</p>
                        <h1>{{ t('library') }}</h1>
                        <p class="muted">{{ t('intro') }}</p>
                    </div>
                    <button class="primary" @click="begin()">+ {{ t('newSong') }}</button>
                </div>
                <div class="library-meta">
                    <span>{{
                        t(
                            member
                                ? 'memberNotice'
                                : activeProfile === 'guest'
                                  ? 'limitNotice'
                                  : 'signedOutProfile',
                            { count: songs.length },
                        )
                    }}</span
                    ><span>{{ t('private') }}</span>
                </div>
                <label v-if="songs.length"
                    >{{ t('searchLibrary')
                    }}<input v-model="librarySearch" type="search" maxlength="200"
                /></label>
                <div v-if="!songs.length" class="empty-state">
                    <span class="empty-mark" aria-hidden="true">≋</span>
                    <h2>{{ t('noSongs') }}</h2>
                    <p>{{ t('noSongsHint') }}</p>
                    <button @click="begin(demoSong())">{{ t('tryDemo') }}</button>
                </div>
                <ul v-else class="song-list">
                    <li v-for="song in filteredSongs" :key="song.id" class="song-card">
                        <button class="song-open" @click="openReader(song)">
                            <span class="song-icon" aria-hidden="true">♫</span
                            ><span class="song-text"
                                ><strong
                                    >{{ song.title || t('untitled') }}
                                    <SharingStatus :entry="sharingEntries[song.id]" badge-only
                                /></strong>
                                <span>{{ song.artist || t('unknownArtist') }}</span></span
                            ><span class="song-tempo"
                                >{{ song.settings.bpm }} <small>BPM</small></span
                            >
                        </button>
                        <div v-if="song.source" class="source-status">
                            <button class="quiet" @click="openCommunity(song.source.publicationId)">
                                {{ t('sourceVersion', { revision: song.source.revision }) }}
                            </button>
                            <span
                                v-if="sourceUpdates[song.source.publicationId]?.available === false"
                                >{{ t('sourceUnavailable') }}</span
                            >
                            <template
                                v-else-if="
                                    (sourceUpdates[song.source.publicationId]?.revision ?? 0) >
                                    song.source.revision
                                "
                            >
                                <span>{{
                                    t('updateAvailable', {
                                        revision:
                                            sourceUpdates[song.source.publicationId]!.revision!,
                                    })
                                }}</span>
                                <button class="quiet" @click="updateCopy(song)">
                                    {{ t('applySourceUpdate') }}
                                </button>
                                <button class="quiet" @click="downloadSource(song)">
                                    {{ t('downloadNewCopy') }}
                                </button>
                            </template>
                        </div>
                        <SharingStatus :entry="sharingEntries[song.id]" details-only />
                        <div class="song-actions">
                            <button
                                v-if="accountSession?.user?.id === activeProfile"
                                class="quiet"
                                @click="openSharing(song)"
                            >
                                {{ t('shareSong') }}
                            </button>
                            <span
                                v-if="drafts.some((d) => d.id === song.id)"
                                class="draft-indicator"
                                >{{ t('drafts') }}</span
                            ><button class="quiet" @click="begin(song)">{{ t('edit') }}</button
                            ><button
                                class="quiet"
                                :aria-label="`${t('delete')} ${song.title}`"
                                @click="deleting = song"
                            >
                                ×
                            </button>
                        </div>
                    </li>
                </ul>
                <section v-if="unpublishedDrafts.length" class="draft-list">
                    <h2>{{ t('drafts') }}</h2>
                    <div v-for="draft in unpublishedDrafts" :key="draft.id" class="draft-card">
                        <strong>{{ draft.title || t('untitled') }}</strong>
                        <div class="actions">
                            <button @click="begin(draft)">{{ t('resumeDraft') }}</button
                            ><button class="quiet" @click="discard(draft.id)">
                                {{ t('discard') }}
                            </button>
                        </div>
                    </div>
                </section>
                <p class="local-note">{{ t('localNotice') }}</p>
            </main>
            <CommunityPanel
                v-else-if="screen === 'community' && accountSession?.user"
                :key="initialPublication ?? 'catalog'"
                :account="accountSession.user"
                :initial-publication="initialPublication"
                @close="screen = 'library'"
                @download="download"
                @moderate="moderate"
            />
            <PublishPanel
                v-else-if="screen === 'publish' && sharing && accountSession?.user"
                :song="sharing"
                :account="accountSession.user"
                @close="screen = sharingReturn"
                @published="publicationChanged"
            />
            <ModerationPanel
                v-else-if="screen === 'moderation' && accountSession?.user"
                :account="accountSession.user"
                :initial-target="moderationTarget"
                @close="screen = 'library'"
                @changed="syncAccount()"
            />
            <AccountPanel
                v-else-if="screen === 'account'"
                :session="accountSession"
                @changed="accountChanged"
                @deleted="accountDeleted"
                @refresh="syncAccount"
                @close="screen = 'library'"
            />
            <SongEditor
                v-else-if="screen === 'editor' && editing"
                :key="editing.id"
                :song="editing"
                :saved-state="savedState"
                :busy="saving || updateBusy"
                :save-error="saveError"
                :sharing="sharingEntries[editing.id]"
                :sharing-unknown="
                    activeProfile !== 'guest' && !sharingStatusKnown && !sharingEntries[editing.id]
                "
                :sharing-saving="sharingSaving"
                :sharing-error="sharingNetworkError"
                :sharing-editable="accountSession?.user?.id === activeProfile"
                @auto-share="changeAutoSharing"
                @draft="queueDraft"
                @save="save"
                @read="read"
                @back="back"
            />
            <Prompter
                v-else-if="screen === 'reader' && reading"
                :song="reading"
                :theme="theme"
                @close="screen = 'library'"
                @settings="readerSettings"
                @theme="setTheme"
            >
                <template #share="{ running }">
                    <ShareLink
                        :key="`${activeProfile}:${accountSession?.user?.id}`"
                        :song="reading"
                        :running="running"
                        :account-id="
                            accountSession?.user?.id === activeProfile ? activeProfile : undefined
                        "
                        @publish="openSharing(reading, true)"
                    />
                </template>
            </Prompter>
        </template>
        <footer v-if="screen !== 'reader' && screen !== 'shared'" class="app-footer">
            <span>LyricFlow</span><span>{{ t('tagline') }}</span>
            <a href="/support" class="support-nav">♡ {{ t('support') }}</a>
        </footer>
        <p
            v-if="
                screen !== 'reader' &&
                screen !== 'shared' &&
                !updateDismissed &&
                (needRefresh || updateActivated || offlineReady)
            "
            class="pwa-message"
            role="status"
        >
            <span>{{
                updateError ||
                (updateBusy
                    ? t('updating')
                    : needRefresh || updateActivated
                      ? t(canUpdate ? 'update' : 'updateDeferred')
                      : t('availableOffline'))
            }}</span>
            <button
                v-if="(needRefresh || updateActivated) && canUpdate"
                class="primary"
                :disabled="updateBusy || !ready || profileSwitching"
                @click="applyUpdate"
            >
                {{ t('updateNow') }}
            </button>
            <button
                class="quiet"
                :disabled="updateBusy"
                :aria-label="t('close')"
                @click="dismissPwa"
            >
                ×
            </button>
        </p>
        <div
            v-if="deleting"
            :inert="updateBusy"
            class="modal-shade"
            @click.self="deleting = undefined"
        >
            <section role="dialog" aria-modal="true" :aria-label="t('deleteTitle')" class="modal">
                <h2>{{ t('deleteTitle') }}</h2>
                <p>{{ t('deleteHint') }}</p>
                <div class="actions">
                    <button @click="deleting = undefined">{{ t('cancel') }}</button
                    ><button class="danger" @click="remove">{{ t('confirmDelete') }}</button>
                </div>
            </section>
        </div>
    </div>
</template>
