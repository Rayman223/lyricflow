import { describe, expect, it } from 'vitest'
import { effectiveBpm, parseLyrics } from './parser'

describe('musical grammar', () => {
    it('keeps logical lines and ignores blank lines without assigning section durations', () => {
        const result = parseLyrics(
            '[section=Verse]\r\nA long lyric line that wraps on a phone\r\n\r\nAnother line',
        )
        expect(result.errors).toEqual([])
        expect(result.items.map((i) => [i.kind, i.sourceLine])).toEqual([
            ['section', 1],
            ['lyric', 2],
            ['lyric', 4],
        ])
    })
    it('applies line > block > song and restores the default after a block', () => {
        const result = parseLyrics(
            '[tempo=80%]\nFirst\n[line tempo=90 bars=1.5] Second\nThird\n[/tempo]\nFourth',
        )
        expect(result.errors).toEqual([])
        expect(result.items.map((i) => effectiveBpm(i.tempo, 120))).toEqual([96, 90, 96, 120])
        expect(result.items[1]!.bars).toBe(1.5)
        expect(result.items.map((i) => effectiveBpm(i.tempo, 150))).toEqual([120, 90, 120, 150])
    })
    it('supports standalone line parameters and three pause units in the surrounding tempo', () => {
        const result = parseLyrics(
            '[line bars=.5] Half\n[line tempo=80] Fixed\n[tempo=50%]\n[pause beats=8]\n[pause bars=4]\n[pause seconds=5]\n[/tempo]',
        )
        expect(result.errors).toEqual([])
        expect(result.items[0]!.bars).toBe(0.5)
        expect(result.items.slice(2).map((i) => i.pause)).toEqual([
            { unit: 'beats', value: 8 },
            { unit: 'bars', value: 4 },
            { unit: 'seconds', value: 5 },
        ])
        expect(effectiveBpm(result.items[2]!.tempo, 120)).toBe(60)
    })
    it('inherits each setting and replaces the entire block duration across units', () => {
        const result = parseLyrics(
            '[line tempo=80% beats=6]\nFirst\n[line tempo=90] Second\n[line bars=2] Third\n[section=Solo]\n\n[pause bars=1]\nFourth\n[/line]\nLast\n[line bars=2]\n[line beats=.5] Half\nAgain\n[/line]',
        )
        expect(result.errors).toEqual([])
        expect(
            result.items.map((i) => [i.kind, i.bars, i.beats, effectiveBpm(i.tempo, 120)]),
        ).toEqual([
            ['lyric', undefined, 6, 96],
            ['lyric', undefined, 6, 90],
            ['lyric', 2, undefined, 96],
            ['section', undefined, undefined, 96],
            ['pause', undefined, undefined, 96],
            ['lyric', undefined, 6, 96],
            ['lyric', undefined, undefined, 120],
            ['lyric', undefined, 0.5, 120],
            ['lyric', 2, undefined, 120],
        ])
        expect(result.items[4]!.pause).toEqual({ unit: 'bars', value: 1 })
    })
    it.each(['0.01', '.5', '1.5', '1000'])('accepts beats=%s inline and in a block', (value) => {
        const result = parseLyrics(
            `[line beats=${value}] Inline\n[line beats=${value}]\nBlock\n[/line]`,
        )
        expect(result.errors).toEqual([])
        expect(result.items.map((i) => i.beats)).toEqual([Number(value), Number(value)])
    })
    it.each([
        ['[line beats=4]\n[tempo=90]\nText\n[/tempo]\n[/line]', 'nestedBlock'],
        ['[tempo=90]\n[line beats=4]\nText\n[/line]\n[/tempo]', 'nestedBlock'],
        ['[line beats=4]\n[line bars=2]\nText\n[/line]', 'nestedBlock'],
        ['[line beats=4]\nText\n[/tempo]', 'unexpectedClose'],
        ['[tempo=90]\nText\n[/line]', 'unexpectedClose'],
        ['[/line]', 'unexpectedClose'],
        ['[line beats=4]\nText', 'unclosedBlock'],
        ...['0', '0.001', '1000.01', '-1', 'NaN', 'Infinity', '1,5', '1e2', '2%'].map((v) => [
            `[line beats=${v}] Text`,
            'invalidLine',
        ]),
        ['[line bars=2 beats=4] Text', 'invalidLine'],
        ['[line beats=4 bars=2]\nText\n[/line]', 'invalidLine'],
        ['[line beats=4 beats=6] Text', 'invalidLine'],
        ['[tempo=90]\n[tempo=80]\nText\n[/tempo]', 'nestedBlock'],
        ['[/tempo]', 'unexpectedClose'],
        ['[tempo=90]\nText', 'unclosedBlock'],
        ['[tempo=0]', 'invalidTempo'],
        ['[tempo=NaN]', 'invalidTempo'],
        ['[line tempo=80 tempo=90] Text', 'invalidLine'],
        ['[line bars=1,5] Text', 'invalidLine'],
        ['[line bars=-1] Text', 'invalidLine'],
        ['[line bars=1]', 'unclosedBlock'],
        ['[line foo=4] Text', 'invalidLine'],
        ['[pause seconds=0]', 'invalidDuration'],
        ['[pause seconds=86401]', 'invalidDuration'],
        ['[unknown=2]', 'unknownCode'],
        ['[pause seconds=2] lyrics', 'unknownCode'],
    ])('rejects %s with a diagnostic', (source, code) => {
        expect(parseLyrics(source).errors.some((e) => e.code === code)).toBe(true)
    })
    it('escapes literal codes and never interprets HTML', () => {
        const result = parseLyrics(
            '\\[line tempo=80] literal\n\\[line beats=6]\n\\[/line]\n<img src=x onerror=alert(1)>',
        )
        expect(result.errors).toEqual([])
        expect(result.items.map((i) => i.text)).toEqual([
            '[line tempo=80] literal',
            '[line beats=6]',
            '[/line]',
            '<img src=x onerror=alert(1)>',
        ])
    })
})
