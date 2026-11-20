<script setup lang="ts">
import ScoresPanel from './ScoresPanel.vue'
import { onMounted, ref } from 'vue'
import { accountGet, accountRequest, type Account } from '../accounts/client'
import type { Publication, CatalogSong, Rating, ModerationTarget } from '../community/model'
import { t } from '../i18n/en'
import { formatDateTime } from '../i18n/dates'

const props = defineProps<{ account: Account; initialPublication?: string }>()
const emit = defineEmits<{
    close: []
    download: [publication: Publication]
    moderate: [target: ModerationTarget]
}>()
const view = ref<'catalog' | 'versions' | 'publication' | 'mine'>('catalog')
const query = ref(''),
    sort = ref('title'),
    page = ref(1),
    more = ref(false),
    busy = ref(false),
    error = ref(''),
    message = ref('')
const songs = ref<CatalogSong[]>([]),
    versions = ref<Publication[]>([]),
    mine = ref<Publication[]>([])
const selectedSong = ref<CatalogSong>(),
    publication = ref<Publication>(),
    ratings = ref<Rating[]>([])
const stars = ref<number | ''>(''),
    comment = ref(''),
    hasRating = ref(false)
const reporting = ref<{ type: 'publication' | 'user' | 'rating'; id: string }>(),
    reason = ref('spam'),
    details = ref('')
let revision = 0
async function run(action: () => Promise<void>) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try {
        await action()
    } catch (e) {
        error.value = e instanceof Error ? e.message : t('accountNetworkError')
    } finally {
        busy.value = false
    }
}
async function catalog(append = false) {
    await run(async () => {
        const token = ++revision
        const next = append ? page.value + 1 : 1
        const data = await accountGet<{ songs: CatalogSong[]; more: boolean }>(
            `/api/community/catalog?q=${encodeURIComponent(query.value)}&sort=${sort.value}&page=${next}`,
        )
        if (token !== revision) return
        songs.value = append ? [...songs.value, ...data.songs] : data.songs
        page.value = next
        more.value = data.more
        view.value = 'catalog'
    })
}
async function showVersions(song: CatalogSong, append = false) {
    await run(async () => {
        const next = append ? page.value + 1 : 1
        const data = await accountGet<{ publications: Publication[]; more: boolean }>(
            `/api/community/catalog/${song.id}?page=${next}`,
        )
        selectedSong.value = song
        versions.value = append ? [...versions.value, ...data.publications] : data.publications
        page.value = next
        more.value = data.more
        view.value = 'versions'
    })
}
async function showPublication(id: string, append = false) {
    await run(async () => {
        const next = append ? page.value + 1 : 1
        const data = await accountGet<{
            publication: Publication
            ratings: Rating[]
            more: boolean
            ownRating: { stars: number; comment: string } | null
        }>(`/api/community/publications/${id}?page=${next}`)
        publication.value = data.publication
        ratings.value = append ? [...ratings.value, ...data.ratings] : data.ratings
        if (!append) {
            stars.value = data.ownRating?.stars ?? ''
            comment.value = data.ownRating?.comment ?? ''
            hasRating.value = !!data.ownRating
        }
        page.value = next
        more.value = data.more
        view.value = 'publication'
    })
}
async function showMine(append = false) {
    await run(async () => {
        const next = append ? page.value + 1 : 1
        const data = await accountGet<{ publications: Publication[]; more: boolean }>(
            `/api/community/mine?page=${next}`,
        )
        mine.value = append ? [...mine.value, ...data.publications] : data.publications
        page.value = next
        more.value = data.more
        view.value = 'mine'
    })
}
function ratingLabel(item: Publication) {
    return item.average === null
        ? t('noRatings')
        : t('ratingSummary', { average: Number(item.average).toFixed(1), count: item.ratingCount })
}
function startReport(type: 'publication' | 'user' | 'rating', id: string, copyright = false) {
    reporting.value = { type, id }
    reason.value = copyright ? 'copyright' : 'spam'
    details.value = ''
    message.value = ''
}
async function report() {
    if (!reporting.value) return
    await run(async () => {
        const data = await accountRequest<{ message: string }>('/api/community/reports', {
            accountId: props.account.id,
            targetType: reporting.value!.type,
            targetId: reporting.value!.id,
            reason: reason.value,
            details: details.value,
        })
        message.value = data.message
        reporting.value = undefined
    })
}
async function rate(remove = false) {
    const current = publication.value
    if (!current) return
    await run(async () => {
        const data = await accountRequest<{ message: string }>(
            `/api/community/publications/${current.id}/rating${remove ? '/remove' : ''}`,
            { accountId: props.account.id, stars: stars.value, comment: comment.value },
        )
        message.value = data.message
    })
    if (!error.value) await showPublication(current.id)
}
async function withdraw(item: Publication) {
    if (!confirm(t('withdrawConfirm'))) return
    await run(async () => {
        await accountRequest(`/api/community/publications/${item.id}/unpublish`, {
            accountId: props.account.id,
            expectedRevision: item.revision,
        })
        message.value = t('publicationWithdrawn')
    })
    if (!error.value) await showMine()
}
onMounted(() =>
    props.initialPublication ? void showPublication(props.initialPublication) : void catalog(),
)
</script>

<template>
    <main class="screen community-screen">
        <div class="screen-heading">
            <h1>{{ t('community') }}</h1>
            <button :disabled="busy" @click="emit('close')">{{ t('back') }}</button>
        </div>
        <nav class="actions" :aria-label="t('community')">
            <button :disabled="busy" @click="catalog()">{{ t('catalog') }}</button
            ><button :disabled="busy" @click="showMine()">{{ t('myPublications') }}</button>
        </nav>
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <p v-if="message" role="status" class="notice">{{ message }}</p>
        <p v-if="busy" role="status">{{ t('loading') }}</p>
        <template v-if="view === 'catalog'">
            <form class="catalog-search" @submit.prevent="catalog()">
                <label
                    >{{ t('searchCatalog')
                    }}<input v-model="query" maxlength="200" type="search" /></label
                ><label
                    >{{ t('sort')
                    }}<select :aria-label="t('sort')" v-model="sort">
                        <option value="title">{{ t('title') }}</option>
                        <option value="stars">{{ t('bestRated') }}</option>
                    </select></label
                ><button :disabled="busy">{{ t('search') }}</button>
            </form>
            <p v-if="!songs.length && !busy">{{ t('emptyCatalog') }}</p>
            <ul class="plain-list">
                <li v-for="song in songs" :key="song.id" class="community-card">
                    <button class="quiet" :disabled="busy" @click="showVersions(song)">
                        <strong>{{ song.title }}</strong> · {{ song.artist || t('unknownArtist') }}
                    </button>
                    <p>{{ t('versionCount', { count: song.version_count ?? 0 }) }}</p>
                </li>
            </ul>
            <button v-if="more" :disabled="busy" @click="catalog(true)">{{ t('loadMore') }}</button>
        </template>
        <template v-else-if="view === 'versions' && selectedSong">
            <h2>{{ selectedSong.title }} · {{ selectedSong.artist }}</h2>
            <ul class="plain-list">
                <li v-for="item in versions" :key="item.id" class="community-card">
                    <button :disabled="busy" @click="showPublication(item.id)">
                        {{ item.author }} · V.{{ item.revision }}
                    </button>
                    <p>{{ ratingLabel(item) }}</p>
                    <time :datetime="item.updatedAt">{{ formatDateTime(item.updatedAt) }}</time>
                </li>
            </ul>
            <button v-if="more" :disabled="busy" @click="showVersions(selectedSong, true)">
                {{ t('loadMore') }}
            </button>
        </template>
        <template v-else-if="view === 'publication' && publication">
            <h2>{{ publication.content.title }}</h2>
            <p>
                {{ publication.content.artist }} · {{ publication.author }} · V.{{
                    publication.revision
                }}
                ·
                <time :datetime="publication.updatedAt">{{
                    formatDateTime(publication.updatedAt)
                }}</time>
            </p>
            <p>{{ ratingLabel(publication) }}</p>
            <p v-if="publication.source">
                {{ t('adaptedFrom') }}
                <button
                    class="quiet"
                    :disabled="busy"
                    @click="showPublication(publication.source.publicationId)"
                >
                    {{ t('sourcePublication') }} · V.{{ publication.source.revision }}
                </button>
            </p>
            <pre class="lyrics-preview">{{ publication.content.lyrics }}</pre>
            <p>
                {{ publication.content.music.bpm }} BPM ·
                {{ publication.content.music.beatsPerBar }} {{ t('beats') }} ·
                {{ publication.content.music.barsPerLine }} {{ t('bars') }}
            </p>
            <ScoresPanel :arrangements="publication.content.arrangements" />
            <button class="primary" :disabled="busy" @click="emit('download', publication)">
                {{ t('savePrivateCopy') }}
            </button>
            <div v-if="account.role !== 'member'" class="actions">
                <button
                    @click="
                        emit('moderate', {
                            type: 'publication',
                            id: publication.id,
                            label: publication.content.title,
                        })
                    "
                >
                    {{ t('moderatePublication') }}</button
                ><button
                    v-if="publication.authorId"
                    @click="
                        emit('moderate', {
                            type: 'user',
                            id: publication.authorId,
                            label: publication.author,
                        })
                    "
                >
                    {{ t('moderateUser') }}
                </button>
            </div>
            <div class="actions">
                <button class="quiet" @click="startReport('publication', publication.id)">
                    {{ t('reportPublication') }}</button
                ><button class="quiet" @click="startReport('publication', publication.id, true)">
                    {{ t('requestRemoval') }}</button
                ><button
                    v-if="publication.authorId && publication.authorId !== account.id"
                    class="quiet"
                    @click="startReport('user', publication.authorId)"
                >
                    {{ t('reportUser') }}
                </button>
            </div>
            <form
                v-if="publication.authorId !== account.id"
                class="account-form"
                @submit.prevent="rate()"
            >
                <h3>{{ t('yourReview') }}</h3>
                <label
                    >{{ t('stars')
                    }}<select :aria-label="t('stars')" v-model="stars" required>
                        <option disabled value="">{{ t('chooseStars') }}</option>
                        <option v-for="value in [0, 1, 2, 3, 4, 5]" :key="value" :value="value">
                            {{ value }}
                        </option>
                    </select></label
                ><label
                    >{{ t('optionalComment')
                    }}<textarea v-model="comment" maxlength="2000" rows="3" /></label
                ><button :disabled="busy">{{ t('saveReview') }}</button
                ><button v-if="hasRating" type="button" :disabled="busy" @click="rate(true)">
                    {{ t('removeReview') }}
                </button>
            </form>
            <h3>{{ t('reviews') }}</h3>
            <p v-if="!ratings.length">{{ t('noRatings') }}</p>
            <article v-for="rating in ratings" :key="rating.id" class="community-card">
                <p>
                    <strong>{{ rating.author }}</strong> · {{ rating.stars }} / 5 ·
                    {{ t('reviewedRevision', { revision: rating.revision }) }}
                </p>
                <p class="user-comment">{{ rating.comment }}</p>
                <button
                    v-if="rating.comment && rating.authorId !== account.id"
                    class="quiet"
                    @click="startReport('rating', rating.id)"
                >
                    {{ t('reportComment') }}</button
                ><button
                    v-if="account.role !== 'member'"
                    class="quiet"
                    @click="
                        emit('moderate', { type: 'rating', id: rating.id, label: rating.author })
                    "
                >
                    {{ t('moderateComment') }}
                </button>
            </article>
            <button v-if="more" :disabled="busy" @click="showPublication(publication.id, true)">
                {{ t('loadMoreReviews') }}
            </button>
        </template>
        <template v-else-if="view === 'mine'">
            <h2>{{ t('myPublications') }}</h2>
            <p>{{ t('manageSharingHint') }}</p>
            <article v-for="item in mine" :key="item.id" class="community-card">
                <h3>{{ item.content.title }} · V.{{ item.revision }}</h3>
                <p>
                    {{
                        item.hidden
                            ? t('publicationHidden')
                            : item.published
                              ? t('published')
                              : t('publicationWithdrawn')
                    }}
                </p>
                <button
                    v-if="item.published && !item.hidden"
                    :disabled="busy"
                    @click="showPublication(item.id)"
                >
                    {{ t('openPublication') }}</button
                ><button v-if="item.published" :disabled="busy" @click="withdraw(item)">
                    {{ t('withdraw') }}
                </button>
            </article>
            <button v-if="more" :disabled="busy" @click="showMine(true)">
                {{ t('loadMore') }}
            </button>
        </template>
        <section v-if="reporting" class="notice" :aria-label="t('submitReport')">
            <form class="account-form" @submit.prevent="report">
                <h2>{{ t('submitReport') }}</h2>
                <label
                    >{{ t('reason')
                    }}<select :aria-label="t('reason')" v-model="reason">
                        <option value="spam">{{ t('reportSpam') }}</option>
                        <option value="abuse">{{ t('reportAbuse') }}</option>
                        <option v-if="reporting.type === 'publication'" value="copyright">
                            {{ t('reportCopyright') }}
                        </option>
                        <option value="other">{{ t('reportOther') }}</option>
                    </select></label
                ><label
                    >{{ t('reportDetails')
                    }}<textarea v-model="details" maxlength="2000" rows="3" />
                </label>
                <div class="actions">
                    <button :disabled="busy">{{ t('submitReport') }}</button
                    ><button type="button" :disabled="busy" @click="reporting = undefined">
                        {{ t('cancel') }}
                    </button>
                </div>
            </form>
        </section>
    </main>
</template>
