<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlphaTabApi, model, synth } from '@coderline/alphatab'
import { alphaScore, prepareScoreMidi } from '../domain/alphaScore'
import { arrangementErrors, scoreStructure, type Arrangement } from '../domain/score'
import { scoreText as s } from '../i18n/en'
const props = defineProps<{ arrangement: Arrangement }>()
const emit = defineEmits<{
    select: [track: number, staff: number, bar: number, voice: number, event: number]
}>()
const host = ref<HTMLElement>()
const ready = ref(false),
    playing = ref(false),
    error = ref(''),
    zoom = ref(100),
    currentBar = ref(1)
const rangeStart = ref(1),
    rangeEnd = ref(props.arrangement.bars.length),
    loop = ref(false)
const notation = ref('both')
const mixer = ref<
    Record<string, { visible: boolean; enabled: boolean; solo: boolean; volume: number }>
>({})
const errors = computed(() => arrangementErrors(props.arrangement))
let api: AlphaTabApi | undefined,
    rendered: model.Score | undefined,
    timer: ReturnType<typeof setTimeout> | undefined
function mixState(id: string) {
    return (mixer.value[id] ??= { visible: true, enabled: true, solo: false, volume: 100 })
}
function mix() {
    if (!api || !rendered || rendered.tracks.length !== props.arrangement.tracks.length) return
    for (const [i, t] of props.arrangement.tracks.entries()) {
        const state = mixState(t.id),
            track = rendered.tracks[i]!
        api.changeTrackMute([track], !state.enabled)
        api.changeTrackSolo([track], state.solo)
        api.changeTrackVolume([track], state.volume / 100)
    }
}
function display() {
    if (!api || !rendered || rendered.tracks.length !== props.arrangement.tracks.length) return
    const visible = rendered.tracks.filter(
        (_, i) => mixState(props.arrangement.tracks[i]!.id).visible,
    )
    // Keep at least one visible staff; display selection never changes mixer state.
    if (!visible.length) return
    for (const t of rendered.tracks)
        for (const staff of t.staves) {
            staff.showStandardNotation = notation.value !== 'tab' || !staff.isStringed
            staff.showTablature = staff.isStringed && notation.value !== 'standard'
        }
    api.settings.display.scale = zoom.value / 100
    api.updateSettings()
    api.renderTracks(visible)
}
function render() {
    if (!api) return
    if (!scoreStructure([props.arrangement]) || !props.arrangement.tracks.length) {
        rendered = undefined
        error.value = s.incomplete
        return
    }
    error.value = ''
    ready.value = false
    try {
        rendered = alphaScore(props.arrangement)
        api.renderScore(
            rendered,
            rendered.tracks.map((_, i) => i),
        )
        mix()
        display()
    } catch {
        error.value = s.renderError
    }
}
function range() {
    if (!api || !rendered || rendered.masterBars.length !== props.arrangement.bars.length) return
    rangeStart.value = Math.max(
        1,
        Math.min(props.arrangement.bars.length, Math.floor(rangeStart.value) || 1),
    )
    rangeEnd.value = Math.max(
        rangeStart.value,
        Math.min(props.arrangement.bars.length, Math.floor(rangeEnd.value) || 1),
    )
    const last = rendered.masterBars[rangeEnd.value - 1]!
    api.playbackRange = {
        startTick: rendered.masterBars[rangeStart.value - 1]!.start,
        endTick: last.start + last.calculateDuration(),
    }
    api.isLooping = loop.value
}
function seek() {
    if (!api || !rendered) return
    currentBar.value = Math.max(
        1,
        Math.min(rendered.masterBars.length, Math.floor(currentBar.value) || 1),
    )
    api.tickPosition = rendered.masterBars[currentBar.value - 1]!.start
}
function play() {
    if (!errors.value.length && ready.value) {
        range()
        api?.playPause()
    }
}
function pauseHidden() {
    if (document.hidden) api?.pause()
}
onMounted(() => {
    api = new AlphaTabApi(host.value!, {
        core: { fontDirectory: '/font/' },
        player: {
            enablePlayer: true,
            soundFont: '/soundfont/sonivox.sf2',
            enableCursor: true,
            enableAnimatedBeatCursor: true,
            enableUserInteraction: true,
            scrollElement: (host.value!.closest('.score-workspace') as HTMLElement) || 'html',
        },
    })
    api.midiLoad.on((file) => prepareScoreMidi(file, props.arrangement))
    api.playerReady.on(() => {
        ready.value = true
        mix()
        range()
    })
    api.playerStateChanged.on((e) => {
        playing.value = e.state === synth.PlayerState.Playing
    })
    api.playerPositionChanged.on((e) => {
        if (rendered)
            currentBar.value = Math.max(
                1,
                rendered.masterBars.findLastIndex((b) => b.start <= e.currentTick) + 1,
            )
    })
    api.beatMouseDown.on((beat) =>
        emit(
            'select',
            beat.voice.bar.staff.track.index,
            beat.voice.bar.staff.index,
            beat.voice.bar.index,
            beat.voice.index,
            beat.index,
        ),
    )
    api.error.on(() => {
        error.value = s.renderError
    })
    document.addEventListener('visibilitychange', pauseHidden)
    render()
})
watch(
    () => props.arrangement,
    () => {
        api?.stop()
        ready.value = false
        clearTimeout(timer)
        timer = setTimeout(render, 180)
    },
    { deep: true },
)
// Vue's select/checkbox model assignment and change handlers can run in
// different orders. Observe the committed control state before updating audio.
watch(mixer, mix, { deep: true })
watch(
    [zoom, notation, () => props.arrangement.tracks.map((t) => mixer.value[t.id]?.visible ?? true)],
    display,
)
watch([rangeStart, rangeEnd, loop], range)
onBeforeUnmount(() => {
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', pauseHidden)
    api?.destroy()
})
</script>
<template>
    <section class="score-view" :aria-label="s.reader">
        <div class="score-controls">
            <button :disabled="!ready || !!errors.length" @click="play">
                {{ playing ? s.pause : s.playResume }}
            </button>
            <button :disabled="!ready" @click="api?.stop()">{{ s.stop }}</button>
            <label
                >{{ s.goMeasure
                }}<input
                    v-model.number="currentBar"
                    type="number"
                    min="1"
                    :max="arrangement.bars.length"
                    @change="seek"
            /></label>
            <label
                >{{ s.from
                }}<input
                    v-model.number="rangeStart"
                    type="number"
                    min="1"
                    :max="arrangement.bars.length"
            /></label>
            <label
                >{{ s.to
                }}<input
                    v-model.number="rangeEnd"
                    type="number"
                    min="1"
                    :max="arrangement.bars.length"
            /></label>
            <label class="check-row"><input v-model="loop" type="checkbox" />{{ s.loop }}</label>
            <label
                >{{ s.zoom
                }}<select v-model.number="zoom">
                    <option v-for="z in [50, 75, 100, 125, 150, 200]" :key="z" :value="z">
                        {{ z }}%
                    </option>
                </select></label
            >
            <label
                >{{ s.notation
                }}<select v-model="notation">
                    <option value="both">{{ s.both }}</option>
                    <option value="standard">{{ s.standard }}</option>
                    <option value="tab">{{ s.tab }}</option>
                </select></label
            >
        </div>
        <details class="score-mixer">
            <summary>{{ s.tracksAndSound }}</summary>
            <p>{{ s.visibilityHint }}</p>
            <div v-for="track in arrangement.tracks" :key="track.id" class="score-mix-row">
                <strong>{{ track.name }}</strong>
                <label class="check-row"
                    ><input
                        v-model="mixState(track.id).visible"
                        type="checkbox"
                        :disabled="
                            mixState(track.id).visible &&
                            arrangement.tracks.filter((t) => mixState(t.id).visible).length === 1
                        "
                    />{{ s.visible }}</label
                >
                <label class="check-row"
                    ><input v-model="mixState(track.id).enabled" type="checkbox" />{{
                        s.sound
                    }}</label
                >
                <label class="check-row"
                    ><input v-model="mixState(track.id).solo" type="checkbox" />{{ s.solo }}</label
                >
                <label
                    >{{ s.volume
                    }}<input
                        v-model.number="mixState(track.id).volume"
                        type="range"
                        min="0"
                        max="100"
                /></label>
            </div>
        </details>
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <p v-else-if="!ready" role="status">{{ s.loading }}</p>
        <p v-if="errors.length" class="notice">{{ s.incomplete }}</p>
        <div v-show="arrangement.tracks.length" class="score-paper">
            <div ref="host" class="alpha-score" />
        </div>
    </section>
</template>
