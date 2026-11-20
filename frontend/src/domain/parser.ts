export type Tempo = { kind: 'absolute' | 'relative'; value: number } | null
export interface Item {
    kind: 'lyric' | 'section' | 'pause'
    text: string
    sourceLine: number
    tempo: Tempo
    beats?: number
    bars?: number
    pause?: { unit: 'bars' | 'beats' | 'seconds'; value: number }
}
export interface Diagnostic {
    line: number
    code: string
}
export interface ParsedSong {
    items: Item[]
    errors: Diagnostic[]
}

const decimal = /^(?:\d+(?:\.\d+)?|\.\d+)$/
const literal = (text: string) => text.replace(/\\([\\\[\]])/g, '$1')

function positive(raw: string, max: number): number | undefined {
    if (!decimal.test(raw)) return
    const value = Number(raw)
    if (value >= 0.01 && value <= max) return value
}

function tempo(raw: string): Tempo | undefined {
    const relative = raw.endsWith('%')
    const value = positive(relative ? raw.slice(0, -1) : raw, 1000)
    if (value !== undefined) return { kind: relative ? 'relative' : 'absolute', value }
}

export function effectiveBpm(t: Tempo, bpm: number): number {
    return t === null ? bpm : t.kind === 'absolute' ? t.value : (bpm * t.value) / 100
}

/** A newline defines one musical line. Layout never enters the grammar. */
export function parseLyrics(source: string): ParsedSong {
    const items: Item[] = []
    const errors: Diagnostic[] = []
    let block: { tempo: Tempo; bars?: number; beats?: number; close: string } | null = null
    let blockLine = 0
    const error = (line: number, code: string) => errors.push({ line, code })
    source
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .forEach((original, index) => {
            const line = index + 1
            const text = original.trim()
            if (!text) return
            const base = { sourceLine: line, tempo: block?.tempo ?? null }
            if (text.startsWith('\\[') || !text.startsWith('[')) {
                items.push({
                    ...base,
                    bars: block?.bars,
                    beats: block?.beats,
                    kind: 'lyric',
                    text: literal(text),
                })
                return
            }
            const section = /^\[section=([^\]\r\n]+)\]$/.exec(text)
            if (section) {
                items.push({ ...base, kind: 'section', text: literal(section[1]!) })
                return
            }
            const opening = /^\[tempo=([^\]]+)\]$/.exec(text)
            if (opening) {
                const value = tempo(opening[1]!)
                if (block !== null) error(line, 'nestedBlock')
                else if (value === undefined) error(line, 'invalidTempo')
                else {
                    block = { tempo: value, close: '[/tempo]' }
                    blockLine = line
                }
                return
            }
            if (text === '[/tempo]' || text === '[/line]') {
                if (block === null || block.close !== text) error(line, 'unexpectedClose')
                else block = null
                return
            }
            const pause = /^\[pause (bars|beats|seconds)=([^\]]+)\]$/.exec(text)
            if (pause) {
                const value = positive(pause[2]!, pause[1] === 'seconds' ? 86400 : 1000)
                if (value === undefined) error(line, 'invalidDuration')
                else
                    items.push({
                        ...base,
                        kind: 'pause',
                        text: '',
                        pause: { unit: pause[1] as 'bars' | 'beats' | 'seconds', value },
                    })
                return
            }
            const tagged = /^\[line ([^\]]+)\]\s*(.*)$/.exec(text)
            if (tagged) {
                const params = tagged[1]!.split(/\s+/)
                let bars: number | undefined
                let beats: number | undefined
                let lineTempo = block?.tempo ?? null
                const seen = new Set<string>()
                let valid = true
                for (const param of params) {
                    const [key, value, extra] = param.split('=')
                    if (!key || !value || extra !== undefined || seen.has(key)) {
                        valid = false
                        break
                    }
                    seen.add(key)
                    if (key === 'bars') {
                        bars = positive(value, 1000)
                        if (bars === undefined) valid = false
                    } else if (key === 'beats') {
                        beats = positive(value, 1000)
                        if (beats === undefined) valid = false
                    } else if (key === 'tempo') {
                        const t = tempo(value)
                        if (t === undefined) valid = false
                        else lineTempo = t
                    } else valid = false
                }
                if (!valid || (bars !== undefined && beats !== undefined))
                    error(line, 'invalidLine')
                else if (!tagged[2]!.trim()) {
                    if (block !== null) error(line, 'nestedBlock')
                    else {
                        block = { tempo: lineTempo, bars, beats, close: '[/line]' }
                        blockLine = line
                    }
                } else
                    items.push({
                        ...base,
                        kind: 'lyric',
                        text: literal(tagged[2]!),
                        bars: beats !== undefined ? undefined : (bars ?? block?.bars),
                        beats: bars !== undefined ? undefined : (beats ?? block?.beats),
                        tempo: lineTempo,
                    })
                return
            }
            error(line, 'unknownCode')
        })
    if (block !== null) error(blockLine, 'unclosedBlock')
    return { items, errors }
}
