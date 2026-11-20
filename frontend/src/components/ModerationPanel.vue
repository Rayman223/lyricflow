<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { accountGet, accountRequest, type Account } from '../accounts/client'
import type { SharedContent } from '../domain/song'
import type { CatalogSong, ModerationTarget } from '../community/model'
import { t } from '../i18n/en'
import { formatDateTime } from '../i18n/dates'

interface Report {
    id: string
    target_type: ModerationTarget['type']
    target_id: string
    reason: string
    details: string | null
    status: string
    decision: string | null
    assigned_to: string | null
    target: SharedContent | string | null
}
interface ManagedUser {
    id: string
    pseudonym: string
    email: string
    role: string
    banned_at: string | null
    email_verified_at: string | null
}
interface Event {
    id: number
    action: string
    target_type: string
    reason: string
    pseudonym: string | null
    created_at: string
}
const props = defineProps<{ account: Account; initialTarget?: ModerationTarget }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const tab = ref<'reports' | 'actions' | 'events' | 'users' | 'catalog' | 'settings'>('reports')
const busy = ref(false),
    error = ref(''),
    message = ref(''),
    page = ref(1),
    more = ref(false),
    status = ref('open'),
    query = ref('')
const reports = ref<Report[]>([]),
    users = ref<ManagedUser[]>([]),
    songs = ref<CatalogSong[]>([]),
    events = ref<Event[]>([])
const target = ref<ModerationTarget>(),
    action = ref('hide'),
    reason = ref(''),
    mergeTarget = ref<Record<string, string>>({})
const settings = ref({ publishing_enabled: true, reviews_enabled: true })
async function run(task: () => Promise<void>) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    message.value = ''
    try {
        await task()
    } catch (e) {
        error.value = e instanceof Error ? e.message : t('accountNetworkError')
    } finally {
        busy.value = false
    }
}
async function load(nextTab: typeof tab.value = tab.value, append = false) {
    await run(async () => {
        const next = append ? page.value + 1 : 1
        tab.value = nextTab
        if (nextTab === 'actions') return
        if (nextTab === 'settings') {
            const data = await accountGet<{ settings: typeof settings.value }>(
                '/api/admin/settings',
            )
            settings.value = data.settings
            more.value = false
            return
        }
        const prefix = ['users', 'catalog'].includes(nextTab) ? '/api/admin' : '/api/moderation'
        const data = await accountGet<{
            reports?: Report[]
            users?: ManagedUser[]
            songs?: CatalogSong[]
            events?: Event[]
            more: boolean
        }>(
            `${prefix}/${nextTab}?page=${next}&q=${encodeURIComponent(query.value)}&status=${status.value}`,
        )
        if (data.reports)
            reports.value = append ? [...reports.value, ...data.reports] : data.reports
        if (data.users) users.value = append ? [...users.value, ...data.users] : data.users
        if (data.songs) songs.value = append ? [...songs.value, ...data.songs] : data.songs
        if (data.events) events.value = append ? [...events.value, ...data.events] : data.events
        page.value = next
        more.value = data.more
    })
}
function moderate(next: ModerationTarget) {
    target.value = next
    action.value = next.type === 'user' ? 'ban' : 'hide'
    reason.value = ''
    tab.value = 'actions'
}
async function mutate(path: string, body: Record<string, unknown>) {
    await run(async () => {
        const data = await accountRequest<{ message: string }>(path, {
            accountId: props.account.id,
            ...body,
        })
        message.value = data.message
        emit('changed')
    })
}
async function saveReport(report: Report) {
    await mutate(`/api/moderation/reports/${report.id}`, {
        status: report.status,
        decision: report.decision,
    })
}
async function saveAction() {
    if (!target.value) return
    await mutate('/api/moderation/actions', {
        targetType: target.value.type,
        targetId: target.value.id,
        action: action.value,
        reason: reason.value,
    })
}
async function saveRole(user: ManagedUser) {
    await mutate(`/api/admin/users/${user.id}/role`, { role: user.role, reason: reason.value })
}
async function editSong(song: CatalogSong) {
    await mutate(`/api/admin/catalog/${song.id}`, {
        title: song.title,
        artist: song.artist,
        reason: reason.value,
    })
}
async function mergeSong(song: CatalogSong) {
    if (!confirm(t('mergeConfirm'))) return
    await mutate(`/api/admin/catalog/${song.id}/merge`, {
        targetId: mergeTarget.value[song.id],
        reason: reason.value,
    })
    if (!error.value) await load('catalog')
}
onMounted(() => {
    if (props.initialTarget) moderate(props.initialTarget)
    else void load()
})
</script>

<template>
    <main class="screen moderation-screen">
        <div class="screen-heading">
            <h1>{{ t('moderation') }}</h1>
            <button :disabled="busy" @click="emit('close')">{{ t('back') }}</button>
        </div>
        <nav class="actions" :aria-label="t('moderation')">
            <button :disabled="busy" @click="load('reports')">{{ t('reports') }}</button
            ><button :disabled="busy" @click="load('events')">{{ t('moderationLog') }}</button
            ><template v-if="account.role === 'admin'"
                ><button :disabled="busy" @click="load('users')">{{ t('users') }}</button
                ><button :disabled="busy" @click="load('catalog')">{{ t('manageCatalog') }}</button
                ><button :disabled="busy" @click="load('settings')">
                    {{ t('serviceSettings') }}
                </button></template
            >
        </nav>
        <p class="notice">{{ t('moderationPrivacy') }}</p>
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <p v-if="message" role="status" class="notice">{{ message }}</p>
        <p v-if="busy" role="status">{{ t('loading') }}</p>
        <template v-if="tab === 'reports'">
            <form class="actions" @submit.prevent="load('reports')">
                <label
                    >{{ t('reportStatus')
                    }}<select :aria-label="t('reportStatus')" v-model="status">
                        <option value="open">{{ t('statusOpen') }}</option>
                        <option value="in_progress">{{ t('statusProgress') }}</option>
                        <option value="closed">{{ t('statusClosed') }}</option>
                    </select></label
                ><button :disabled="busy">{{ t('refresh') }}</button>
            </form>
            <p v-if="!reports.length && !busy">{{ t('noReports') }}</p>
            <article v-for="report in reports" :key="report.id" class="community-card">
                <h2>
                    {{
                        t(
                            report.target_type === 'publication'
                                ? 'reportPublication'
                                : report.target_type === 'user'
                                  ? 'reportUser'
                                  : 'reportComment',
                        )
                    }}
                </h2>
                <p>{{ report.reason }} · {{ report.details }}</p>
                <template v-if="report.target && typeof report.target === 'object'"
                    ><h3>{{ report.target.title }} · {{ report.target.artist }}</h3>
                    <pre class="lyrics-preview">{{ report.target.lyrics }}</pre>
                </template>
                <p v-else class="user-comment">{{ report.target ?? t('sourceUnavailable') }}</p>
                <button
                    :disabled="busy"
                    @click="
                        moderate({
                            type: report.target_type,
                            id: report.target_id,
                            label:
                                report.target && typeof report.target === 'object'
                                    ? report.target.title
                                    : String(report.target ?? t('sourceUnavailable')),
                        })
                    "
                >
                    {{ t('moderateTarget') }}
                </button>
                <form class="account-form" @submit.prevent="saveReport(report)">
                    <label
                        >{{ t('reportStatus')
                        }}<select :aria-label="t('reportStatus')" v-model="report.status">
                            <option value="open">{{ t('statusOpen') }}</option>
                            <option value="in_progress">{{ t('statusProgress') }}</option>
                            <option value="closed">{{ t('statusClosed') }}</option>
                        </select></label
                    ><label
                        >{{ t('decision')
                        }}<textarea
                            v-model="report.decision"
                            :required="report.status === 'closed'"
                            maxlength="2000"
                            rows="2"
                        /></label
                    ><button :disabled="busy">{{ t('saveDecision') }}</button>
                </form>
            </article>
        </template>
        <form
            v-else-if="tab === 'actions' && target"
            class="account-form"
            @submit.prevent="saveAction"
        >
            <h2>{{ t('moderateTarget') }}: {{ target.label }}</h2>
            <label
                >{{ t('moderationAction')
                }}<select :aria-label="t('moderationAction')" v-model="action">
                    <template v-if="target.type === 'user'"
                        ><option value="ban">{{ t('banUser') }}</option>
                        <option value="unban">{{ t('unbanUser') }}</option></template
                    ><template v-else
                        ><option value="hide">{{ t('hideContent') }}</option>
                        <option value="restore">{{ t('restoreContent') }}</option></template
                    >
                </select></label
            ><label
                >{{ t('reason')
                }}<textarea v-model="reason" required maxlength="500" rows="3" /></label
            ><button :disabled="busy">{{ t('applyAction') }}</button>
        </form>
        <template v-else-if="tab === 'events'"
            ><h2>{{ t('moderationLog') }}</h2>
            <article v-for="event in events" :key="event.id" class="community-card">
                <p>
                    {{ event.action }} · {{ event.target_type }} ·
                    {{ event.pseudonym ?? 'Anonymous' }} ·
                    <time :datetime="event.created_at">{{ formatDateTime(event.created_at) }}</time>
                </p>
                <p>{{ event.reason }}</p>
            </article></template
        >
        <template v-else-if="tab === 'users'">
            <h2>{{ t('users') }}</h2>
            <form class="actions" @submit.prevent="load('users')">
                <label
                    >{{ t('searchUsers')
                    }}<input v-model="query" maxlength="200" type="search" /></label
                ><button :disabled="busy">{{ t('search') }}</button>
            </form>
            <label>{{ t('reason') }}<input v-model="reason" maxlength="500" /></label>
            <article v-for="user in users" :key="user.id" class="community-card">
                <h3>{{ user.pseudonym }}</h3>
                <p>
                    {{ user.email }} · {{ user.banned_at ? t('banned') : t('activeUser') }} ·
                    {{ user.email_verified_at ? t('emailVerified') : t('emailNotVerified') }}
                </p>
                <form class="actions" @submit.prevent="saveRole(user)">
                    <label
                        >{{ t('role')
                        }}<select :aria-label="t('role')" v-model="user.role">
                            <option value="member">{{ t('roleMember') }}</option>
                            <option value="moderator">{{ t('roleModerator') }}</option>
                            <option value="admin">{{ t('roleAdmin') }}</option>
                        </select></label
                    ><button :disabled="busy || !reason.trim()">{{ t('saveRole') }}</button
                    ><button
                        type="button"
                        :disabled="busy"
                        @click="moderate({ type: 'user', id: user.id, label: user.pseudonym })"
                    >
                        {{ t('moderateTarget') }}
                    </button>
                </form>
            </article>
        </template>
        <template v-else-if="tab === 'catalog'">
            <h2>{{ t('manageCatalog') }}</h2>
            <form class="actions" @submit.prevent="load('catalog')">
                <label
                    >{{ t('searchCatalog')
                    }}<input v-model="query" maxlength="200" type="search" /></label
                ><button :disabled="busy">{{ t('search') }}</button>
            </form>
            <label>{{ t('reason') }}<input v-model="reason" maxlength="500" /></label>
            <article v-for="song in songs" :key="song.id" class="community-card">
                <form class="account-form" @submit.prevent="editSong(song)">
                    <label
                        >{{ t('title')
                        }}<input v-model="song.title" required maxlength="200" /></label
                    ><label>{{ t('artist') }}<input v-model="song.artist" maxlength="200" /></label
                    ><button :disabled="busy || !reason.trim()">{{ t('saveCatalogSong') }}</button>
                </form>
                <form class="account-form" @submit.prevent="mergeSong(song)">
                    <label
                        >{{ t('mergeInto')
                        }}<select
                            :aria-label="t('mergeInto')"
                            v-model="mergeTarget[song.id]"
                            required
                        >
                            <option
                                v-for="other in songs.filter((s) => s.id !== song.id)"
                                :key="other.id"
                                :value="other.id"
                            >
                                {{ other.title }} · {{ other.artist }}
                            </option>
                        </select></label
                    ><button :disabled="busy || !reason.trim()">{{ t('mergeSongs') }}</button>
                </form>
            </article>
        </template>
        <form
            v-else-if="tab === 'settings'"
            class="account-form"
            @submit.prevent="
                mutate('/api/admin/settings', {
                    publishingEnabled: settings.publishing_enabled,
                    reviewsEnabled: settings.reviews_enabled,
                    reason,
                })
            "
        >
            <h2>{{ t('serviceSettings') }}</h2>
            <label class="check-row"
                ><input v-model="settings.publishing_enabled" type="checkbox" />{{
                    t('allowPublishing')
                }}</label
            ><label class="check-row"
                ><input v-model="settings.reviews_enabled" type="checkbox" />{{
                    t('allowReviews')
                }}</label
            ><label
                >{{ t('reason')
                }}<textarea v-model="reason" required maxlength="500" rows="2" /></label
            ><button :disabled="busy">{{ t('saveServiceSettings') }}</button>
        </form>
        <button
            v-if="more && tab !== 'actions' && tab !== 'settings'"
            :disabled="busy"
            @click="load(tab, true)"
        >
            {{ t('loadMore') }}
        </button>
    </main>
</template>
