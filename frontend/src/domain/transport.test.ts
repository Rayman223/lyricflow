import { describe, expect, it } from 'vitest'
import { parseLyrics } from './parser'
import { defaults, type SongSettings } from './song'
import { Transport } from './transport'

function player(source: string, settings: Partial<SongSettings> = {}) {
    return new Transport(parseLyrics(source).items, { ...defaults, countIn: 0, ...settings })
}

describe('prompter transport', () => {
    it.each([3, 4])('times six beats independently of %s beats per bar', (beatsPerBar) => {
        const p = player('[line beats=6] First\nNext', { beatsPerBar })
        p.start(0)
        p.tick(2999)
        expect(p.index).toBe(0)
        p.tick(3000)
        expect(p.index).toBe(1)
    })
    it('times fractional beats in a block and local overrides with pauses', () => {
        const p = player(
            '[line tempo=50% beats=1.5]\n[section=Verse]\nFirst\n\n[line bars=.5] Second\n[pause beats=.5]\nThird\n[/line]\nLast',
        )
        p.start(0)
        p.tick(1500)
        expect(p.item!.text).toBe('Second')
        p.tick(3500)
        expect(p.item!.kind).toBe('pause')
        p.tick(4000)
        expect(p.item!.text).toBe('Third')
        p.tick(5500)
        expect(p.item!.text).toBe('Last')
        expect(p.bpm).toBe(120)
    })
    it.each([
        ['80', 80],
        ['50%', 100],
    ] as const)('preserves beats through BPM changes, pause and seek at %s', (tempo, bpm) => {
        const p = player(`[line tempo=${tempo} beats=6]\nFirst\nSecond\n[/line]`)
        p.start(0)
        p.setBpm(200, 1000)
        expect(p.bpm).toBe(bpm)
        const remaining = p.remaining
        p.pause(1000)
        p.tick(100000)
        expect(p.remaining).toBe(remaining)
        p.start(100000)
        p.tick(100000 + (remaining * 60000) / bpm)
        expect(p.item!.text).toBe('Second')
        p.seek(0, 200000)
        expect(p.remaining).toBe(6)
        expect(p.bpm).toBe(bpm)
        p.tick(200000 + 360000 / bpm)
        expect(p.item!.text).toBe('Second')
    })
    it('ignores beat durations in pixels mode while pauses inherit the block tempo', () => {
        const p = player('[line tempo=60 beats=100]\nFirst\n[pause beats=2]\nSecond\n[/line]', {
            speedMode: 'pixels',
            pixelsPerSecond: 40,
        })
        p.setPositions([0, 80, 160, 240])
        p.start(0)
        p.tick(2000)
        expect(p.item!.kind).toBe('pause')
        p.tick(4000)
        expect(p.item!.text).toBe('Second')
        p.tick(5000)
        expect(p.progress).toBe(0.5)
    })
    it.each([0, 4])('can start again after the end with a %s beat count-in', (countIn) => {
        const p = player('First', { countIn })
        p.start(0)
        p.tick(10000)
        expect(p.state).toBe('ended')
        p.start(11000)
        expect(p.state).toBe(countIn ? 'counting' : 'playing')
        expect(p.item!.text).toBe('First')
        expect(p.remaining).toBe(4)
        expect(p.countRemaining).toBe(countIn)
    })
    it('advances logical lines at 120 BPM, not section headings or blank lines', () => {
        const p = player('[section=Verse]\nFirst\n\n[line bars=2] Second\nThird')
        p.start(0)
        p.tick(1999)
        expect(p.item!.text).toBe('First')
        p.tick(2000)
        expect(p.item!.text).toBe('Second')
        p.tick(5999)
        expect(p.item!.text).toBe('Second')
        p.tick(6000)
        expect(p.item!.text).toBe('Third')
        p.tick(8000)
        expect(p.state).toBe('ended')
    })
    it('honours a three beat bar and fractional measures', () => {
        const p = player('[line bars=1.5] Waltz\nNext', { beatsPerBar: 3 })
        p.start(0)
        p.tick(2249)
        expect(p.index).toBe(0)
        p.tick(2250)
        expect(p.index).toBe(1)
    })
    it('preserves elapsed beats on dynamic BPM changes', () => {
        const p = player('First\nNext')
        p.start(0)
        p.setBpm(60, 1000)
        expect(p.remaining).toBe(2)
        p.tick(2999)
        expect(p.index).toBe(0)
        p.tick(3000)
        expect(p.index).toBe(1)
    })
    it('keeps absolute passages fixed and relative passages dynamic', () => {
        const p = player('[tempo=80]\nFixed\n[/tempo]\n[tempo=80%]\nRelative\n[/tempo]')
        p.start(0)
        p.setBpm(200, 1500)
        expect(p.bpm).toBe(80)
        p.tick(3000)
        expect(p.item!.text).toBe('Relative')
        expect(p.bpm).toBe(160)
        p.tick(4500)
        expect(p.state).toBe('ended')
    })
    it('resumes musical and seconds pauses automatically with distinct tempo behaviour', () => {
        const p = player('[pause beats=4]\n[pause seconds=3]\nNext')
        p.start(0)
        p.setBpm(60, 1000)
        p.tick(3000)
        expect(p.item!.pause!.unit).toBe('seconds')
        p.setBpm(500, 4000)
        p.tick(5999)
        expect(p.index).toBe(1)
        p.tick(6000)
        expect(p.item!.text).toBe('Next')
    })
    it('pauses and resumes without catching up time spent in background', () => {
        const p = player('First\nNext')
        p.start(0)
        p.pause(500)
        p.tick(100000)
        expect(p.state).toBe('paused')
        expect(p.remaining).toBe(3)
        p.start(200000)
        p.tick(201499)
        expect(p.index).toBe(0)
        p.tick(201500)
        expect(p.index).toBe(1)
    })
    it('seeks with the parsed block context and restarts the whole logical line', () => {
        const p = player('[tempo=80]\nFirst\nSecond\n[/tempo]\nLast')
        p.start(0)
        p.tick(1000)
        p.seek(1, 1000)
        expect(p.bpm).toBe(80)
        expect(p.remaining).toBe(4)
        p.tick(3999)
        expect(p.index).toBe(1)
        p.tick(4000)
        expect(p.bpm).toBe(120)
    })
    it('runs a count-in, can pause it and starts lyrics only after its remaining beats', () => {
        const p = player('First', { countIn: 4 })
        p.start(0)
        p.tick(500)
        expect(p.beat).toBe(3)
        p.pause(750)
        expect(p.countRemaining).toBe(2.5)
        p.start(10000)
        p.tick(11249)
        expect(p.state).toBe('counting')
        p.tick(11250)
        expect(p.state).toBe('playing')
        expect(p.progress).toBe(0)
    })
    it.each([
        ['80', 3000],
        ['50%', 4000],
    ])('uses the opening tempo %s for the count-in', (tempo, milliseconds) => {
        const p = player(`[line tempo=${tempo}] First`, { countIn: 4 })
        p.start(0)
        p.tick(Number(milliseconds) - 1)
        expect(p.state).toBe('counting')
        p.tick(Number(milliseconds))
        expect(p.state).toBe('playing')
        expect(p.progress).toBe(0)
    })
    it('advances pixels at the measured CSS distance, independent of BPM and line bars', () => {
        const p = player('[line bars=100 tempo=10] Wrapped lyric\nNext', {
            speedMode: 'pixels',
            pixelsPerSecond: 40,
        })
        p.setPositions([0, 120, 200])
        p.start(0)
        p.setBpm(500, 1000)
        expect(p.progress).toBeCloseTo(1 / 3)
        p.tick(2999)
        expect(p.index).toBe(0)
        p.tick(3000)
        expect(p.index).toBe(1)
    })
    it('holds pixel scrolling for all pause units, then resumes the same visual speed', () => {
        const p = player('First\n[pause bars=1]\n[pause beats=2]\n[pause seconds=3]\nLast', {
            speedMode: 'pixels',
            pixelsPerSecond: 40,
        })
        p.setPositions([0, 80, 160, 240, 320, 400])
        p.start(0)
        p.tick(2000)
        expect(p.index).toBe(1)
        p.tick(4000)
        expect(p.index).toBe(2)
        p.tick(5000)
        expect(p.index).toBe(3)
        p.tick(8000)
        expect(p.index).toBe(4)
        p.tick(9000)
        expect(p.progress).toBe(0.5)
    })
    it('accounts for headings in pixel distances and preserves progress on layout changes', () => {
        const p = player('First\n[section=Chorus]\nSecond', {
            speedMode: 'pixels',
            pixelsPerSecond: 40,
        })
        p.setPositions([0, 80, 120, 200])
        p.start(0)
        p.tick(1500)
        expect(p.progress).toBe(0.5)
        p.setPositions([0, 100, 160, 240])
        expect(p.progress).toBe(0.5)
        p.tick(3500)
        expect(p.item!.text).toBe('Second')
    })
    it('does not accumulate drift across 300 lines in ten minutes', () => {
        const p = player(Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join('\n'))
        p.start(0)
        for (let now = 13; now < 600000; now += 13) p.tick(now)
        p.tick(600000)
        expect(p.state).toBe('ended')
    })
})
