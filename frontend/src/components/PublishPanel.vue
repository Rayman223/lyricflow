<script setup lang="ts">
import MusicLinks from './MusicLinks.vue'
import { onMounted, ref, toRaw } from 'vue'
import type { Song } from '../domain/song'
import { accountGet, accountRequest, type Account } from '../accounts/client'
import { sharedContent, type OwnedPublication, type CatalogSong } from '../community/model'
import { parseLyrics } from '../domain/parser'
import { t } from '../i18n/en'
import ShareLink from './ShareLink.vue'

const props = defineProps<{ song: Song; account: Account }>()
const ownerId = props.account.id
const emit = defineEmits<{ close: []; published: [publication: OwnedPublication] }>()
const content = ref(sharedContent(structuredClone(toRaw(props.song))))
const existing = ref<OwnedPublication>(),
    matches = ref<CatalogSong[]>([])
const accepted = ref(false),
    busy = ref(true),
    error = ref(''),
    message = ref('')
async function findMatches() {
    const data = await accountGet<{ songs: CatalogSong[] }>(
        `/api/community/catalog?q=${encodeURIComponent(content.value.title)}`,
    )
    matches.value = data.songs
}
function chooseMatch(match: CatalogSong) {
    content.value.title = match.title
    content.value.artist = match.artist
}
onMounted(async () => {
    try {
        const data = await accountGet<{ publications: OwnedPublication[] }>(
            `/api/community/mine?songId=${props.song.id}`,
        )
        existing.value = data.publications[0]
        await findMatches()
    } catch (e) {
        error.value = e instanceof Error ? e.message : t('accountNetworkError')
    } finally {
        busy.value = false
    }
})
async function submit() {
    if (busy.value || !accepted.value) return
    const parsed = parseLyrics(content.value.lyrics)
    if (parsed.errors.length || !parsed.items.some((item) => item.kind === 'lyric')) {
        error.value = t('invalidCodes')
        return
    }
    busy.value = true
    error.value = ''
    try {
        const source = props.song.source
        const data = await accountRequest<{ publication: OwnedPublication }>(
            '/api/community/publish',
            {
                accountId: ownerId,
                localSongId: props.song.id,
                expectedRevision: existing.value?.revision ?? 0,
                content: toRaw(content.value),
                sharingAccepted: true,
                ...(source
                    ? { source: { publicationId: source.publicationId, revision: source.revision } }
                    : {}),
            },
        )
        existing.value = data.publication
        message.value = t(data.publication.hidden ? 'publicationHidden' : 'publicationSaved', {
            revision: data.publication.revision,
        })
        emit('published', data.publication)
    } catch (e) {
        error.value = e instanceof Error ? e.message : t('accountNetworkError')
    } finally {
        busy.value = false
    }
}
async function withdraw() {
    if (!existing.value || busy.value || !confirm(t('withdrawConfirm'))) return
    busy.value = true
    try {
        const data = await accountRequest<{ publication: OwnedPublication }>(
            `/api/community/publications/${existing.value.id}/unpublish`,
            {
                accountId: ownerId,
                expectedRevision: existing.value.revision,
            },
        )
        existing.value = data.publication
        message.value = t('publicationWithdrawn')
        emit('published', data.publication)
    } catch (e) {
        error.value = e instanceof Error ? e.message : t('accountNetworkError')
    } finally {
        busy.value = false
    }
}
</script>

<template>
    <main class="screen">
        <div class="screen-heading">
            <h1>{{ t('shareSong') }}</h1>
            <button :disabled="busy" @click="emit('close')">{{ t('back') }}</button>
        </div>
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <p v-if="message" role="status" class="notice">{{ message }}</p>
        <ShareLink
            v-if="existing?.published && !existing.hidden"
            :song="song"
            :publication-id="existing.id"
        />
        <p class="notice">{{ t('sharingInfo') }}</p>
        <p>{{ t('savedVersionOnly') }}</p>
        <p>{{ t('autoShareConsentHint') }}</p>
        <form class="account-form" @submit.prevent="submit">
            <label
                >{{ t('sharedTitle')
                }}<input v-model="content.title" required maxlength="200" :disabled="busy"
            /></label>
            <label
                >{{ t('sharedArtist')
                }}<input v-model="content.artist" maxlength="200" :disabled="busy"
            /></label>
            <button
                type="button"
                :disabled="busy"
                @click="findMatches().catch(() => (error = t('accountNetworkError')))"
            >
                {{ t('findMatchingSongs') }}
            </button>
            <ul v-if="matches.length" class="plain-list">
                <li v-for="match in matches" :key="match.id">
                    <button type="button" class="quiet" @click="chooseMatch(match)">
                        {{ match.title }} · {{ match.artist || t('unknownArtist') }} —
                        {{ t('useSong') }}
                    </button>
                </li>
            </ul>
            <h2>{{ t('publicPreview') }}</h2>
            <p>
                {{ t('contributor') }}: {{ account.pseudonym
                }}<span v-if="existing"> · V.{{ existing.revision }}</span>
            </p>
            <MusicLinks :links="content.musicLinks" />
            <pre class="lyrics-preview">{{ content.lyrics }}</pre>
            <p>
                {{ content.music.bpm }} BPM · {{ content.music.beatsPerBar }} {{ t('beats') }} ·
                {{ content.music.barsPerLine }} {{ t('bars') }}
            </p>
            <p v-if="song.source">
                {{ t('adaptedFrom') }} {{ song.source.publicationId }} · V.{{
                    song.source.revision
                }}
            </p>
            <label class="check-row"
                ><input v-model="accepted" type="checkbox" required :disabled="busy" />{{
                    t('sharingConsent')
                }}</label
            >
            <button class="primary" :disabled="busy || !accepted">
                {{ existing ? t('publishUpdate') : t('publish') }}
            </button>
        </form>
        <button v-if="existing?.published" :disabled="busy" class="quiet" @click="withdraw">
            {{ t('withdraw') }}
        </button>
    </main>
</template>
