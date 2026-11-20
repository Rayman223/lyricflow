<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import {
    addBar,
    arrangementErrors,
    barTicks,
    cloneMusic,
    copyBars,
    durations,
    eventTicks,
    instruments,
    newTrack,
    scoreStructure,
    tunings,
    uid,
    type Arrangement,
    type Duration,
    type Instrument,
    type ScoreEvent,
    type ScoreNote,
} from '../domain/score'
import { scoreText as s } from '../i18n/en'
const ScoreView = defineAsyncComponent(() => import('./ScoreView.vue'))
const props = defineProps<{
    arrangement: Arrangement
    readonly?: boolean
    status?: string
    siblings?: Arrangement[]
}>()
const emit = defineEmits<{ change: [value: Arrangement]; close: [] }>()
const a = ref<Arrangement>(structuredClone(toRaw(props.arrangement)))
const ti = ref(0),
    si = ref(0),
    bi = ref(0),
    vi = ref(0),
    ei = ref(0)
const track = computed(() => a.value.tracks[ti.value])
const staff = computed(() => track.value?.staves[si.value])
const measure = computed(() => staff.value?.measures[bi.value])
const voice = computed(() => measure.value?.voices[vi.value])
const event = computed(() => voice.value?.events[ei.value])
const errors = computed(() => arrangementErrors(a.value))
const localError = ref(''),
    duration = ref<Duration>(4),
    dots = ref<0 | 1 | 2>(0),
    triplet = ref(false)
const instrument = ref<Instrument>('guitar'),
    inputMode = ref('tab'),
    noteName = ref(0),
    octave = ref(4),
    accidental = ref(0),
    string = ref(1),
    fret = ref(0),
    drum = ref(36),
    tie = ref(false)
const copyStart = ref(1),
    copyEnd = ref(1)
const past = ref<Arrangement[]>([]),
    future = ref<Arrangement[]>([])
const root = ref<HTMLElement>()
const snapshot = () => structuredClone(toRaw(a.value))
function commit(edit: (value: Arrangement) => void) {
    if (props.readonly) return
    const before = snapshot(),
        next = snapshot()
    edit(next)
    if (!scoreStructure([...(props.siblings ?? []), next])) {
        localError.value = s.limit
        return
    }
    past.value.push(before)
    if (past.value.length > 50) past.value.shift()
    future.value = []
    a.value = next
    localError.value = ''
    emit('change', snapshot())
}
function history(redo = false) {
    const from = redo ? future : past,
        to = redo ? past : future
    const next = from.value.pop()
    if (!next) return
    to.value.push(snapshot())
    a.value = next
    reset()
    emit('change', snapshot())
}
function reset() {
    ti.value = Math.max(0, Math.min(ti.value, a.value.tracks.length - 1))
    si.value = 0
    bi.value = Math.min(bi.value, a.value.bars.length - 1)
    vi.value = 0
    ei.value = 0
}
function selected(t: number, st: number, bar: number, v: number, e: number) {
    ti.value = t
    si.value = st
    bi.value = bar
    vi.value = v
    ei.value = e
}
const editVoice = (next: Arrangement) =>
    next.tracks[ti.value]!.staves[si.value]!.measures[bi.value]!.voices[vi.value]!
function newNote(): ScoreNote | undefined {
    const n: ScoreNote = {
        id: uid(),
        pitch: 60,
        spelling: accidental.value > 0 ? 'sharp' : accidental.value < 0 ? 'flat' : 'auto',
        tie: tie.value,
    }
    const t = track.value
    if (!t) return
    if (t.instrument === 'drums') {
        n.pitch = drum.value
        n.tie = false
    } else {
        n.pitch = (octave.value + 1) * 12 + noteName.value + accidental.value
        if (t.instrument === 'guitar' || t.instrument === 'bass') {
            const tuning = tunings[t.instrument]
            if (inputMode.value === 'tab') {
                n.string = string.value
                n.fret = fret.value
                n.pitch = tuning[string.value - 1]! + fret.value
            } else {
                const chosen = tuning.findIndex((p) => n.pitch >= p && n.pitch <= p + 24)
                if (chosen < 0) {
                    localError.value = s.pitchRange
                    return
                }
                n.string = chosen + 1
                n.fret = n.pitch - tuning[chosen]!
            }
        }
    }
    if (!Number.isInteger(n.pitch) || n.pitch < 0 || n.pitch > 127) {
        localError.value = s.pitchRange
        return
    }
    return n
}
function insert(rest = false, chord = false, after = false) {
    if (!voice.value || (chord && !event.value)) return
    const n = rest ? undefined : newNote()
    if (!rest && !n) return
    const index = chord ? ei.value : after ? ei.value + 1 : voice.value.events.length
    commit((next) => {
        const v = editVoice(next)
        if (chord) v.events[ei.value]!.notes.push(n!)
        else
            v.events.splice(index, 0, {
                id: uid(),
                duration: duration.value,
                dots: dots.value,
                triplet: triplet.value,
                notes: n ? [n] : [],
            })
    })
    ei.value = index
}
function rhythm() {
    if (event.value)
        commit((next) =>
            Object.assign(editVoice(next).events[ei.value]!, {
                duration: duration.value,
                dots: dots.value,
                triplet: triplet.value,
            }),
        )
}
function fillRests() {
    if (voice.value)
        commit((next) => {
            const v = editVoice(next)
            let remaining = barTicks(next) - v.events.reduce((sum, e) => sum + eventTicks(e), 0)
            for (const d of durations)
                while (remaining >= 384 / d) {
                    v.events.push({ id: uid(), duration: d, dots: 0, triplet: false, notes: [] })
                    remaining -= 384 / d
                }
        })
}
function addVoice() {
    if (!staff.value || measure.value!.voices.length >= 4) return
    commit((next) => {
        for (const m of next.tracks[ti.value]!.staves[si.value]!.measures)
            m.voices.push({ id: uid(), events: [] })
    })
    vi.value = measure.value!.voices.length - 1
    ei.value = 0
}
function removeBar() {
    if (a.value.bars.length === 1 || !confirm(s.deleteMeasureConfirm)) return
    commit((next) => {
        next.bars.splice(bi.value, 1)
        for (const t of next.tracks) for (const st of t.staves) st.measures.splice(bi.value, 1)
    })
    reset()
}
function duplicatePassage() {
    const start = Math.floor(copyStart.value) - 1,
        end = Math.floor(copyEnd.value) - 1
    if (start < 0 || end < start || end >= a.value.bars.length) {
        localError.value = s.rangeError
        return
    }
    commit((next) => copyBars(next, start, end))
}
function addTrack() {
    commit((next) => {
        next.tracks.push(newTrack(instrument.value, next.bars.length))
    })
    ti.value = a.value.tracks.length - 1
    selectTrack()
}
function chooseTrack(event: Event) {
    ti.value = Number((event.target as HTMLSelectElement).value)
    selectTrack()
}
function chooseStaff(event: Event) {
    si.value = Number((event.target as HTMLSelectElement).value)
    selectMeasure()
}
function chooseMeasure(event: Event) {
    bi.value = Number((event.target as HTMLSelectElement).value)
    selectMeasure()
}
function chooseVoice(event: Event) {
    vi.value = Number((event.target as HTMLSelectElement).value)
    ei.value = 0
}
function selectTrack() {
    si.value = 0
    string.value = 1
    selectMeasure()
}
function selectMeasure() {
    vi.value = 0
    ei.value = 0
}
function removeVoice() {
    commit((next) => {
        for (const m of next.tracks[ti.value]!.staves[si.value]!.measures)
            m.voices.splice(vi.value, 1)
    })
    selectMeasure()
}
function removeEvent() {
    commit((next) => {
        editVoice(next).events.splice(ei.value, 1)
    })
    ei.value = Math.max(0, ei.value - 1)
}
function appendMeasure() {
    commit(addBar)
    bi.value = a.value.bars.length - 1
    selectMeasure()
}
function removeTrack() {
    if (!track.value || !confirm(s.deleteTrackConfirm)) return
    commit((next) => {
        next.tracks.splice(ti.value, 1)
    })
    reset()
}
function trapFocus(event: KeyboardEvent) {
    const controls = [
        ...(root.value?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
        ) ?? []),
    ].filter((e) => e.getClientRects().length)
    const first = controls[0],
        last = controls[controls.length - 1]
    if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === root.value)
    ) {
        event.preventDefault()
        last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
    }
}
function pitchLabel(n: ScoreNote) {
    if (track.value?.instrument === 'drums')
        return s.drums[n.pitch as keyof typeof s.drums] ?? n.pitch
    return (
        ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][n.pitch % 12]! +
        (Math.floor(n.pitch / 12) - 1) +
        (n.string ? ` · ${n.string}:${n.fret}` : '') +
        (n.tie ? ' ⌒' : '')
    )
}
watch(
    event,
    (e) => {
        if (e) {
            duration.value = e.duration
            dots.value = e.dots
            triplet.value = e.triplet
        }
    },
    { immediate: true },
)
let overflow = '',
    previousFocus: HTMLElement | null = null
onMounted(() => {
    overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    previousFocus = document.activeElement as HTMLElement
    root.value?.focus()
})
onBeforeUnmount(() => {
    document.body.style.overflow = overflow
    previousFocus?.focus()
})
</script>
<template>
    <section
        ref="root"
        class="score-workspace"
        role="dialog"
        aria-modal="true"
        :aria-label="s.workspace"
        tabindex="-1"
        @keydown.esc.stop="emit('close')"
        @keydown.tab="trapFocus"
    >
        <div class="screen-heading">
            <h1>{{ a.name || s.untitled }}</h1>
            <button @click="emit('close')">{{ s.back }}</button>
        </div>
        <p v-if="status" role="status" class="save-status">{{ status }}</p>
        <p v-if="localError" class="notice error" role="alert">{{ localError }}</p>
        <details v-if="!readonly" open class="score-tools">
            <summary>{{ s.editTools }}</summary>
            <div class="field-grid">
                <label
                    >{{ s.name
                    }}<input
                        :value="a.name"
                        maxlength="200"
                        @input="
                            commit((next) => {
                                next.name = ($event.target as HTMLInputElement).value
                            })
                        "
                /></label>
                <label
                    >{{ s.tempo
                    }}<input
                        :value="a.tempo"
                        type="number"
                        min="20"
                        max="300"
                        @input="
                            commit((next) => {
                                next.tempo = Number(($event.target as HTMLInputElement).value)
                            })
                        "
                /></label>
                <label
                    >{{ s.beats
                    }}<input
                        :value="a.numerator"
                        type="number"
                        min="1"
                        max="32"
                        @change="
                            commit((next) => {
                                next.numerator = Number(($event.target as HTMLInputElement).value)
                            })
                        "
                /></label>
                <label
                    >{{ s.beatUnit
                    }}<select
                        :value="a.denominator"
                        @change="
                            commit((next) => {
                                next.denominator = Number(
                                    ($event.target as HTMLSelectElement).value,
                                ) as Arrangement['denominator']
                            })
                        "
                    >
                        <option v-for="d in [2, 4, 8, 16]" :key="d">{{ d }}</option>
                    </select></label
                >
                <label
                    >{{ s.key
                    }}<select
                        :value="a.key"
                        @change="
                            commit((next) => {
                                next.key = Number(($event.target as HTMLSelectElement).value)
                            })
                        "
                    >
                        <option
                            v-for="(key, i) in a.mode === 'minor' ? s.minorKeys : s.keys"
                            :key="key"
                            :value="i - 7"
                        >
                            {{ key }}
                        </option>
                    </select></label
                >
                <label
                    >{{ s.keyMode
                    }}<select
                        :value="a.mode ?? 'major'"
                        @change="
                            commit((next) => {
                                next.mode = ($event.target as HTMLSelectElement).value as
                                    'major' | 'minor'
                            })
                        "
                    >
                        <option value="major">{{ s.major }}</option>
                        <option value="minor">{{ s.minor }}</option>
                    </select></label
                >
            </div>
            <div class="actions">
                <button :disabled="!past.length" @click="history()">{{ s.undo }}</button
                ><button :disabled="!future.length" @click="history(true)">{{ s.redo }}</button>
            </div>
            <div class="score-controls">
                <label
                    >{{ s.instrument
                    }}<select v-model="instrument">
                        <option v-for="i in instruments" :key="i" :value="i">
                            {{ s.instruments[i] }}
                        </option>
                    </select></label
                ><button @click="addTrack">
                    {{ s.addTrack }}
                </button>
                <label v-if="track"
                    >{{ s.track
                    }}<select :value="ti" @change="chooseTrack">
                        <option v-for="(t, i) in a.tracks" :key="t.id" :value="i">
                            {{ t.name }}
                        </option>
                    </select></label
                >
                <label v-if="track"
                    >{{ s.trackName
                    }}<input
                        :value="track.name"
                        maxlength="200"
                        @input="
                            commit((next) => {
                                next.tracks[ti]!.name = ($event.target as HTMLInputElement).value
                            })
                        " /></label
                ><button v-if="track" @click="removeTrack">{{ s.deleteTrack }}</button>
                <label v-if="staff"
                    >{{ s.staff
                    }}<select :value="si" @change="chooseStaff">
                        <option v-for="(st, i) in track!.staves" :key="st.id" :value="i">
                            {{ st.clef }}
                        </option>
                    </select></label
                >
                <label
                    >{{ s.measure
                    }}<select :value="bi" @change="chooseMeasure">
                        <option v-for="(_, i) in a.bars" :key="i" :value="i">{{ i + 1 }}</option>
                    </select></label
                >
                <label v-if="measure"
                    >{{ s.voice
                    }}<select :value="vi" @change="chooseVoice">
                        <option v-for="(_, i) in measure.voices" :key="i" :value="i">
                            {{ i + 1 }}
                        </option>
                    </select></label
                ><button :disabled="!measure || measure.voices.length >= 4" @click="addVoice">
                    {{ s.addVoice }}
                </button>
                <button v-if="vi > 0" @click="removeVoice">
                    {{ s.deleteVoice }}
                </button>
            </div>
            <div v-if="voice" class="score-events" :aria-label="s.events">
                <button
                    v-for="(e, i) in voice.events"
                    :key="e.id"
                    :aria-pressed="ei === i"
                    @click="ei = i"
                >
                    {{ i + 1 }} ·
                    {{ e.notes.length ? e.notes.map(pitchLabel).join(' + ') : s.rest }} · 1/{{
                        e.duration
                    }}{{ '.'.repeat(e.dots) }}{{ e.triplet ? ' ③' : '' }}
                </button>
                <p v-if="!voice.events.length">{{ s.emptyMeasure }}</p>
            </div>
            <div v-if="voice" class="score-controls">
                <label
                    >{{ s.duration
                    }}<select v-model.number="duration">
                        <option v-for="d in durations" :key="d" :value="d">1/{{ d }}</option>
                    </select></label
                >
                <label
                    >{{ s.dots
                    }}<select v-model.number="dots">
                        <option v-for="d in [0, 1, 2]" :key="d" :value="d">{{ d }}</option>
                    </select></label
                >
                <label class="check-row"
                    ><input v-model="triplet" type="checkbox" />{{ s.triplet }}</label
                ><button :disabled="!event" @click="rhythm">{{ s.applyRhythm }}</button>
                <template v-if="track?.instrument !== 'drums'">
                    <label v-if="track?.instrument !== 'piano'"
                        >{{ s.input
                        }}<select v-model="inputMode">
                            <option value="tab">{{ s.tab }}</option>
                            <option value="pitch">{{ s.pitch }}</option>
                        </select></label
                    >
                    <template v-if="inputMode === 'tab' && track?.instrument !== 'piano'"
                        ><label
                            >{{ s.string
                            }}<select v-model.number="string">
                                <option
                                    v-for="(_, i) in tunings[
                                        track!.instrument as 'guitar' | 'bass'
                                    ]"
                                    :key="i"
                                    :value="i + 1"
                                >
                                    {{ i + 1 }}
                                </option>
                            </select></label
                        ><label
                            >{{ s.fret
                            }}<input v-model.number="fret" type="number" min="0" max="24" /></label
                    ></template>
                    <template v-else
                        ><label
                            >{{ s.pitch
                            }}<select v-model.number="noteName">
                                <option
                                    v-for="(n, i) in ['C', 'D', 'E', 'F', 'G', 'A', 'B']"
                                    :key="n"
                                    :value="[0, 2, 4, 5, 7, 9, 11][i]"
                                >
                                    {{ n }}
                                </option>
                            </select></label
                        ><label
                            >{{ s.octave
                            }}<input
                                v-model.number="octave"
                                type="number"
                                min="-1"
                                max="9" /></label
                        ><label
                            >{{ s.accidental
                            }}<select v-model.number="accidental">
                                <option :value="-1">♭</option>
                                <option :value="0">♮</option>
                                <option :value="1">♯</option>
                            </select></label
                        ></template
                    >
                    <label class="check-row"
                        ><input v-model="tie" type="checkbox" />{{ s.tie }}</label
                    >
                </template>
                <label v-else
                    >{{ s.drum
                    }}<select v-model.number="drum">
                        <option
                            v-for="(name, pitch) in s.drums"
                            :key="pitch"
                            :value="Number(pitch)"
                        >
                            {{ name }}
                        </option>
                    </select></label
                >
                <button @click="insert()">{{ s.appendNote }}</button
                ><button :disabled="!event" @click="insert(false, true)">{{ s.addChord }}</button
                ><button :disabled="!event" @click="insert(false, false, true)">
                    {{ s.insertNote }}</button
                ><button :disabled="!event" @click="insert(true, false, true)">
                    {{ s.insertRest }}</button
                ><button @click="insert(true)">{{ s.appendRest }}</button
                ><button @click="fillRests">{{ s.fillRests }}</button>
                <button :disabled="!event" @click="removeEvent">
                    {{ s.deleteEvent }}
                </button>
            </div>
            <ul v-if="event?.notes.length" class="plain-list">
                <li v-for="(n, ni) in event.notes" :key="n.id">
                    <span>{{ pitchLabel(n) }}</span
                    ><label v-if="track?.instrument !== 'drums'" class="check-row"
                        ><input
                            :checked="n.tie"
                            type="checkbox"
                            @change="
                                commit((next) => {
                                    editVoice(next).events[ei]!.notes[ni]!.tie = (
                                        $event.target as HTMLInputElement
                                    ).checked
                                })
                            "
                        />{{ s.tie }}</label
                    ><button
                        @click="
                            commit((next) => {
                                editVoice(next).events[ei]!.notes.splice(ni, 1)
                            })
                        "
                    >
                        {{ s.deleteNote }}
                    </button>
                </li>
            </ul>
            <div class="score-controls">
                <button @click="appendMeasure">
                    {{ s.addMeasure }}</button
                ><button :disabled="a.bars.length < 2" @click="removeBar">
                    {{ s.deleteMeasure }}</button
                ><label
                    >{{ s.copyFrom
                    }}<input
                        v-model.number="copyStart"
                        type="number"
                        min="1"
                        :max="a.bars.length" /></label
                ><label
                    >{{ s.to
                    }}<input
                        v-model.number="copyEnd"
                        type="number"
                        min="1"
                        :max="a.bars.length" /></label
                ><button @click="duplicatePassage">{{ s.copyPassage }}</button>
            </div>
        </details>
        <details v-if="errors.length" class="notice error">
            <summary>{{ s.errors }} ({{ errors.length }})</summary>
            <ul>
                <li v-for="e in errors.slice(0, 100)" :key="e">{{ e }}</li>
            </ul>
        </details>
        <ScoreView :arrangement="a" @select="selected" />
    </section>
</template>
