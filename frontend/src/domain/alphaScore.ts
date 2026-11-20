import { midi, model, Settings } from '@coderline/alphatab'
import { drumPitches, tunings, type Arrangement, type ScoreEvent } from './score'

// alphaTab objects never enter IndexedDB or the wire format.
export function alphaScore(a: Arrangement): model.Score {
    const score = new model.Score()
    score.title = a.name
    for (let i = 0; i < a.bars.length; i++) {
        const master = new model.MasterBar()
        master.timeSignatureNumerator = a.numerator
        master.timeSignatureDenominator = a.denominator
        if (i === 0)
            master.tempoAutomations.push(
                model.Automation.buildTempoAutomation(
                    false,
                    0,
                    Math.max(20, Math.min(300, a.tempo)),
                    2,
                ),
            )
        score.addMasterBar(master)
    }
    for (const [ti, t] of a.tracks.entries()) {
        const track = new model.Track()
        track.name = t.name
        track.shortName = t.name.slice(0, 10)
        track.playbackInfo.program = { guitar: 24, bass: 33, piano: 0, drums: 0 }[t.instrument]
        // alphaTab mixes by channel, not port. Its internal MIDI model supports
        // channels beyond 15 (we do not export SMF). Reserve channel 9 for sample
        // discovery and use a distinct channel and explicit bank for every track.
        const channel = ti < 9 ? ti : ti + 1
        track.playbackInfo.primaryChannel = channel
        track.playbackInfo.secondaryChannel = channel
        track.playbackInfo.bank = t.instrument === 'drums' ? 128 : 0
        score.addTrack(track)
        for (const s of t.staves) {
            const staff = new model.Staff()
            staff.isPercussion = t.instrument === 'drums'
            staff.showStandardNotation = true
            staff.showTablature = t.instrument === 'guitar' || t.instrument === 'bass'
            if (t.instrument === 'guitar' || t.instrument === 'bass')
                staff.stringTuning.tunings = [...tunings[t.instrument]]
            track.addStaff(staff)
            const previous = new Map<number, ScoreEvent>()
            const voiceCount = Math.max(...s.measures.map((m) => m.voices.length))
            for (const m of s.measures) {
                const bar = new model.Bar()
                bar.clef =
                    s.clef === 'bass'
                        ? model.Clef.F4
                        : s.clef === 'percussion'
                          ? model.Clef.Neutral
                          : model.Clef.G2
                bar.keySignature = a.key
                bar.keySignatureType =
                    a.mode === 'minor' ? model.KeySignatureType.Minor : model.KeySignatureType.Major
                staff.addBar(bar)
                for (let vi = 0; vi < voiceCount; vi++) {
                    const v = m.voices[vi]
                    const voice = new model.Voice()
                    bar.addVoice(voice)
                    // An empty draft is shown as a placeholder rest without modifying it.
                    const events = v?.events.length
                        ? v.events
                        : Array.from(
                              { length: a.numerator },
                              () =>
                                  ({
                                      duration: a.denominator,
                                      dots: 0,
                                      triplet: false,
                                      notes: [],
                                  }) as unknown as ScoreEvent,
                          )
                    for (const e of events) {
                        const beat = new model.Beat()
                        beat.duration = e.duration
                        beat.dots = e.dots
                        beat.isEmpty = false
                        if (e.triplet) {
                            beat.tupletNumerator = 3
                            beat.tupletDenominator = 2
                        }
                        voice.addBeat(beat)
                        for (const n of e.notes) {
                            const note = new model.Note()
                            if (staff.isPercussion) note.percussionArticulation = n.pitch
                            else if (staff.isStringed) {
                                note.string = staff.tuning.length + 1 - n.string!
                                note.fret = n.fret!
                            } else {
                                note.octave = Math.floor(n.pitch / 12)
                                note.tone = n.pitch % 12
                            }
                            note.accidentalMode =
                                n.spelling === 'sharp'
                                    ? model.NoteAccidentalMode.ForceSharp
                                    : n.spelling === 'flat'
                                      ? model.NoteAccidentalMode.ForceFlat
                                      : model.NoteAccidentalMode.Default
                            note.isTieDestination = !!previous
                                .get(vi)
                                ?.notes.some(
                                    (p) => p.tie && p.pitch === n.pitch && p.string === n.string,
                                )
                            beat.addNote(note)
                        }
                        previous.set(vi, e)
                    }
                }
            }
        }
    }
    score.finish(new Settings())
    return score
}

// In 1.8.4 the selective SF2 loader discovers percussion samples only on channel
// 9. Zero-velocity note-ons request those samples without sounding or extending
// playback. Real drum notes use their own channels with bank 128, enabling
// independent volumes, mute and solo even for multiple drum tracks.
export function prepareScoreMidi(file: midi.MidiFile, a: Arrangement) {
    if (a.tracks.some((t) => t.instrument === 'drums')) {
        for (const pitch of drumPitches) file.addEvent(new midi.NoteOnEvent(0, 0, 9, pitch, 0))
    }
}
