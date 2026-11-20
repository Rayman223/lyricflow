<script setup lang="ts">
import { computed } from 'vue'
import { musicServices, validMusicLink, type MusicLinks } from '../domain/musicLinks'
import { t } from '../i18n/en'

const props = defineProps<{ links?: MusicLinks; compact?: boolean }>()
const visible = computed(() =>
    musicServices.flatMap((service) => {
        const url = props.links?.[service.key]
        return typeof url === 'string' && validMusicLink(service.key, url)
            ? [{ ...service, url }]
            : []
    }),
)
</script>

<template>
    <nav
        v-if="visible.length"
        class="music-links"
        :class="{ compact }"
        :aria-label="t('musicLinks')"
    >
        <a
            v-for="service in visible"
            :key="service.key"
            :href="service.url"
            target="_blank"
            rel="noopener noreferrer"
            referrerpolicy="no-referrer"
            :aria-label="t('openMusicLink', { service: service.name })"
            :title="t('openMusicLink', { service: service.name })"
        >
            {{ service.name }}
        </a>
    </nav>
</template>

<style scoped>
.music-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
}
.music-links a {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 44px;
    padding: 0.35rem 0.6rem;
    border: 1px solid currentColor;
    border-radius: 0.5rem;
    color: inherit;
    text-decoration: none;
}
.music-links.compact a {
    padding-inline: 0.45rem;
    font-size: 0.875rem;
}
.music-links a:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 2px;
}
</style>
