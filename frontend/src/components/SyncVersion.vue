<script setup lang="ts">
import type { SyncValue } from '../storage/sync-types'
import { t } from '../i18n/en'
import { musicServices } from '../domain/musicLinks'
defineProps<{ value: SyncValue }>()
</script>

<template>
    <template v-if="value && 'song' in value && (value.song || value.draft)">
        <template v-for="kind in ['song', 'draft'] as const" :key="kind">
            <article v-if="value[kind]">
                <p class="muted">{{ kind === 'song' ? t('saved') : t('drafts') }}</p>
                <p>
                    <strong>{{ value[kind].title || t('untitled') }}</strong> ·
                    {{ value[kind].artist || t('unknownArtist') }}
                </p>
                <pre>{{ value[kind].lyrics }}</pre>
                <dl class="conflict-settings">
                    <template v-for="service in musicServices" :key="service.key">
                        <template v-if="value[kind].musicLinks?.[service.key]">
                            <dt>{{ service.name }} {{ t('optionalLink') }}</dt>
                            <dd>{{ value[kind].musicLinks![service.key] }}</dd>
                        </template>
                    </template>
                    <dt>{{ t('bpm') }}</dt>
                    <dd>{{ value[kind].settings.bpm }}</dd>
                    <dt>{{ t('beats') }}</dt>
                    <dd>{{ value[kind].settings.beatsPerBar }}</dd>
                    <dt>{{ t('bars') }}</dt>
                    <dd>{{ value[kind].settings.barsPerLine }}</dd>
                    <dt>{{ t('mode') }}</dt>
                    <dd>
                        {{
                            value[kind].settings.speedMode === 'bpm'
                                ? t('bpmMode')
                                : t('pixelsMode')
                        }}
                    </dd>
                    <dt>{{ t('presentation') }}</dt>
                    <dd>
                        {{
                            value[kind].settings.presentation === 'line'
                                ? t('lineMode')
                                : t('continuousMode')
                        }}
                    </dd>
                    <dt>{{ t('pixels') }}</dt>
                    <dd>{{ value[kind].settings.pixelsPerSecond }}</dd>
                    <dt>{{ t('countIn') }}</dt>
                    <dd>{{ value[kind].settings.countIn }}</dd>
                    <dt>{{ t('sound') }}</dt>
                    <dd>{{ value[kind].settings.sound ? t('enabled') : t('disabled') }}</dd>
                    <dt>{{ t('fontSize') }}</dt>
                    <dd>{{ value[kind].settings.fontSize }}</dd>
                </dl>
            </article>
        </template>
    </template>
    <p v-else>{{ t('deletedVersion') }}</p>
</template>
