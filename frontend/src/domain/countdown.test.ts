import { describe, expect, it } from 'vitest'
import { parseLyrics } from './parser'
import { defaults, type SongSettings } from './song'
import { Transport } from './transport'

function player(source: string, settings: Partial<SongSettings> = {}) {
    return new Transport(parseLyrics(source).items, {
        ...defaults,
        bpm: 60,
        countIn: 0,
        ...settings,
    })
}

describe('active line countdown', () => {
    it.each([1, 3, 4, 6, 32])(
        'counts down two bars of %i beats, then selects the next line',
        (beatsPerBar) => {
            const p = player('[line bars=2] First\nLast', { beatsPerBar })
            p.start(0)
            for (let elapsed = 0; elapsed < 2 * beatsPerBar; elapsed++) {
                p.tick(elapsed * 1000)
                expect(p.lineCountdown).toEqual({
                    unit: 'beats',
                    beats: beatsPerBar - (elapsed % beatsPerBar),
                    bars: elapsed < beatsPerBar ? 2 : 1,
                })
                p.tick(elapsed * 1000 + 999)
                expect(p.lineCountdown).toEqual({
                    unit: 'beats',
                    beats: beatsPerBar - (elapsed % beatsPerBar),
                    bars: elapsed < beatsPerBar ? 2 : 1,
                })
            }
            p.tick(2 * beatsPerBar * 1000)
            expect(p.item?.text).toBe('Last')
            expect(p.lineCountdown).toEqual({ unit: 'beats', beats: beatsPerBar, bars: 1 })
            p.tick(3 * beatsPerBar * 1000)
            expect(p.lineCountdown).toBeNull()
        },
    )

    it('shows full duration on manual pause without discarding the suspended position', () => {
        const p = player('[line bars=2] First')
        p.start(0)
        p.pause(5100)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 4, bars: 2 })
        p.tick(50000)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 4, bars: 2 })
        p.start(50000)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 3, bars: 1 })
        p.tick(52900)
        expect(p.state).toBe('ended')
    })

    it('does not consume the first line during count-in, and resets when seeking or restarting', () => {
        const p = player('[line bars=2] First\n[line beats=2] Last', { countIn: 4 })
        p.start(0)
        p.tick(3000)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 4, bars: 2 })
        p.tick(9000)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 3, bars: 1 })
        p.seek(1, 9000)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 2, bars: 1 })
        p.tick(11000)
        expect(p.lineCountdown).toBeNull()
        p.start(12000)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 4, bars: 2 })
    })

    it('counts musical waits like lyrics and keeps seconds waits in seconds', () => {
        const p = player('[pause bars=2]\n[pause beats=6]\n[pause seconds=2.5]\nLast')
        p.start(0)
        p.tick(4000)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 4, bars: 1 })
        p.tick(8000)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 2, bars: 2 })
        p.tick(14000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 3 })
        p.setBpm(500, 15000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 2 })
        p.pause(15500)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 3 })
        p.start(50000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 1 })
        p.tick(51000)
        expect(p.item?.text).toBe('Last')
    })

    it.each([
        ['[line bars=0.01]', 1, 1],
        ['[line beats=0.01]', 1, 1],
        ['[line bars=1.5]', 2, 2],
        ['[line beats=5.5]', 2, 2],
    ] as const)(
        'rounds fractional duration %s up without displaying zero early',
        (timing, beats, bars) => {
            const p = player(`${timing} First`)
            expect(p.lineCountdown).toEqual({ unit: 'beats', beats, bars })
            p.start(0)
            p.tick(p.total * 1000 - 0.001)
            expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 1, bars: 1 })
        },
    )

    it('preserves beat counts on tempo changes, including relative and fixed passages', () => {
        const p = player('[line tempo=50% bars=2] First\n[line tempo=120] Last', { bpm: 120 })
        p.start(0)
        p.setBpm(240, 1000)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 3, bars: 2 })
        p.tick(2500)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 4, bars: 1 })
        p.tick(4500)
        expect(p.item?.text).toBe('Last')
        p.setBpm(60, 5000)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 3, bars: 1 })
        p.tick(5500)
        expect(p.lineCountdown).toEqual({ unit: 'beats', beats: 2, bars: 1 })
    })

    it('uses measured pixel distances and visual speed for whole seconds, independently of BPM', () => {
        const p = player('[line beats=100 tempo=10] First\nLast', {
            speedMode: 'pixels',
            pixelsPerSecond: 40,
        })
        p.setPositions([0, 120, 200])
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 3 })
        p.start(0)
        p.tick(1000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 2 })
        p.setBpm(1000, 1000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 2 })
        p.setPixelsPerSecond(20, 1000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 4 })
        p.pause(2000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 6 })
        p.start(10000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 3 })
        p.setPositions([0, 240, 400])
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 6 })
        p.tick(16000)
        expect(p.item?.text).toBe('Last')
    })

    it('converts musical waits to seconds in pixel mode at the effective tempo', () => {
        const p = player('[pause bars=2]\n[pause beats=6]\n[pause seconds=5]', {
            speedMode: 'pixels',
        })
        p.start(0)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 8 })
        p.setBpm(120, 2000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 3 })
        p.tick(5000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 3 })
        p.pause(6000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 3 })
        p.start(10000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 2 })
        p.tick(12000)
        expect(p.lineCountdown).toEqual({ unit: 'seconds', seconds: 5 })
    })

    it('does not display a countdown without timed content', () => {
        expect(player('').lineCountdown).toBeNull()
        expect(player('[section=Verse]').lineCountdown).toBeNull()
    })
})
