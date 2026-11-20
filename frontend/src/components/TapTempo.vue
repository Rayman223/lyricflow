<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { TapTempo } from '../domain/tapTempo'
import { t } from '../i18n/en'

const emit = defineEmits<{ apply: [bpm: number] }>()
const tempo = new TapTempo()
const measured = ref<number | null>(null)

function tap() {
    measured.value = tempo.tap(performance.now())
}
function reset() {
    tempo.reset()
    measured.value = null
}
function visibilityChanged() {
    if (document.hidden) reset()
}
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', visibilityChanged))
</script>

<template>
    <div class="tap-tempo">
        <p class="tap-tempo-hint">{{ t('tapTempoHint') }}</p>
        <div class="tap-tempo-controls">
            <button
                type="button"
                class="tap-tempo-pad"
                @click="tap"
                @keydown="$event.repeat && $event.preventDefault()"
            >
                <svg
                    width="28"
                    height="28"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                >
                    <path d="M9 3h6l4 18H5L9 3Z M8 17h8 M12 17l5-12" />
                    <path d="m15 7 3 1" />
                </svg>
                {{ t('tapTempo') }}
            </button>
            <output aria-live="polite" aria-atomic="true">{{
                measured === null ? t('tapTempoWaiting') : t('tapTempoResult', { bpm: measured })
            }}</output>
            <button type="button" :disabled="measured === null" @click="emit('apply', measured!)">
                {{ t('useTapTempo') }}
            </button>
        </div>
    </div>
</template>

<style scoped>
.tap-tempo {
    margin-top: 1rem;
}
.tap-tempo-hint {
    color: var(--muted);
    font-size: 0.85rem;
    margin-bottom: 0.5rem;
}
.tap-tempo-controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
}
.tap-tempo-pad {
    min-height: 64px;
    touch-action: manipulation;
    user-select: none;
}
.tap-tempo-pad:active {
    background: var(--accent);
    color: var(--accent-text);
}
output {
    min-width: 5.5rem;
    font-size: 1.15rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}
</style>
