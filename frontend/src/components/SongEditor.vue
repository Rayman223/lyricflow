<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch, toRaw } from 'vue'
import type { SharingEntry } from '../community/model'
import { sharingEnabled } from '../community/model'
import SharingStatus from './SharingStatus.vue'
import type { Song } from '../domain/song'
import {
    musicServices,
    validMusicLinks,
    cleanMusicLinks,
    validMusicLink,
} from '../domain/musicLinks'
import { validSettings } from '../domain/song'
import { parseLyrics } from '../domain/parser'
import { t, diagnostic } from '../i18n/en'
import ScoresPanel from './ScoresPanel.vue'
import TimingFields from './TimingFields.vue'
import TapTempo from './TapTempo.vue'
import { textareaCaret } from './textareaCaret'

const props = defineProps<{
    song: Song
    savedState: 'saved' | 'pending' | 'error'
    saveError: string
    busy: boolean
    sharing?: SharingEntry
    sharingUnknown?: boolean
    sharingSaving?: boolean
    sharingError?: string
    sharingEditable?: boolean
}>()
const emit = defineEmits<{
    save: [song: Song]
    draft: [song: Song]
    read: [song: Song]
    autoShare: [enabled: boolean]
    back: []
}>()
const model = ref(structuredClone(toRaw(props.song)))
model.value.musicLinks ??= {}
const textarea = ref<HTMLTextAreaElement>()
const tool = ref<'section' | 'line' | 'block' | 'pause' | null>(null)
const toolDialog = ref<HTMLElement>()
const section = ref('Verse'),
    tempo = ref(''),
    lineDuration = ref(''),
    lineUnit = ref<'bars' | 'beats'>('bars'),
    duration = ref(4),
    unit = ref('beats')
const selection = ref({ start: 0, end: 0 })
const tagPopup = ref<HTMLDivElement>()
const tagPosition = ref<{
    left: number
    top: number
    above: boolean
    room: number
    width: number
} | null>(null)
const tagsExpanded = ref(false)
let tagsRequested = false
let tagFrame = 0
const tagTools = [
    { value: 'section', label: 'section' },
    { value: 'line', label: 'lineCode' },
    { value: 'block', label: 'blockCode' },
    { value: 'pause', label: 'pauseCode' },
] as const
const parsed = computed(() => parseLyrics(model.value.lyrics))
const help = ref(false)
const localError = ref('')
const snapshot = () => structuredClone(toRaw(model.value))

function hideTags() {
    tagsRequested = false
    tagPosition.value = null
    tagsExpanded.value = false
}
function collapseTags(event: PointerEvent) {
    if (event.pointerType === 'mouse' && !tagPopup.value?.contains(document.activeElement)) {
        tagsExpanded.value = false
    }
}
function showTags() {
    tagsRequested = true
    tagsExpanded.value = false
    positionTags()
}
function positionTags() {
    if (!tagsRequested) return
    const input = textarea.value
    const focused = document.activeElement
    if (
        !input ||
        (focused !== input && !tagPopup.value?.contains(focused)) ||
        props.busy ||
        tool.value
    ) {
        hideTags()
        return
    }
    const caret = textareaCaret(input)
    const rect = input.getBoundingClientRect()
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const right = left + (viewport?.width ?? window.innerWidth)
    const bottom = top + (viewport?.height ?? window.innerHeight)
    if (caret.bottom < Math.max(rect.top, top) || caret.top > Math.min(rect.bottom, bottom)) {
        // Keyboard animations may temporarily hide the caret before panning
        // the viewport. Keep the request so the next viewport event can restore it.
        tagPosition.value = null
        return
    }
    const below = bottom - caret.bottom - 8
    const above = caret.top - top - 8
    const upwards = below < 250 && above > below
    const y = Math.max(top + 8, Math.min(bottom - 52, upwards ? caret.top - 44 : caret.bottom))
    const width = Math.max(0, Math.min(232, right - left - 16))
    selection.value = { start: input.selectionStart, end: input.selectionEnd }
    tagPosition.value = {
        left: Math.max(left + 8, Math.min(caret.left, rect.right - width, right - width - 8)),
        top: y,
        above: upwards,
        room: Math.max(0, upwards ? y - top - 8 : bottom - y - 52),
        width,
    }
}
function refreshTags() {
    if (!tagsRequested || tagFrame) return
    tagFrame = requestAnimationFrame(() => {
        tagFrame = 0
        positionTags()
    })
}
function scrollTags(event: Event) {
    if (event.target === textarea.value || tagPopup.value?.contains(event.target as Node)) return
    refreshTags()
}
function dismissTags(event: Event) {
    if (event.target === textarea.value || tagPopup.value?.contains(event.target as Node)) return
    hideTags()
}
function blurTags(event: FocusEvent) {
    if (!tagPopup.value?.contains(event.relatedTarget as Node)) hideTags()
}
function escapeTags() {
    textarea.value?.focus({ preventScroll: true })
    hideTags()
}
async function closeTool() {
    tool.value = null
    await nextTick()
    textarea.value?.focus({ preventScroll: true })
    textarea.value?.setSelectionRange(selection.value.start, selection.value.end)
    hideTags()
}
onMounted(() => {
    document.addEventListener('pointerdown', dismissTags)
    document.addEventListener('scroll', scrollTags, true)
    window.addEventListener('resize', refreshTags)
    window.visualViewport?.addEventListener('resize', refreshTags)
    window.visualViewport?.addEventListener('scroll', refreshTags)
})
onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', dismissTags)
    document.removeEventListener('scroll', scrollTags, true)
    window.removeEventListener('resize', refreshTags)
    window.visualViewport?.removeEventListener('resize', refreshTags)
    window.visualViewport?.removeEventListener('scroll', refreshTags)
    cancelAnimationFrame(tagFrame)
})
watch(
    () => props.busy,
    (busy) => {
        if (busy) hideTags()
    },
)
watch(
    model,
    () => {
        localError.value = ''
        emit('draft', snapshot())
    },
    { deep: true },
)

function validate() {
    if (!validMusicLinks(model.value.musicLinks)) {
        localError.value = t('musicLinksError')
        return false
    }
    if (!validSettings(model.value.settings)) {
        localError.value = t('settingsError')
        return false
    }
    if (
        model.value.title.length > 200 ||
        model.value.artist.length > 200 ||
        model.value.lyrics.length > 100000
    ) {
        localError.value = t('sizeError')
        return false
    }
    return true
}
function save() {
    if (validate())
        emit('save', { ...snapshot(), musicLinks: cleanMusicLinks(model.value.musicLinks) })
}
function read() {
    if (!validate() || parsed.value.errors.length) return
    if (!parsed.value.items.some((item) => item.kind === 'lyric')) {
        localError.value = t('noLyrics')
        return
    }
    emit('read', { ...snapshot(), musicLinks: cleanMusicLinks(model.value.musicLinks) })
}
async function openTool(value: typeof tool.value) {
    selection.value = {
        start: textarea.value?.selectionStart ?? model.value.lyrics.length,
        end: textarea.value?.selectionEnd ?? model.value.lyrics.length,
    }
    hideTags()
    tool.value = value
    tempo.value = ''
    lineDuration.value = ''
    lineUnit.value = 'bars'
    await nextTick()
    toolDialog.value?.querySelector<HTMLElement>('input, select')?.focus()
}
async function insert() {
    const text = model.value.lyrics
    let { start, end } = selection.value
    const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
    let replacement = ''
    let selectedStart: number | undefined
    let selectedEnd: number | undefined
    if (tool.value === 'line') {
        start = lineStart
        end = lineStart
        // Replace a previous line tag so the editor always emits one combined code.
        const previous = /^[ \t]*\[line ([^\]]+)\][ \t]*/.exec(text.slice(start))
        const previousParams = Object.fromEntries(
            (previous?.[1]?.split(/\s+/) ?? []).map((p) => p.split('=')),
        )
        const nextTempo = tempo.value.trim() || previousParams.tempo
        const nextDuration = lineDuration.value.trim()
        const durationParam = nextDuration
            ? `${lineUnit.value}=${nextDuration}`
            : previousParams.beats
              ? `beats=${previousParams.beats}`
              : previousParams.bars
                ? `bars=${previousParams.bars}`
                : ''
        const params = [nextTempo ? `tempo=${nextTempo}` : '', durationParam].filter(Boolean)
        if (!params.length) return
        replacement = `[line ${params.join(' ')}] `
        if (previous) end += previous[0].length
    } else if (tool.value === 'block') {
        start = lineStart
        const endOfLine = text.indexOf('\n', Math.max(start, end - 1))
        end = endOfLine < 0 ? text.length : endOfLine
        const params = [
            tempo.value.trim() ? `tempo=${tempo.value.trim()}` : '',
            lineDuration.value.trim() ? `${lineUnit.value}=${lineDuration.value.trim()}` : '',
        ].filter(Boolean)
        if (!params.length) return
        const opening = lineDuration.value.trim() ? `[line ${params.join(' ')}]` : `[${params[0]}]`
        const closing = lineDuration.value.trim() ? '[/line]' : '[/tempo]'
        replacement = `${opening}\n${text.slice(start, end)}\n${closing}`
        selectedStart = start + opening.length + 1
        selectedEnd = selectedStart + end - start
    } else {
        start = lineStart
        end = lineStart
        replacement =
            tool.value === 'section'
                ? `[section=${section.value}]\n`
                : `[pause ${unit.value}=${duration.value}]\n`
    }
    model.value.lyrics = text.slice(0, start) + replacement + text.slice(end)
    tool.value = null
    await nextTick()
    textarea.value?.focus()
    textarea.value?.setSelectionRange(
        selectedStart ?? start + replacement.length,
        selectedEnd ?? start + replacement.length,
    )
}
</script>

<template>
    <section class="editor screen">
        <fieldset class="editor-fields" :disabled="busy">
            <div class="screen-heading">
                <div>
                    <p class="eyebrow">{{ t('private') }} · {{ t('local') }}</p>
                    <h1>{{ t('editor') }} <SharingStatus :entry="sharing" badge-only /></h1>
                </div>
                <button class="quiet" @click="emit('back')">{{ t('back') }}</button>
            </div>
            <p v-if="sharingUnknown" class="notice">{{ t('sharingUnknown') }}</p>
            <div v-if="sharing" class="notice">
                <label v-if="sharing.publication.published" class="check-row">
                    <input
                        type="checkbox"
                        :checked="sharingEnabled(sharing)"
                        :disabled="sharingSaving || !sharingEditable || sharing.publication.hidden"
                        @change="emit('autoShare', ($event.target as HTMLInputElement).checked)"
                    />
                    {{ t('autoShareUpdates') }}
                </label>
                <p v-if="sharing.publication.published">{{ t('autoShareHint') }}</p>
                <SharingStatus :entry="sharing" details-only />
                <p v-if="sharingError" role="status">{{ sharingError }}</p>
            </div>
            <div class="field-grid metadata">
                <label
                    >{{ t('title')
                    }}<input
                        v-model="model.title"
                        :placeholder="t('titlePlaceholder')"
                        maxlength="200" /></label
                ><label
                    >{{ t('artist')
                    }}<input
                        v-model="model.artist"
                        :placeholder="t('artistPlaceholder')"
                        maxlength="200"
                /></label>
            </div>
            <fieldset class="music-link-fields">
                <legend>{{ t('musicLinks') }}</legend>
                <p id="music-links-hint">{{ t('musicLinksHint') }}</p>
                <div class="field-grid">
                    <label v-for="service in musicServices" :key="service.key">
                        {{ service.name }} {{ t('optionalLink') }}
                        <input
                            v-model="model.musicLinks![service.key]"
                            type="url"
                            maxlength="2048"
                            :placeholder="service.example"
                            aria-describedby="music-links-hint"
                            :aria-invalid="
                                !!model.musicLinks?.[service.key]?.trim() &&
                                !validMusicLink(service.key, model.musicLinks[service.key]!.trim())
                            "
                        />
                    </label>
                </div>
            </fieldset>
            <ScoresPanel
                :arrangements="model.arrangements"
                editable
                :status="
                    savedState === 'saved'
                        ? t('draftSaved')
                        : savedState === 'pending'
                          ? t('draftPending')
                          : t('storageError')
                "
                @change="model.arrangements = $event"
            />
            <label class="lyrics-label" for="lyrics">{{ t('lyrics') }}</label>
            <div class="code-toolbar" :aria-label="t('insert')">
                <button type="button" @click="openTool('section')">+ {{ t('section') }}</button
                ><button @click="openTool('line')">+ {{ t('lineCode') }}</button
                ><button @click="openTool('block')">+ {{ t('blockCode') }}</button
                ><button @click="openTool('pause')">+ {{ t('pauseCode') }}</button
                ><button class="quiet" @click="help = !help">{{ t('codeHelp') }}</button>
            </div>
            <div v-if="help" class="notice">
                <p>{{ t('helpIntro') }}</p>
                <p>{{ t('helpLine') }}</p>
                <p>{{ t('helpBlock') }}</p>
                <p>{{ t('helpPause') }}</p>
                <p>{{ t('helpEscape') }}</p>
                <p>{{ t('helpLimits') }}</p>
            </div>
            <textarea
                id="lyrics"
                ref="textarea"
                v-model="model.lyrics"
                spellcheck="false"
                :placeholder="t('lyricsPlaceholder')"
                maxlength="100000"
                rows="13"
                @focus="showTags"
                @click="showTags"
                @select="tagsRequested && showTags()"
                @keyup="$event.key !== 'Escape' && $event.key !== 'Tab' && showTags()"
                @input="showTags"
                @scroll="hideTags"
                @blur="blurTags"
                @keydown.esc="hideTags"
            />
            <div
                v-if="tagPosition && !busy"
                ref="tagPopup"
                class="tag-popup"
                :class="{ expanded: tagsExpanded, above: tagPosition.above }"
                :style="{
                    left: `${tagPosition.left}px`,
                    top: `${tagPosition.top}px`,
                    '--tag-room': `${tagPosition.room}px`,
                    '--tag-width': `${tagPosition.width}px`,
                }"
                @pointerenter="$event.pointerType === 'mouse' && (tagsExpanded = true)"
                @pointerleave="collapseTags"
                @focusin="tagsExpanded = true"
                @focusout="blurTags"
                @keydown.esc.stop.prevent="escapeTags"
            >
                <button
                    type="button"
                    class="tag-trigger"
                    :aria-label="t('addTag')"
                    :aria-expanded="tagsExpanded"
                    aria-controls="tag-options"
                    @pointerdown.prevent
                    @click="tagsExpanded = true"
                >
                    <span aria-hidden="true">＋</span
                    ><span v-if="tagsExpanded">{{ t('addTag') }}</span>
                </button>
                <div
                    v-if="tagsExpanded"
                    id="tag-options"
                    class="tag-options"
                    role="group"
                    :aria-label="t('tagOptions')"
                >
                    <button
                        v-for="item in tagTools"
                        :key="item.value"
                        type="button"
                        @pointerdown.prevent
                        @click="openTool(item.value)"
                    >
                        {{ t(item.label) }}
                    </button>
                </div>
            </div>
            <p class="save-status" :class="{ error: savedState === 'error' }" role="status">
                {{
                    savedState === 'saved'
                        ? t('draftSaved')
                        : savedState === 'pending'
                          ? t('draftPending')
                          : t('storageError')
                }}
            </p>
            <div v-if="parsed.errors.length" class="notice error" role="alert">
                <p>{{ t('invalidCodes') }}</p>
                <ul>
                    <li v-for="(error, i) in parsed.errors" :key="i">
                        {{ t('lineError', { line: error.line, message: diagnostic(error.code) }) }}
                    </li>
                </ul>
            </div>
            <details class="timing" open>
                <summary>{{ t('music') }}</summary>
                <TimingFields :settings="model.settings" />
                <TapTempo @apply="model.settings.bpm = $event" />
            </details>
            <p v-if="localError || saveError" class="notice error" role="alert">
                {{ localError || saveError }}
            </p>
            <div class="editor-actions">
                <button @click="save">{{ t('save') }}</button
                ><button class="primary" :disabled="parsed.errors.length > 0" @click="read">
                    {{ t('read') }} <span aria-hidden="true">→</span>
                </button>
            </div>
            <div
                v-if="tool"
                class="modal-shade"
                @click.self="closeTool"
                @keydown.esc.stop.prevent="closeTool"
            >
                <section
                    ref="toolDialog"
                    role="dialog"
                    aria-modal="true"
                    :aria-label="t('insert')"
                    class="modal"
                >
                    <h2>{{ t('insert') }}</h2>
                    <label v-if="tool === 'section'"
                        >{{ t('section')
                        }}<select v-model="section">
                            <option value="Intro">{{ t('sectionIntro') }}</option>
                            <option value="Verse">{{ t('verse') }}</option>
                            <option value="Pre-Chorus">{{ t('preChorus') }}</option>
                            <option value="Chorus">{{ t('chorus') }}</option>
                            <option value="Bridge">{{ t('bridge') }}</option>
                            <option value="Solo">{{ t('solo') }}</option>
                            <option value="Outro">{{ t('outro') }}</option>
                        </select></label
                    >
                    <template v-if="tool === 'line' || tool === 'block'"
                        ><label
                            >{{ t('optionalTempo')
                            }}<input v-model="tempo" placeholder="80%" /></label
                        ><label
                            >{{ t('optionalDuration')
                            }}<input v-model="lineDuration" inputmode="decimal" placeholder="2"
                        /></label>
                        <label
                            >{{ t('unit')
                            }}<select v-model="lineUnit">
                                <option value="bars">{{ t('barUnit') }}</option>
                                <option value="beats">{{ t('beatUnit') }}</option>
                            </select></label
                        >
                        <p v-if="tool === 'block'">{{ t('blockHint') }}</p></template
                    >
                    <template v-if="tool === 'pause'"
                        ><label
                            >{{ t('value')
                            }}<input
                                v-model.number="duration"
                                type="number"
                                min="0.01"
                                step="0.5" /></label
                        ><label
                            >{{ t('unit')
                            }}<select v-model="unit">
                                <option value="beats">{{ t('beatUnit') }}</option>
                                <option value="bars">{{ t('barUnit') }}</option>
                                <option value="seconds">{{ t('seconds') }}</option>
                            </select></label
                        ></template
                    >
                    <div class="actions">
                        <button @click="closeTool">{{ t('cancel') }}</button
                        ><button class="primary" @click="insert">{{ t('add') }}</button>
                    </div>
                </section>
            </div>
        </fieldset>
    </section>
</template>
