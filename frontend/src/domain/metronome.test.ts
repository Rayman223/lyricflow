import { describe, expect, it } from 'vitest'
import { parseLyrics } from './parser'
import { defaults, type SongSettings } from './song'
import { Transport } from './transport'

function player(lyrics = '[line bars=20] Long line', settings: Partial<SongSettings> = {}) {
    return new Transport(parseLyrics(lyrics).items, { ...defaults, countIn: 0, ...settings })
}

describe('visual metronome', () => {
    it.each([1, 4, 6, 32])(
        'cycles through %i beats per bar with short light pulses',
        (beatsPerBar) => {
            const p = player(undefined, { beatsPerBar })
            expect(p.metronomeLit).toBe(false)
            p.start(0)
            for (let i = 0; i <= beatsPerBar * 2; i++) {
                p.tick(i * 500)
                expect(p.metronomeBeat).toBe((i % beatsPerBar) + 1)
                expect(p.metronomeLit).toBe(true)
                p.tick(i * 500 + 200)
                expect(p.metronomeLit).toBe(false)
            }
        },
    )

    it('keeps the beat phase through fractional lines, headings and tempo changes', () => {
        const p = player('[line bars=0.375] Short\n[section=Verse]\n[line tempo=60 bars=4] Slow')
        p.start(0)
        p.tick(750) // 1.5 beats, then a different tempo mid-beat.
        expect(p.item!.text).toBe('Slow')
        expect(p.metronomeBeat).toBe(2)
        expect(p.metronomeLit).toBe(false)
        p.tick(1250)
        expect(p.metronomeBeat).toBe(3)
        expect(p.metronomeLit).toBe(true)
    })

    it('consumes delayed frames across fixed and relative passages without drift', () => {
        const p = player('[line tempo=60 bars=0.5] Fixed\n[line tempo=50% bars=20] Relative')
        p.start(0)
        p.setBpm(240, 1000) // Fixed passage still at 60 BPM.
        p.tick(3750) // 2 fixed beats + 3.5 relative beats.
        expect(p.metronomeBeat).toBe(2)
        expect(p.metronomeLit).toBe(false)
        p.setBpm(120, 3750)
        p.tick(4250)
        expect(p.metronomeBeat).toBe(3)
        expect(p.metronomeLit).toBe(true)
    })

    it('freezes on manual pause, resumes its phase and resets on seek and restart', () => {
        const p = player('First\nSecond')
        p.start(0)
        p.pause(550)
        expect(p.metronomeBeat).toBe(2)
        expect(p.metronomeLit).toBe(false)
        p.tick(100000)
        p.start(100000)
        expect(p.metronomeLit).toBe(true)
        p.tick(100450)
        expect(p.metronomeBeat).toBe(3)
        p.seek(1, 100450)
        expect(p.metronomeBeat).toBe(1)
        expect(p.metronomeLit).toBe(true)
        p.tick(102450)
        expect(p.state).toBe('ended')
        expect(p.metronomeLit).toBe(false)
        p.start(102450)
        expect(p.metronomeBeat).toBe(1)
        expect(p.metronomeLit).toBe(true)
    })

    it('follows count-in tempo and begins the lyrics on the first light', () => {
        const p = player('[line tempo=60] First', { countIn: 3 })
        p.start(0)
        p.tick(1000)
        expect(p.metronomeBeat).toBe(2)
        p.pause(1500)
        expect(p.metronomeLit).toBe(false)
        p.start(10000)
        p.tick(11500)
        expect(p.state).toBe('playing')
        expect(p.metronomeBeat).toBe(1)
        expect(p.metronomeLit).toBe(true)
    })

    it.each(['bpm', 'pixels'] as const)(
        'follows BPM during %s lyrics and all timed waits',
        (speedMode) => {
            const p = player(
                'First\n[pause beats=1.5]\n[pause bars=0.5]\n[pause seconds=1.25]\nLast',
                {
                    speedMode,
                    pixelsPerSecond: 40,
                },
            )
            p.setPositions([0, 80, 120, 160, 200, 280])
            p.start(0)
            p.tick(2000)
            expect(p.index).toBe(1)
            expect(p.metronomeBeat).toBe(1)
            p.tick(2750)
            expect(p.index).toBe(2)
            expect(p.metronomeBeat).toBe(2)
            p.tick(3750)
            expect(p.index).toBe(3)
            expect(p.metronomeBeat).toBe(4)
            p.setBpm(60, 4000)
            p.tick(5000)
            expect(p.index).toBe(4)
            expect(p.metronomeBeat).toBe(2)
            expect(p.metronomeLit).toBe(true)
        },
    )

    it('does not accumulate drift over ten minutes', () => {
        const p = player('[line bars=1000] Long song', { bpm: 137, beatsPerBar: 6 })
        p.start(0)
        for (let now = 13; now < 600000; now += 13) p.tick(now)
        p.tick(600000) // 1370 beats = beat 3 of the measure.
        expect(p.metronomeBeat).toBe(3)
        expect(p.metronomeLit).toBe(true)
    })
})
