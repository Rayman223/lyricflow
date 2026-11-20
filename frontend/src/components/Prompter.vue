<script setup lang="ts">
import MusicLinks from './MusicLinks.vue'
import LineCountdown from './LineCountdown.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Song, ReaderSettings } from '../domain/song'
import { parseLyrics } from '../domain/parser'
import { Transport } from '../domain/transport'
import { t } from '../i18n/en'

const props = defineProps<{ song: Song; theme: string }>()
const emit = defineEmits<{ close: []; settings: [settings: ReaderSettings]; theme: [] }>()
const parsed = parseLyrics(props.song.lyrics)
const engine = new Transport(parsed.items, { ...props.song.settings })
const countdown = ref(engine.lineCountdown)
const countdownShift = ref(0)
const state = ref(engine.state),
    index = ref(engine.index),
    progress = ref(0),
    beat = ref(0),
    pauseBeats = ref(0),
    bpm = ref(engine.bpm),
    seconds = ref(0)
const metronomeBeat = ref(engine.metronomeBeat),
    metronomeLit = ref(engine.metronomeLit)
const songBpm = ref(engine.settings.bpm),
    pixels = ref(engine.settings.pixelsPerSecond),
    fontSize = ref(engine.settings.fontSize)
const viewport = ref<HTMLElement>(),
    content = ref<HTMLElement>()
const positions = ref<number[]>([]),
    offset = ref(0)
const anchor = ref(70)
const viewportHeight = ref(400)
const message = ref(''),
    audioMessage = ref('')
const wakeState = ref<'idle' | 'pending' | 'held' | 'unavailable' | 'released'>('idle')
let frame = 0,
    observer: ResizeObserver | undefined
let wake: WakeLockSentinel | undefined
let wakeRequest = 0
let audio: AudioContext | undefined
let oscillator: OscillatorNode | undefined
let lastBeat = -1
let disposed = false
let measured = false
let scrollTarget = 0,
    scrollFrom = 0,
    scrollStarted = 0,
    appliedScroll = 0
let rowPositions: number[] = []
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const running = computed(() => state.value === 'playing' || state.value === 'counting')
const wakeProblem = computed(() =>
    wakeState.value === 'released'
        ? 'wakeReleased'
        : wakeState.value === 'unavailable'
          ? 'wakeUnavailable'
          : undefined,
)
const continuous =
    engine.settings.speedMode === 'pixels' || engine.settings.presentation === 'continuous'

function sync() {
    state.value = engine.state
    index.value = engine.index
    progress.value = engine.progress
    beat.value = engine.beat
    countdown.value = engine.lineCountdown
    bpm.value = engine.bpm
    metronomeBeat.value = engine.metronomeBeat
    metronomeLit.value = engine.metronomeLit
    const item = engine.item
    const displayRemaining = engine.state === 'paused' ? engine.total : engine.remaining
    seconds.value =
        item?.kind === 'pause'
            ? Math.max(
                  1,
                  Math.ceil(
                      displayRemaining / (item.pause!.unit === 'seconds' ? 1 : engine.bpm / 60) -
                          1e-9,
                  ),
              )
            : 0
    pauseBeats.value =
        item?.kind === 'pause' && item.pause!.unit !== 'seconds'
            ? Math.max(1, Math.ceil(displayRemaining - 1e-9))
            : 0
    let position = positions.value[engine.index] ?? positions.value.at(-1) ?? 0
    if (continuous && item?.kind === 'lyric') {
        let next = engine.index + 1
        while (parsed.items[next]?.kind === 'section') next++
        position += ((positions.value[next] ?? position) - position) * engine.progress
    }
    offset.value = position
    // Keep the preceding logical line visible when the viewport has enough room.
    let previous = engine.index - 1
    while (previous >= 0 && parsed.items[previous]?.kind !== 'lyric') previous--
    const distance =
        previous >= 0
            ? (positions.value[engine.index] ?? 0) - (positions.value[previous] ?? 0) + 16
            : 70
    const height = viewport.value?.clientHeight ?? 400
    viewportHeight.value = height
    anchor.value = continuous
        ? Math.min(70, height * 0.25)
        : Math.min(Math.max(70, distance), height * 0.55)
    positionCountdown()
    if (engine.state === 'counting') {
        if (lastBeat !== engine.beat) {
            if (click()) lastBeat = engine.beat
        }
    } else lastBeat = -1
}

function measure() {
    if (!content.value) return
    // Follow the current lyric through the animated layout change after Pause.
    // A reader who has scrolled away from it keeps control of the paused view.
    const followsPlayback =
        !running.value && viewport.value && Math.abs(viewport.value.scrollTop - appliedScroll) < 1
    const children = Array.from(content.value.querySelectorAll<HTMLElement>('[data-row]'))
    positions.value = children.map((child) => child.offsetTop)
    const last = children.at(-1)
    positions.value.push(last ? last.offsetTop + last.offsetHeight + 24 : 0)
    rowPositions = [...positions.value]
    if (continuous) {
        // A timed pause holds the next lyric's position; leaving it must not jump
        // over the pause marker or any zero-duration section headings.
        let nextLyric = positions.value.at(-1) ?? 0
        for (let i = parsed.items.length - 1; i >= 0; i--) {
            if (parsed.items[i]!.kind === 'lyric') nextLyric = positions.value[i]!
            else if (parsed.items[i]!.kind === 'pause') positions.value[i] = nextLyric
        }
    }
    engine.setPositions(positions.value)
    sync()
    if (!measured || followsPlayback) recenter()
    measured = true
}

// The native scroll position is only a view: browsing never seeks the transport.
function renderPosition(now: number, immediate = false) {
    const element = viewport.value
    if (!element || (!running.value && !immediate)) return
    const target = Math.max(0, 70 + offset.value - anchor.value)
    if (immediate || continuous || state.value !== 'playing' || reducedMotion.matches) {
        scrollTarget = target
        scrollFrom = target
    } else if (target !== scrollTarget) {
        scrollFrom = element.scrollTop
        scrollTarget = target
        scrollStarted = now
    }
    const fraction = Math.min(1, Math.max(0, (now - scrollStarted) / 180))
    const position = scrollFrom + (scrollTarget - scrollFrom) * (1 - (1 - fraction) ** 3)
    element.scrollTop = position
    appliedScroll = element.scrollTop
    positionCountdown()
}

function positionCountdown() {
    const element = viewport.value
    const followsPlayback =
        element && (running.value || Math.abs(element.scrollTop - appliedScroll) < 1)
    // Keep the counter below the viewport's fade while its row scrolls past.
    // Use the real row position: continuous waits share the next lyric's target.
    countdownShift.value =
        continuous && followsPlayback
            ? Math.max(0, element.scrollTop - 70 - (rowPositions[engine.index] ?? 0) + 4)
            : 0
}

function recenter() {
    void nextTick(() => {
        if (disposed) return
        renderPosition(performance.now(), true)
    })
}

function guardScroll() {
    // Focus changes and a gesture begun before Resume must not displace playback.
    if (running.value && viewport.value) viewport.value.scrollTop = appliedScroll
    positionCountdown()
}

// A bold active row can wrap differently while the total track height stays equal.
watch(index, measure, { flush: 'post' })

function loop(now: number) {
    const wasRunning = running.value
    engine.tick(now)
    sync()
    renderPosition(now, wasRunning && !running.value)
    frame = requestAnimationFrame(loop)
}

async function requestWake() {
    if (disposed || document.visibilityState !== 'visible') return
    if (!navigator.wakeLock || !window.isSecureContext) {
        wakeState.value = 'unavailable'
        return
    }
    if (wake || wakeState.value === 'pending') return
    const request = ++wakeRequest
    wakeState.value = 'pending'
    try {
        const lock = await navigator.wakeLock.request('screen')
        if (disposed || document.visibilityState !== 'visible' || request !== wakeRequest) {
            await lock.release()
            return
        }
        wake = lock
        wakeState.value = 'held'
        lock.addEventListener(
            'release',
            () => {
                if (wake !== lock) return
                wake = undefined
                wakeState.value = document.visibilityState === 'visible' ? 'released' : 'idle'
            },
            { once: true },
        )
    } catch {
        if (request === wakeRequest) wakeState.value = 'unavailable'
    }
}
function releaseWake() {
    wakeRequest++
    const previous = wake
    wake = undefined
    wakeState.value = 'idle'
    if (previous) void previous.release().catch(() => {})
}

async function prepareAudio() {
    if (!engine.settings.sound) return
    try {
        audio ??= new AudioContext()
        await audio.resume()
    } catch {
        audioMessage.value = t('audioError')
    }
}
function click() {
    if (!engine.settings.sound) return true
    if (!audio || audio.state !== 'running') return false
    const gain = audio.createGain()
    oscillator = audio.createOscillator()
    oscillator.frequency.value = engine.beat === 1 ? 1000 : 750
    gain.gain.setValueAtTime(0.12, audio.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.045)
    oscillator.connect(gain)
    gain.connect(audio.destination)
    oscillator.start()
    oscillator.stop(audio.currentTime + 0.05)
    oscillator.onended = () => {
        gain.disconnect()
    }
    return true
}

function toggle() {
    void requestWake()
    if (running.value) {
        engine.pause(performance.now())
        oscillator?.stop()
        sync()
        recenter()
        return
    }
    if (disposed || document.visibilityState !== 'visible') return
    // Audio resume may remain pending indefinitely on an unavailable device.
    void prepareAudio()
    message.value = ''
    lastBeat = -1
    engine.start(performance.now())
    sync()
    recenter()
    void requestWake()
}
function seek(i: number) {
    const previous = running.value
    engine.seek(i, performance.now())
    if (!previous) {
        engine.state = 'paused'
    }
    sync()
    recenter()
}
function restart() {
    engine.pause(performance.now())
    engine.seek(0, performance.now())
    engine.state = 'ready'
    sync()
    recenter()
}
function background() {
    if (running.value) {
        engine.pause(performance.now())
        message.value = t('backgroundPause')
        oscillator?.stop()
        sync()
        recenter()
    }
    releaseWake()
}
function visibilityChanged() {
    if (document.visibilityState === 'hidden') background()
    else void requestWake()
}
function changeBpm() {
    if (!Number.isFinite(songBpm.value) || songBpm.value < 1 || songBpm.value > 1000) {
        songBpm.value = engine.settings.bpm
        return
    }
    engine.setBpm(songBpm.value, performance.now())
    sync()
    emit('settings', { bpm: engine.settings.bpm })
}
function changePixels() {
    if (!Number.isFinite(pixels.value) || pixels.value < 1 || pixels.value > 1000) {
        pixels.value = engine.settings.pixelsPerSecond
        return
    }
    engine.setPixelsPerSecond(pixels.value, performance.now())
    sync()
    emit('settings', { pixelsPerSecond: engine.settings.pixelsPerSecond })
}
async function changeFont() {
    if (!Number.isFinite(fontSize.value) || fontSize.value < 18 || fontSize.value > 80) {
        fontSize.value = engine.settings.fontSize
        return
    }
    engine.settings.fontSize = fontSize.value
    await nextTick()
    measure()
    emit('settings', { fontSize: engine.settings.fontSize })
}
function close() {
    engine.pause(performance.now())
    releaseWake()
    emit('close')
}

onMounted(async () => {
    await nextTick()
    measure()
    observer = new ResizeObserver(measure)
    if (content.value) observer.observe(content.value)
    if (viewport.value) observer.observe(viewport.value)
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('pagehide', background)
    window.addEventListener('pageshow', requestWake)
    void requestWake()
    frame = requestAnimationFrame(loop)
})
onBeforeUnmount(() => {
    disposed = true
    cancelAnimationFrame(frame)
    observer?.disconnect()
    releaseWake()
    document.removeEventListener('visibilitychange', visibilityChanged)
    window.removeEventListener('pagehide', background)
    window.removeEventListener('pageshow', requestWake)
    void audio?.close().catch(() => {})
})
</script>

<template>
    <section
        class="reader"
        :class="{ 'is-running': running }"
        :style="{ '--lyric-size': `${fontSize}px`, '--reader-anchor': `${anchor}px` }"
    >
        <header class="reader-header">
            <button class="quiet" @click="close">← {{ t('library') }}</button>
            <div class="reader-share" :inert="running" :aria-hidden="running">
                <slot name="share" :running="running" />
            </div>
            <button
                v-if="running && wakeProblem"
                class="quiet reader-wake-retry"
                :title="t(wakeProblem)"
                @click="requestWake"
            >
                <span aria-hidden="true">⚠</span> {{ t('retryWake') }}
            </button>
            <div class="reader-title">
                <div class="reader-title-content">
                    <strong>{{ song.title || t('untitled') }}</strong
                    ><span>{{ song.artist }}</span>
                </div>
            </div>
            <button
                class="theme-toggle"
                :aria-label="theme === 'dark' ? t('lightTheme') : t('darkTheme')"
                @click="emit('theme')"
            >
                {{ theme === 'dark' ? '☀' : '☾' }}
            </button>
        </header>
        <div class="reader-music" :inert="running" :aria-hidden="running">
            <MusicLinks :links="song.musicLinks" compact />
        </div>
        <div class="reader-info">
            <span class="status-dot" :class="{ live: running }" /><span>{{
                state === 'playing'
                    ? seconds > 0
                        ? t('remaining', { seconds })
                        : t('playing')
                    : state === 'counting'
                      ? t('counting')
                      : state === 'paused'
                        ? t('paused')
                        : state === 'ended'
                          ? t('finish')
                          : t('ready')
            }}</span
            ><span class="passage-bpm"
                >{{ t('effectiveBpm') }} <strong>{{ Number(bpm.toFixed(2)) }}</strong></span
            >
        </div>
        <div
            class="metronome"
            role="img"
            :aria-label="t('metronome', { beats: engine.settings.beatsPerBar })"
        >
            <span
                v-for="n in engine.settings.beatsPerBar"
                :key="n"
                class="metronome-light"
                :class="{ lit: metronomeLit && metronomeBeat === n }"
                aria-hidden="true"
            />
        </div>
        <p v-if="message || audioMessage" class="reader-message" role="status">
            {{ message || audioMessage }}
        </p>
        <div class="lyrics-window" :style="{ '--reader-height': `${viewportHeight}px` }">
            <div
                ref="viewport"
                class="lyrics-viewport"
                :class="{ scrollable: !running }"
                data-testid="lyrics-viewport"
                role="region"
                :aria-label="t('lyrics')"
                tabindex="0"
                @scroll="guardScroll"
            >
                <div class="lyrics-scroll-content">
                    <div ref="content" class="lyrics-track">
                        <template v-for="(item, i) in parsed.items" :key="i">
                            <p v-if="item.kind === 'section'" data-row class="section-row">
                                {{ item.text }}
                            </p>
                            <div v-else data-row class="timed-row">
                                <LineCountdown
                                    v-if="index === i && countdown"
                                    :value="countdown"
                                    :style="{ transform: `translateY(${countdownShift}px)` }"
                                />
                                <div
                                    v-if="item.kind === 'pause'"
                                    class="pause-row"
                                    :class="{ active: index === i }"
                                >
                                    <span>{{ t('wait') }}</span
                                    ><span v-if="index === i">
                                        ·
                                        {{
                                            item.pause!.unit === 'seconds'
                                                ? t('remaining', { seconds })
                                                : pauseBeats === 1
                                                  ? t('oneBeatRemaining')
                                                  : t('beatsRemaining', { beats: pauseBeats })
                                        }}</span
                                    >
                                </div>
                                <button
                                    v-else
                                    class="lyric-row"
                                    :class="{ active: index === i, past: i < index }"
                                    :aria-current="index === i ? 'step' : undefined"
                                    @click="seek(i)"
                                >
                                    {{ item.text }}
                                </button>
                            </div>
                        </template>
                    </div>
                </div>
            </div>
            <div v-if="state === 'counting'" class="count-overlay" role="status">
                <span>{{ t('counting') }}</span
                ><strong>{{ beat }}</strong>
            </div>
        </div>
        <footer class="reader-controls">
            <div
                class="progress-track"
                role="progressbar"
                :aria-label="song.title || t('untitled')"
                :aria-valuenow="Math.round(progress * 100)"
                aria-valuemin="0"
                aria-valuemax="100"
            >
                <span :style="{ width: `${progress * 100}%` }" />
            </div>
            <div class="transport">
                <button @click="restart" :aria-label="t('restart')">↺</button
                ><button class="primary play" @click="toggle">
                    {{
                        running ? t('pause') : state === 'paused' ? t('resume') : t('start')
                    }}</button
                ><label
                    >{{ t('bpm')
                    }}<input
                        v-model.number="songBpm"
                        :aria-label="t('bpm')"
                        type="number"
                        min="1"
                        max="1000"
                        @change="changeBpm" /></label
                ><label v-if="engine.settings.speedMode === 'pixels'"
                    >{{ t('pixels')
                    }}<input
                        v-model.number="pixels"
                        type="number"
                        min="1"
                        max="1000"
                        @change="changePixels" /></label
                ><label
                    >{{ t('fontSize')
                    }}<input
                        v-model.number="fontSize"
                        type="number"
                        min="18"
                        max="80"
                        @change="changeFont"
                /></label>
            </div>
            <p class="reader-hint">{{ t('tapHint') }}</p>
            <p v-if="!running && wakeState !== 'idle'" class="wake-status" role="status">
                {{ t(wakeProblem ?? (wakeState === 'held' ? 'wakeHeld' : 'wakePending')) }}
                <button v-if="wakeProblem" class="quiet" @click="requestWake">
                    {{ t('retryWake') }}
                </button>
            </p>
        </footer>
    </section>
</template>
