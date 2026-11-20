import { describe, expect, it } from 'vitest'
import { TapTempo } from './tapTempo'

describe('tap tempo', () => {
    it('needs two taps and averages beat intervals before rounding the BPM', () => {
        const tempo = new TapTempo()
        expect(tempo.bpm).toBeNull()
        expect(tempo.tap(0)).toBeNull()
        expect(tempo.tap(480)).toBe(125)
        expect(tempo.tap(1000)).toBe(120)
        expect(tempo.tap(1510)).toBe(119)
    })

    it('follows a new rhythm using only the eight most recent intervals', () => {
        const tempo = new TapTempo()
        for (let now = 0; now <= 4000; now += 500) tempo.tap(now)
        expect(tempo.bpm).toBe(120)
        for (let now = 4250; now <= 6000; now += 250) tempo.tap(now)
        expect(tempo.bpm).toBe(240)
    })

    it('starts a fresh measurement after a five-second gap or an explicit reset', () => {
        const tempo = new TapTempo()
        tempo.tap(0)
        tempo.tap(500)
        expect(tempo.tap(5500)).toBeNull()
        expect(tempo.tap(6500)).toBe(60)
        tempo.reset()
        expect(tempo.bpm).toBeNull()
        expect(tempo.tap(7000)).toBeNull()
        expect(tempo.tap(7500)).toBe(120)
    })

    it('ignores duplicate, invalid or too-fast taps without shifting the beat', () => {
        const tempo = new TapTempo()
        tempo.tap(0)
        for (const invalid of [0, 10, 59, -100, NaN, Infinity]) {
            expect(tempo.tap(invalid)).toBeNull()
        }
        expect(tempo.tap(60)).toBe(1000)
        expect(tempo.tap(60)).toBe(1000)
        expect(tempo.tap(120)).toBe(1000)
    })
})
