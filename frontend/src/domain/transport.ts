import { effectiveBpm, type Item } from './parser'
import type { SongSettings } from './song'

export type PlaybackState = 'ready' | 'counting' | 'playing' | 'paused' | 'ended'
export type LineCountdown =
    { unit: 'beats'; beats: number; bars: number } | { unit: 'seconds'; seconds: number }

/** Deterministic transport: caller supplies a monotonic clock and layout distances. */
export class Transport {
    state: PlaybackState = 'ready'
    index = 0
    remaining = 0
    total = 0
    countRemaining = 0
    private pausedFrom: 'counting' | 'playing' = 'playing'
    private lastTime = 0
    private positions: number[] = []
    private metronomePosition = 0

    constructor(
        public readonly items: Item[],
        public settings: SongSettings,
    ) {
        this.select(0)
        if (!this.item) this.state = 'ended'
    }

    setPositions(positions: number[]) {
        const progress = this.progress
        this.positions = positions
        if (this.settings.speedMode === 'pixels' && this.item?.kind === 'lyric') {
            this.total = this.units(this.item, this.index)
            this.remaining = this.total * (1 - progress)
        }
    }

    get item() {
        return this.items[this.index]
    }
    get progress() {
        return this.total > 0 ? 1 - this.remaining / this.total : 0
    }
    get bpm() {
        return effectiveBpm(this.item?.tempo ?? null, this.settings.bpm)
    }
    get beat() {
        return Math.max(1, Math.ceil(this.countRemaining))
    }
    get lineCountdown(): LineCountdown | null {
        if (!this.item || this.state === 'ended') return null
        // Pause changes the display only; Resume keeps the actual remaining duration.
        const remaining = this.state === 'paused' ? this.total : this.remaining
        if (this.settings.speedMode === 'pixels' || this.item.pause?.unit === 'seconds') {
            return {
                unit: 'seconds',
                seconds: Math.max(1, Math.ceil(remaining / this.rate() - 1e-9)),
            }
        }
        const beats = Math.max(1, Math.ceil(remaining - 1e-9))
        return {
            unit: 'beats',
            beats: ((beats - 1) % this.settings.beatsPerBar) + 1,
            bars: Math.ceil(beats / this.settings.beatsPerBar),
        }
    }
    get metronomeBeat() {
        return (Math.floor(this.metronomePosition + 1e-9) % this.settings.beatsPerBar) + 1
    }
    get metronomeLit() {
        // Glow for 120 ms at most, leaving at least half a beat unlit.
        const fraction = this.metronomePosition - Math.floor(this.metronomePosition + 1e-9)
        return (
            (this.state === 'playing' || this.state === 'counting') &&
            fraction < Math.min(0.5, this.bpm / 500)
        )
    }

    private advanceMetronome(seconds: number) {
        // Integrate each passage's tempo, independently of its scrolling/pause units.
        this.metronomePosition =
            (this.metronomePosition + (seconds * this.bpm) / 60) % this.settings.beatsPerBar
    }

    private units(item: Item, index: number) {
        if (item.kind === 'pause')
            return item.pause!.value * (item.pause!.unit === 'bars' ? this.settings.beatsPerBar : 1)
        if (this.settings.speedMode === 'pixels') {
            // Include headings between two timed rows in the visual distance.
            let next = index + 1
            while (this.items[next]?.kind === 'section') next++
            return Math.max(
                1,
                (this.positions[next] ?? (this.positions[index] ?? 0) + 80) -
                    (this.positions[index] ?? 0),
            )
        }
        return item.beats ?? (item.bars ?? this.settings.barsPerLine) * this.settings.beatsPerBar
    }

    private rate() {
        if (this.item?.kind === 'pause' && this.item.pause!.unit === 'seconds') return 1
        if (this.item?.kind === 'lyric' && this.settings.speedMode === 'pixels')
            return this.settings.pixelsPerSecond
        return this.bpm / 60
    }

    private select(index: number) {
        while (this.items[index]?.kind === 'section') index++
        this.index = index
        this.total = this.item ? this.units(this.item, index) : 0
        this.remaining = this.total
    }

    seek(index: number, now: number) {
        const wasRunning = this.state === 'playing' || this.state === 'counting'
        this.select(Math.max(0, index))
        this.countRemaining = 0
        this.metronomePosition = 0
        this.state = !this.item ? 'ended' : wasRunning ? 'playing' : 'ready'
        this.pausedFrom = 'playing'
        this.lastTime = now
    }

    start(now: number) {
        if (!this.items.some((item) => item.kind !== 'section')) return
        if (this.state === 'ended') {
            this.select(0)
            this.state = 'ready'
        }
        if (this.state === 'paused') this.state = this.pausedFrom
        else if (this.state === 'ready') {
            this.metronomePosition = 0
            this.countRemaining = this.settings.countIn
            this.state = this.countRemaining > 0 ? 'counting' : 'playing'
        }
        this.lastTime = now
    }

    pause(now: number) {
        this.tick(now)
        if (this.state === 'counting' || this.state === 'playing') {
            this.pausedFrom = this.state
            this.state = 'paused'
        }
    }

    setBpm(bpm: number, now: number) {
        this.tick(now) // Consume elapsed beats using the previous tempo.
        this.settings = { ...this.settings, bpm }
    }

    setPixelsPerSecond(speed: number, now: number) {
        this.tick(now)
        this.settings = { ...this.settings, pixelsPerSecond: speed }
    }

    tick(now: number) {
        let seconds = Math.max(0, now - this.lastTime) / 1000
        this.lastTime = now
        if (this.state === 'counting') {
            const needed = this.countRemaining / (this.bpm / 60)
            if (seconds + 1e-9 < needed) {
                this.advanceMetronome(seconds)
                this.countRemaining -= (seconds * this.bpm) / 60
                return
            }
            seconds = Math.max(0, seconds - needed)
            this.countRemaining = 0
            this.metronomePosition = 0
            this.state = 'playing'
        }
        while (this.state === 'playing' && this.item) {
            const rate = this.rate()
            const needed = this.remaining / rate
            if (seconds + 1e-9 < needed) {
                this.advanceMetronome(seconds)
                this.remaining -= seconds * rate
                break
            }
            this.advanceMetronome(needed)
            seconds = Math.max(0, seconds - needed)
            this.select(this.index + 1)
            if (!this.item) this.state = 'ended'
        }
    }
}
