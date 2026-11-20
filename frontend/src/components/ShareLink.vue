<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Song } from '../domain/song'
import { accountGet, AccountError } from '../accounts/client'
import { sharedContent, sharedSignature, type OwnedPublication } from '../community/model'
import { loadPublicPrompter, publicationLink, type PublicPrompter } from '../community/links'
import { t } from '../i18n/en'

const props = defineProps<{
    song: Song
    accountId?: string
    publicationId?: string
    running?: boolean
}>()
const emit = defineEmits<{ publish: [] }>()
const publication = ref<PublicPrompter>()
const busy = ref(false),
    dialog = ref(false),
    message = ref(''),
    failure = ref('')
const manualUrl = ref('')
const localSignature = computed(() => sharedSignature(sharedContent(props.song)))
const differs = computed(
    () =>
        publication.value &&
        !props.publicationId &&
        sharedSignature(publication.value.content) !== localSignature.value,
)
let retryLoad: () => Promise<void> = async () => {}
let copyRequest = 0

watch(
    () => props.running,
    (running) => {
        if (!running) return
        copyRequest++
        dialog.value = false
        manualUrl.value = ''
    },
)
watch(
    () => [props.song.id, props.accountId, props.publicationId, localSignature.value],
    (_value, _old, onCleanup) => {
        let current = true
        onCleanup(() => {
            current = false
        })
        publication.value = undefined
        copyRequest++
        dialog.value = false
        manualUrl.value = ''
        failure.value = ''
        message.value = ''
        busy.value = false
        const load = async () => {
            if (props.publicationId) return
            busy.value = true
            failure.value = ''
            try {
                let id: string | undefined
                if (props.accountId) {
                    const data = await accountGet<{
                        accountId: string
                        publications: OwnedPublication[]
                    }>(`/api/community/mine?songId=${props.song.id}`)
                    if (!current) return
                    if (data.accountId !== props.accountId)
                        throw new AccountError(t('accountChangedError'), 401)
                    const own = data.publications[0]
                    if (own) {
                        // A withdrawn own publication must not silently fall back to its source.
                        if (!own.published || own.hidden) {
                            failure.value = t('sharedSongUnavailable')
                            return
                        }
                        id = own.id
                    }
                }
                id ??= props.song.source?.publicationId
                if (id) {
                    const result = await loadPublicPrompter(id)
                    if (current) publication.value = result
                }
            } catch (error) {
                if (current)
                    failure.value =
                        error instanceof Error ? error.message : t('accountNetworkError')
            } finally {
                if (current) busy.value = false
            }
        }
        retryLoad = load
        void load()
    },
    { immediate: true },
)
async function copy() {
    const id = props.publicationId ?? publication.value?.id
    if (!id || props.running) return
    const request = ++copyRequest
    const url = publicationLink(id)
    try {
        await navigator.clipboard.writeText(url)
        if (request !== copyRequest) return
        message.value = t('linkCopied')
        manualUrl.value = ''
        dialog.value = false
    } catch {
        if (request !== copyRequest) return
        manualUrl.value = url
        message.value = ''
        dialog.value = true
    }
}
function share() {
    if (failure.value || differs.value) dialog.value = true
    else if (props.publicationId || publication.value) void copy()
    else if (props.accountId) emit('publish')
    else dialog.value = true
}
</script>

<template>
    <div class="share-link">
        <button class="quiet" :disabled="busy" @click="share">{{ t('shareLink') }}</button>
        <span v-if="message" class="share-link-status" role="status">{{ message }}</span>
        <Teleport to="body">
            <div v-if="dialog" class="modal-shade" @click.self="dialog = false">
                <section role="dialog" aria-modal="true" :aria-label="t('shareLink')" class="modal">
                    <h2>{{ t('shareLink') }}</h2>
                    <p v-if="failure" role="alert">{{ failure }}</p>
                    <p v-else-if="differs">{{ t('sharePublicDifferences') }}</p>
                    <p v-else-if="!publication && !publicationId">
                        {{ t('sharePublicationRequired') }}
                    </p>
                    <label v-if="manualUrl"
                        >{{ t('copyLinkManually') }}
                        <input
                            :value="manualUrl"
                            readonly
                            @focus="($event.target as HTMLInputElement).select()"
                        />
                    </label>
                    <div class="actions">
                        <button v-if="publication || publicationId" @click="copy">
                            {{ t('copyPublicLink') }}
                        </button>
                        <button v-if="failure" :disabled="busy" @click="retryLoad">
                            {{ t('retry') }}
                        </button>
                        <button v-if="accountId && !publicationId" @click="emit('publish')">
                            {{ t('shareSong') }}
                        </button>
                        <button @click="dialog = false">{{ t('close') }}</button>
                    </div>
                </section>
            </div>
        </Teleport>
    </div>
</template>
