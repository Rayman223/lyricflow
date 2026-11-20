// Average up to eight recent beat intervals using a monotonic clock in milliseconds.
export class TapTempo {
    private taps: number[] = []

    get bpm(): number | null {
        if (this.taps.length < 2) return null
        const elapsed = this.taps[this.taps.length - 1]! - this.taps[0]!
        return Math.round((60000 * (this.taps.length - 1)) / elapsed)
    }

    tap(now: number): number | null {
        if (!Number.isFinite(now)) return this.bpm
        const previous = this.taps[this.taps.length - 1]
        if (previous !== undefined) {
            const interval = now - previous
            // Ignore duplicate activations and intervals above the song's 1000 BPM limit.
            if (interval < 60) return this.bpm
            if (interval >= 5000) this.reset()
        }
        this.taps.push(now)
        this.taps = this.taps.slice(-9)
        return this.bpm
    }

    reset() {
        this.taps = []
    }
}
