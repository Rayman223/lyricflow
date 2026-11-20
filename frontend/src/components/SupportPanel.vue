<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { accountGet, accountRequest, type Account } from '../accounts/client'
import { t } from '../i18n/en'

const emit = defineEmits<{ refresh: [] }>()
const props = defineProps<{ account: Account | null | undefined }>()
interface SupportData {
    year: number
    goalCents: number
    coveredCents: number | null
    percent: number | null
    donationUrl: string | null
    automatic: boolean
    supporters: { pseudonym: string; since: string }[]
    viewer: {
        id: string
        supporter: boolean
        public: boolean
        listed: boolean
        admin: boolean
    } | null
}
interface Donation {
    session_id: string
    amount_cents: number
    refunded_cents: number
    paid_at: string
    pseudonym: string | null
}
const data = ref<SupportData>(),
    error = ref(''),
    busy = ref(false),
    saving = ref(false)
const donations = ref<Donation[]>([]),
    ledgerLoading = ref(false),
    more = ref(false),
    page = ref(1),
    adminError = ref('')
let revision = 0
let active = true
const eur = (cents: number) =>
    new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR' }).format(cents / 100)
async function load() {
    const current = ++revision
    busy.value = true
    error.value = ''
    data.value = undefined
    donations.value = []
    ledgerLoading.value = false
    more.value = false
    page.value = 1
    adminError.value = ''
    try {
        const next = await accountGet<SupportData>('/api/support')
        if (current !== revision) return
        // A support response can predate a session change in another tab.
        if (
            props.account !== undefined &&
            ((next.viewer?.id ?? null) !== (props.account?.id ?? null) ||
                !!next.viewer?.admin !== (props.account?.role === 'admin'))
        ) {
            emit('refresh')
            throw new Error('Account context changed')
        }
        data.value = next
        emit('refresh')
        if (next.viewer?.admin) await loadDonations(false, current)
    } catch {
        if (current === revision) error.value = t('supportLoadError')
    } finally {
        if (current === revision) busy.value = false
    }
}
async function visibility() {
    const viewer = data.value?.viewer
    if (!viewer || saving.value) return
    const current = revision
    saving.value = true
    try {
        await accountRequest('/api/support/visibility', {
            accountId: viewer.id,
            public: !viewer.public,
        })
        // A focus refresh during this write can have read the previous visibility.
        // Always fetch the confirmed state, even if that refresh changed the revision.
        if (active) await load()
    } catch (e) {
        if (current === revision) error.value = e instanceof Error ? e.message : t('retry')
    } finally {
        saving.value = false
    }
}
async function loadDonations(append = false, current = revision) {
    if (current !== revision || ledgerLoading.value) return
    ledgerLoading.value = true
    const nextPage = append ? page.value + 1 : 1
    adminError.value = ''
    try {
        const next = await accountGet<{ donations: Donation[]; more: boolean }>(
            `/api/admin/support?page=${nextPage}`,
        )
        if (current !== revision) return
        donations.value = append ? [...donations.value, ...next.donations] : next.donations
        more.value = next.more
        page.value = nextPage
    } catch {
        if (current === revision) adminError.value = t('supportLoadError')
    } finally {
        if (current === revision) ledgerLoading.value = false
    }
}
onMounted(() => {
    void load()
    window.addEventListener('focus', load)
    window.addEventListener('online', load)
})
watch(
    () =>
        `${props.account === undefined ? 'unknown' : (props.account?.id ?? 'guest')}:${props.account?.role ?? ''}`,
    (_next, previous) => {
        // The first session response can arrive while the initial support read is
        // pending; its identity will be checked before that read is displayed.
        if (previous.startsWith('unknown:') && busy.value && !data.value) return
        void load()
    },
)
onBeforeUnmount(() => {
    active = false
    revision++
    window.removeEventListener('focus', load)
    window.removeEventListener('online', load)
})
</script>

<template>
    <main class="screen support-screen" :aria-busy="busy">
        <div class="support-topline">
            <a href="/">← {{ t('back') }}</a>
            <button class="quiet" :disabled="busy || saving" @click="load">
                {{ t('refresh') }}
            </button>
        </div>
        <header class="support-hero">
            <p class="eyebrow">{{ t('supportEyebrow') }}</p>
            <h1>{{ t('supportTitle') }}</h1>
            <p class="support-lead">{{ t('supportLead') }}</p>
            <p class="muted">{{ t('supportVoluntary') }}</p>
        </header>
        <p v-if="error" class="notice error" role="alert">{{ error }}</p>
        <p v-if="busy && !data" role="status">{{ t('loading') }}</p>
        <template v-if="data">
            <section
                v-if="data.goalCents > 0"
                class="support-funding"
                aria-labelledby="funding-title"
            >
                <div class="support-section-heading">
                    <div>
                        <p class="eyebrow">{{ t('supportFundingYear', { year: data.year }) }}</p>
                        <h2 id="funding-title">{{ t('supportFunding') }}</h2>
                    </div>
                    <span class="support-goal"
                        >{{ eur(data.goalCents) }}<small>{{ t('supportPerYear') }}</small></span
                    >
                </div>
                <p>{{ t('supportCosts') }}</p>
                <template v-if="data.coveredCents !== null && data.percent !== null">
                    <div class="support-progress-label">
                        <strong>{{
                            t('supportCovered', { amount: eur(data.coveredCents) })
                        }}</strong
                        ><span>{{ data.percent }}%</span>
                    </div>
                    <progress
                        :value="data.percent"
                        max="100"
                        :aria-label="t('supportFundingProgress', { percent: data.percent })"
                    >
                        {{ data.percent }}%
                    </progress>
                    <p class="muted">{{ t('supportFundingNote') }}</p>
                </template>
                <p v-else class="muted">{{ t('supportTrackingUnavailable') }}</p>
            </section>
            <div class="support-ways">
                <section class="support-card support-donate" aria-labelledby="donate-title">
                    <span class="support-heart" aria-hidden="true">♡</span>
                    <h2 id="donate-title">{{ t('supportDonateTitle') }}</h2>
                    <p>{{ t('supportDonateBody') }}</p>
                    <a
                        v-if="data.donationUrl"
                        class="support-donate-button"
                        :href="data.donationUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                        >{{ t('supportDonate') }} <span aria-hidden="true">↗</span></a
                    >
                    <p v-else class="notice" role="status">{{ t('supportNotConfigured') }}</p>
                    <p class="muted">{{ t('supportStripeNote') }}</p>
                    <p v-if="data.automatic" class="muted">
                        {{ t(data.viewer ? 'supportAutomatic' : 'supportGuest') }}
                    </p>
                    <p v-else class="muted">{{ t('supportManual') }}</p>
                    <a v-if="!data.viewer" href="/#account">{{ t('supportSignIn') }}</a>
                </section>
                <section class="support-card" aria-labelledby="free-support-title">
                    <p class="eyebrow">{{ t('supportFreeEyebrow') }}</p>
                    <h2 id="free-support-title">{{ t('supportFreeTitle') }}</h2>
                    <p>{{ t('supportFreeBody') }}</p>
                    <ul class="support-free-list">
                        <li>{{ t('supportShare') }}</li>
                        <li>{{ t('supportCommunity') }}</li>
                        <li>
                            <a
                                href="https://github.com/Rayman223/lyricflow/issues"
                                target="_blank"
                                rel="noopener noreferrer"
                                >{{ t('supportFeedback') }}</a
                            >
                        </li>
                    </ul>
                </section>
            </div>
            <section class="support-thanks" aria-labelledby="supporter-title">
                <span class="supporter-badge">♡ {{ t('supporter') }}</span>
                <h2 id="supporter-title">{{ t('supportBadgeTitle') }}</h2>
                <p>{{ t('supportBadgeBody') }}</p>
                <p class="muted">{{ t('supportBadgePrivacy') }}</p>
                <div v-if="data.viewer?.supporter" class="support-visibility">
                    <p>
                        {{
                            t(
                                data.viewer.public
                                    ? data.viewer.listed
                                        ? 'supportListed'
                                        : 'supportBeyondWall'
                                    : 'supportHidden',
                            )
                        }}
                    </p>
                    <button :disabled="busy || saving" @click="visibility">
                        {{ t(data.viewer.public ? 'supportHide' : 'supportShow') }}
                    </button>
                </div>
            </section>
            <section class="support-wall-section" aria-labelledby="wall-title">
                <h2 id="wall-title">{{ t('supportWall') }}</h2>
                <p class="muted">{{ t('supportWallPrivacy') }}</p>
                <ul v-if="data.supporters.length" class="support-wall">
                    <li v-for="person in data.supporters" :key="person.pseudonym">
                        <span class="supporter-badge" aria-hidden="true">♡</span
                        ><strong>{{ person.pseudonym }}</strong
                        ><span class="muted">{{ t('supportSince', { date: person.since }) }}</span>
                    </li>
                </ul>
                <p v-else class="support-wall-empty">{{ t('supportWallEmpty') }}</p>
            </section>
            <section
                v-if="data.viewer?.admin"
                class="support-admin"
                aria-labelledby="support-admin-title"
            >
                <h2 id="support-admin-title">{{ t('supportAdminTitle') }}</h2>
                <p class="muted">{{ t('supportAdminPrivate') }}</p>
                <p v-if="adminError" class="notice error" role="alert">{{ adminError }}</p>
                <p v-if="!donations.length && !adminError">{{ t('supportNoDonations') }}</p>
                <ul class="support-ledger">
                    <li v-for="donation in donations" :key="donation.session_id">
                        <strong>{{ donation.pseudonym ?? t('supportAnonymous') }}</strong
                        ><span
                            >{{ eur(donation.amount_cents - donation.refunded_cents) }} ·
                            {{ donation.paid_at.slice(0, 10) }}</span
                        ><small v-if="donation.refunded_cents">{{
                            t('supportRefunded', { amount: eur(donation.refunded_cents) })
                        }}</small
                        ><code>{{ donation.session_id }}</code>
                    </li>
                </ul>
                <button v-if="more" :disabled="busy || ledgerLoading" @click="loadDonations(true)">
                    {{ t('loadMore') }}
                </button>
            </section>
            <p class="support-closing">{{ t('supportThanks') }}</p>
        </template>
    </main>
</template>

<style scoped>
.support-screen {
    display: grid;
    gap: 2rem;
    max-width: 880px;
    margin: auto;
}
.support-screen a {
    color: var(--accent-ink);
    text-underline-offset: 4px;
}
.support-topline,
.support-section-heading,
.support-progress-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
}
.support-topline {
    font-size: 0.85rem;
}
.support-hero {
    max-width: 640px;
    display: grid;
    gap: 0.8rem;
    padding: 0.75rem 0;
}
.support-hero h1 {
    margin: 0;
    font-size: clamp(2rem, 7vw, 3.2rem);
}
.support-lead {
    font-size: 1.1rem;
    color: var(--muted);
}
.support-funding {
    background: var(--accent-soft);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: clamp(20px, 4vw, 32px);
    display: grid;
    gap: 1rem;
}
.support-goal {
    font-size: 2rem;
    font-weight: 650;
    letter-spacing: -0.05em;
}
.support-goal small {
    display: block;
    font-size: 0.75rem;
    letter-spacing: 0;
    font-weight: 400;
    color: var(--muted);
}
.support-progress-label {
    font-size: 0.85rem;
}
progress {
    width: 100%;
    height: 10px;
    border: 0;
    border-radius: 10px;
    overflow: hidden;
    background: var(--border);
    accent-color: var(--accent);
}
progress::-webkit-progress-bar {
    background: var(--border);
}
progress::-webkit-progress-value {
    background: var(--accent);
    border-radius: 10px;
}
progress::-moz-progress-bar {
    background: var(--accent);
    border-radius: 10px;
}
.support-ways {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1.25rem;
}
.support-card {
    padding: clamp(20px, 4vw, 32px);
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
}
.support-heart {
    font-size: 2.5rem;
    line-height: 1;
    color: var(--accent-ink);
}
.support-card .support-donate-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    width: 100%;
    min-height: 48px;
    padding: 0.8rem 1rem;
    background: var(--accent);
    color: var(--accent-text);
    border-radius: 9px;
    text-decoration: none;
    font-weight: 650;
}
.support-free-list {
    display: grid;
    gap: 0.85rem;
    padding-left: 1.1rem;
    margin: 0;
}
.support-thanks,
.support-wall-section,
.support-admin {
    display: grid;
    gap: 0.9rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
}
.support-visibility {
    padding: 1rem;
    border-radius: 9px;
    background: var(--surface);
    display: grid;
    gap: 1rem;
    justify-items: start;
}
.support-wall,
.support-ledger {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
    padding: 0;
    margin: 0.5rem 0;
    list-style: none;
}
.support-wall li,
.support-ledger li {
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 9px;
    overflow-wrap: anywhere;
    min-width: 0;
}
.support-wall .muted,
.support-ledger code,
.support-ledger small {
    flex-basis: 100%;
    font-size: 0.75rem;
}
.support-ledger code {
    overflow-wrap: anywhere;
}
.support-wall-empty {
    color: var(--muted);
    padding: 1.5rem 0;
}
.support-closing {
    text-align: center;
    color: var(--accent-ink);
    padding: 1rem 0;
}
@media (max-width: 600px) {
    .support-ways,
    .support-wall,
    .support-ledger {
        grid-template-columns: 1fr;
    }
}
</style>
