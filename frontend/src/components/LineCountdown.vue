<script setup lang="ts">
import { computed } from 'vue'
import type { LineCountdown } from '../domain/transport'
import { t } from '../i18n/en'

const props = defineProps<{ value: LineCountdown }>()
const label = computed(() =>
    props.value.unit === 'seconds'
        ? t('remaining', { seconds: props.value.seconds })
        : t('lineCountdown', { beats: props.value.beats, bars: props.value.bars }),
)
</script>

<template>
    <span class="line-countdown" role="img" :aria-label="label" :title="label">
        <span v-if="value.unit === 'seconds'" class="line-countdown-seconds" aria-hidden="true">
            {{ value.seconds }}s
        </span>
        <span v-else class="line-countdown-fraction" aria-hidden="true">
            <span class="line-countdown-beats">{{ value.beats }}</span>
            <span class="line-countdown-bars">{{ value.bars }}</span>
        </span>
    </span>
</template>
