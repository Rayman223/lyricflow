<script setup lang="ts">
import type { SongSettings } from '../domain/song'
import { t } from '../i18n/en'
defineProps<{ settings: SongSettings }>()
</script>

<template>
    <div class="field-grid">
        <label
            >{{ t('bpm')
            }}<input v-model.number="settings.bpm" type="number" min="1" max="1000" step="1"
        /></label>
        <label
            >{{ t('beats')
            }}<input v-model.number="settings.beatsPerBar" type="number" min="1" max="32"
        /></label>
        <label
            >{{ t('bars')
            }}<input
                v-model.number="settings.barsPerLine"
                type="number"
                min="0.01"
                max="1000"
                step="0.5"
        /></label>
        <label
            >{{ t('mode')
            }}<select v-model="settings.speedMode">
                <option value="bpm">{{ t('bpmMode') }}</option>
                <option value="pixels">{{ t('pixelsMode') }}</option>
            </select></label
        >
        <label v-if="settings.speedMode === 'bpm'"
            >{{ t('presentation')
            }}<select v-model="settings.presentation">
                <option value="line">{{ t('lineMode') }}</option>
                <option value="continuous">{{ t('continuousMode') }}</option>
            </select></label
        >
        <label v-else
            >{{ t('pixels')
            }}<input v-model.number="settings.pixelsPerSecond" type="number" min="1" max="1000"
        /></label>
        <label
            >{{ t('countIn')
            }}<input v-model.number="settings.countIn" type="number" min="0" max="32"
        /></label>
        <label
            >{{ t('fontSize')
            }}<input v-model.number="settings.fontSize" type="number" min="18" max="80"
        /></label>
        <label class="check"
            ><input v-model="settings.sound" type="checkbox" />{{ t('sound') }}</label
        >
    </div>
</template>
