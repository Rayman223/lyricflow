<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'
import {
    arrangementErrors,
    duplicateArrangement,
    newArrangement,
    scoreStructure,
    type Arrangement,
} from '../domain/score'
import { scoreText as s } from '../i18n/en'
const ScoreWorkspace = defineAsyncComponent(() => import('./ScoreWorkspace.vue'))
const props = defineProps<{ arrangements?: Arrangement[]; editable?: boolean; status?: string }>()
const emit = defineEmits<{ change: [value: Arrangement[]] }>()
const opened = ref<string>(),
    error = ref('')
function update(value: Arrangement[]) {
    if (!scoreStructure(value)) {
        error.value = s.limit
        return false
    }
    error.value = ''
    emit('change', JSON.parse(JSON.stringify(value)))
    return true
}
function create() {
    const a = newArrangement()
    if (update([...(props.arrangements ?? []), a])) opened.value = a.id
}
function remove(id: string) {
    if (confirm(s.deleteConfirm)) update((props.arrangements ?? []).filter((a) => a.id !== id))
}
function rename(a: Arrangement) {
    const name = prompt(s.name, a.name)
    if (name !== null)
        update(props.arrangements!.map((item) => (item.id === a.id ? { ...item, name } : item)))
}
</script>
<template>
    <section v-if="editable || arrangements?.length" class="scores-panel" :aria-label="s.scores">
        <h2>{{ s.scores }}</h2>
        <p>{{ editable ? s.editorHint : s.readerHint }}</p>
        <button v-if="editable" @click="create">{{ s.create }}</button>
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <ul class="plain-list">
            <li v-for="a in arrangements" :key="a.id" class="score-list-row">
                <button @click="opened = a.id">
                    {{ a.name || s.untitled }} · {{ a.tracks.length }} {{ s.tracks }} ·
                    {{ a.tempo }} BPM
                </button>
                <span v-if="arrangementErrors(a).length">{{ s.draft }}</span>
                <template v-if="editable"
                    ><button class="quiet" @click="rename(a)">{{ s.rename }}</button
                    ><button
                        class="quiet"
                        @click="update([...(arrangements ?? []), duplicateArrangement(a)])"
                    >
                        {{ s.duplicate }}</button
                    ><button class="quiet danger" @click="remove(a.id)">
                        {{ s.delete }}
                    </button></template
                >
            </li>
        </ul>
        <template v-for="a in arrangements" :key="a.id"
            ><ScoreWorkspace
                v-if="opened === a.id"
                :arrangement="a"
                :siblings="arrangements?.filter((item) => item.id !== a.id)"
                :readonly="!editable"
                :status="status"
                @close="opened = undefined"
                @change="update(arrangements!.map((item) => (item.id === a.id ? $event : item)))"
        /></template>
    </section>
</template>
