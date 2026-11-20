<script setup lang="ts">
import { ref, watch } from 'vue'
import { newSong, type Song, type ReaderSettings } from '../domain/song'
import { loadPublicPrompter } from '../community/links'
import { t } from '../i18n/en'
import ScoresPanel from './ScoresPanel.vue'
import Prompter from './Prompter.vue'
import ShareLink from './ShareLink.vue'

const props = defineProps<{ id: string; theme: string }>()
const emit = defineEmits<{ close: []; theme: [] }>()
const showScores = ref(false)
const song = ref<Song>(),
    error = ref(''),
    loading = ref(false),
    attempt = ref(0)
watch(
    () => [props.id, attempt.value],
    async (_value, _old, onCleanup) => {
        let current = true
        onCleanup(() => {
            current = false
        })
        song.value = undefined
        error.value = ''
        loading.value = true
        try {
            const publication = await loadPublicPrompter(props.id)
            if (!current) return
            const temporary = newSong()
            song.value = {
                ...temporary,
                title: publication.content.title,
                artist: publication.content.artist,
                lyrics: publication.content.lyrics,
                musicLinks: publication.content.musicLinks,
                arrangements: publication.content.arrangements,
                settings: { ...temporary.settings, ...publication.content.music },
            }
        } catch (e) {
            if (current) error.value = e instanceof Error ? e.message : t('accountNetworkError')
        } finally {
            if (current) loading.value = false
        }
    },
    { immediate: true },
)
function settings(value: ReaderSettings) {
    if (song.value) song.value.settings = { ...song.value.settings, ...value }
}
</script>

<template>
    <main v-if="song && (showScores || !song.lyrics.trim())" class="screen">
        <h1>{{ song.title }}</h1>
        <button @click="emit('close')">{{ t('back') }}</button
        ><button v-if="song.lyrics.trim()" @click="showScores = false">{{ t('read') }}</button
        ><ScoresPanel :arrangements="song.arrangements" /><ShareLink
            :song="song"
            :publication-id="id"
        />
    </main>
    <Prompter
        v-else-if="song"
        :key="song.id"
        :song="song"
        :theme="theme"
        @close="emit('close')"
        @theme="emit('theme')"
        @settings="settings"
    >
        <template #share="{ running }">
            <ShareLink :song="song" :publication-id="id" :running="running" />
            <button v-if="song.arrangements?.length" @click="showScores = true">
                {{ t('scores') }}
            </button>
        </template>
    </Prompter>
    <main v-else class="screen">
        <p v-if="loading" role="status">{{ t('loading') }}</p>
        <p v-if="error" role="alert">{{ error }}</p>
        <button v-if="error" @click="attempt++">{{ t('retry') }}</button>
        <button @click="emit('close')">{{ t('back') }}</button>
    </main>
</template>
