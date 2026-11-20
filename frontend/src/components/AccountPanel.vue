<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
    accountGet,
    accountRequest,
    AccountError,
    type Account,
    type AccountSession,
} from '../accounts/client'
import type { Publication } from '../community/model'
import { t } from '../i18n/en'

const props = defineProps<{ session: AccountSession | null }>()
const emit = defineEmits<{
    changed: [user: Account | null, message?: string]
    refresh: []
    close: []
    deleted: [user: Account, erase: boolean]
}>()
const deletingAccount = ref(false),
    deleteConfirmation = ref(''),
    keepLocal = ref(true)
const publicationsToKeep = ref<string[]>([]),
    ownPublications = ref<Publication[]>([])
let deletionRevision = 0,
    deletionOwnerId: string | undefined
async function prepareDeletion() {
    if (busy.value || !props.session?.user) return
    if (deletingAccount.value) {
        deletingAccount.value = false
        deletionOwnerId = undefined
        return
    }
    const ownerId = props.session.user.id,
        revision = ++deletionRevision
    busy.value = true
    error.value = ''
    try {
        let page = 1,
            more = true
        const items: Publication[] = []
        while (more) {
            const data = await accountGet<{ publications: Publication[]; more: boolean }>(
                `/api/community/mine?page=${page++}`,
            )
            if (revision !== deletionRevision || props.session?.user?.id !== ownerId) return
            items.push(...data.publications)
            more = data.more
        }
        ownPublications.value = items
        publicationsToKeep.value = []
        deletionOwnerId = ownerId
        deletingAccount.value = true
    } catch (e) {
        if (revision === deletionRevision)
            error.value = e instanceof Error ? e.message : t('accountNetworkError')
    } finally {
        busy.value = false
    }
}
async function deleteAccount() {
    const user = props.session?.user
    if (!user || busy.value || user.id !== deletionOwnerId) return
    const erase = !keepLocal.value
    busy.value = true
    error.value = ''
    try {
        await accountRequest('/api/account/delete', {
            accountId: user.id,
            confirmation: deleteConfirmation.value,
            password: password.value,
            keepPublications: publicationsToKeep.value,
        })
        password.value = ''
        emit('deleted', user, erase)
    } catch (e) {
        error.value = e instanceof AccountError ? e.message : t('accountNetworkError')
        if (e instanceof AccountError && e.status === 401) emit('refresh')
    } finally {
        busy.value = false
    }
}
const hash = new URLSearchParams(location.hash.split('?')[1] ?? '')
const mode = ref<'login' | 'register' | 'forgot' | 'reset'>(
    location.hash.startsWith('#reset-password') ? 'reset' : 'login',
)
const pendingGoogle = computed(() => props.session?.googlePending && mode.value !== 'reset')
const email = ref(hash.get('email') ?? '')
const remember = ref(false)
const pseudonym = ref(''),
    password = ref(''),
    confirmation = ref('')
let resetToken = hash.get('token') ?? ''
const error = ref(''),
    message = ref(hash.has('verified') ? t('emailVerified') : ''),
    busy = ref(false)
watch(
    () => props.session?.user?.id,
    () => {
        // Confirmation and publication choices belong to one account, including late responses.
        deletionRevision++
        deletionOwnerId = undefined
        deletingAccount.value = false
        deleteConfirmation.value = ''
        publicationsToKeep.value = []
        ownPublications.value = []
        password.value = ''
        keepLocal.value = true
    },
    { flush: 'sync' },
)
const googleErrors: Record<string, string> = {
    google_failed: t('googleFailed'),
    google_existing: t('googleExisting'),
    google_linked_elsewhere: t('googleLinkedElsewhere'),
}
if (hash.has('error')) error.value = googleErrors[hash.get('error')!] ?? t('googleFailed')
// Reset tokens remain in memory, never in history, storage, caches or server URLs.
history.replaceState(null, '', location.pathname + location.search)

async function submit() {
    if (busy.value) return
    busy.value = true
    error.value = ''
    message.value = ''
    try {
        const data = pendingGoogle.value
            ? await accountRequest('/api/google/complete', { pseudonym: pseudonym.value })
            : await accountRequest(
                  `/api/${{ login: 'login', register: 'register', forgot: 'forgot-password', reset: 'reset-password' }[mode.value]}`,
                  {
                      email: email.value,
                      pseudonym: pseudonym.value,
                      password: password.value,
                      password_confirmation: confirmation.value,
                      token: resetToken,
                      remember: remember.value,
                  },
              )
        password.value = ''
        confirmation.value = ''
        if (data.user) emit('changed', data.user, data.message)
        if (data.message) message.value = data.message
        if (mode.value === 'reset') {
            resetToken = ''
            mode.value = 'login'
            emit('refresh')
        }
    } catch (e) {
        error.value = e instanceof AccountError ? e.message : t('accountNetworkError')
        if (e instanceof AccountError && e.status === 401) emit('refresh')
    } finally {
        busy.value = false
    }
}
async function action(path: string) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    message.value = ''
    try {
        const data = await accountRequest(path, { password: password.value })
        password.value = ''
        if (path === '/api/logout') emit('changed', null)
        if (path === '/api/google/cancel') {
            changeMode('login')
            emit('refresh')
        }
        if (data.message) message.value = data.message
        if (data.redirect === '/auth/google/redirect') location.assign(data.redirect)
    } catch (e) {
        error.value = e instanceof AccountError ? e.message : t('accountNetworkError')
        if (e instanceof AccountError && e.status === 401) emit('refresh')
    } finally {
        busy.value = false
    }
}
function changeMode(value: typeof mode.value) {
    mode.value = value
    error.value = ''
    message.value = ''
    password.value = ''
    confirmation.value = ''
}
</script>

<template>
    <main class="screen account-screen">
        <div class="screen-heading">
            <h1>{{ t('account') }}</h1>
            <button @click="emit('close')">{{ t('back') }}</button>
        </div>
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <p v-if="message" role="status" class="notice">{{ message }}</p>
        <template v-if="session?.user && mode !== 'reset'">
            <h2>{{ session.user.pseudonym }}</h2>
            <span v-if="session.user.supporter" class="supporter-badge"
                >♡ {{ t('supporter') }}</span
            >
            <p>{{ session.user.email }}</p>
            <p class="muted">
                {{ session.user.verified ? t('emailVerified') : t('emailNotVerified') }}
            </p>
            <button
                v-if="!session.user.verified && session.emailEnabled"
                :disabled="busy"
                @click="action('/api/email/verification-notification')"
            >
                {{ t('resendVerification') }}
            </button>
            <p v-if="session.user.googleLinked">{{ t('googleLinked') }}</p>
            <form
                v-else-if="session.googleEnabled && session.user.hasPassword"
                class="account-form"
                @submit.prevent="action('/api/google/link')"
            >
                <label
                    >{{ t('currentPassword')
                    }}<input
                        v-model="password"
                        type="password"
                        autocomplete="current-password"
                        required
                        :disabled="busy"
                /></label>
                <button :disabled="busy">{{ t('linkGoogle') }}</button>
            </form>
            <p class="local-note">{{ t('accountLocalNotice') }}</p>
            <button :disabled="busy" @click="action('/api/logout')">{{ t('signOut') }}</button>
            <button class="quiet danger" :disabled="busy" @click="prepareDeletion">
                {{ t('deleteAccount') }}
            </button>
            <form
                v-if="deletingAccount"
                class="account-form notice"
                @submit.prevent="deleteAccount"
            >
                <h2>{{ t('deleteAccount') }}</h2>
                <p>{{ t('deleteAccountHint') }}</p>
                <label
                    >{{ t('confirmPseudonym')
                    }}<input
                        v-model="deleteConfirmation"
                        required
                        :disabled="busy"
                        autocomplete="off"
                /></label>
                <label v-if="session.user.hasPassword"
                    >{{ t('currentPassword')
                    }}<input
                        v-model="password"
                        type="password"
                        required
                        autocomplete="current-password"
                        :disabled="busy"
                /></label>
                <p v-else>{{ t('deleteGoogleHint') }}</p>
                <fieldset v-if="ownPublications.length">
                    <legend>{{ t('keepPublications') }}</legend>
                    <p>{{ t('keepPublicationsHint') }}</p>
                    <label v-for="item in ownPublications" :key="item.id" class="check-row"
                        ><input
                            v-model="publicationsToKeep"
                            type="checkbox"
                            :value="item.id"
                            :disabled="busy"
                        />{{ item.content.title }} · V.{{ item.revision }}</label
                    >
                </fieldset>
                <label class="checkbox"
                    ><input v-model="keepLocal" type="checkbox" :disabled="busy" />{{
                        t('keepLocalSongs')
                    }}</label
                >
                <button
                    class="danger"
                    :disabled="busy || deleteConfirmation !== session.user.pseudonym"
                >
                    {{ t('confirmDeleteAccount') }}
                </button>
            </form>
        </template>
        <template v-else-if="session?.enabled">
            <h2>
                {{
                    pendingGoogle
                        ? t('choosePseudonym')
                        : mode === 'register'
                          ? t('createAccount')
                          : mode === 'forgot'
                            ? t('forgotPassword')
                            : mode === 'reset'
                              ? t('resetPassword')
                              : t('signIn')
                }}
            </h2>
            <form class="account-form" @submit.prevent="submit">
                <label v-if="mode === 'register' || pendingGoogle"
                    >{{ t('pseudonym')
                    }}<input
                        v-model="pseudonym"
                        :aria-label="t('pseudonym')"
                        aria-describedby="pseudonym-hint"
                        autocomplete="nickname"
                        required
                        minlength="3"
                        maxlength="30"
                        pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]*"
                        :disabled="busy"
                    /><small id="pseudonym-hint">{{ t('pseudonymHint') }}</small></label
                >
                <label v-if="!pendingGoogle"
                    >{{ t('email')
                    }}<input
                        v-model="email"
                        type="email"
                        autocomplete="email"
                        required
                        maxlength="254"
                        :disabled="busy"
                /></label>
                <label v-if="mode !== 'forgot' && !pendingGoogle"
                    >{{ t('password')
                    }}<input
                        v-model="password"
                        type="password"
                        :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
                        required
                        :minlength="mode === 'login' ? 1 : 12"
                        maxlength="128"
                        :disabled="busy"
                /></label>
                <label v-if="(mode === 'register' || mode === 'reset') && !pendingGoogle"
                    >{{ t('confirmPassword')
                    }}<input
                        v-model="confirmation"
                        type="password"
                        autocomplete="new-password"
                        required
                        minlength="12"
                        maxlength="128"
                        :disabled="busy"
                /></label>
                <label v-if="mode === 'login' && !pendingGoogle" class="check">
                    <input v-model="remember" type="checkbox" :disabled="busy" />
                    {{ t('rememberMe') }}
                </label>
                <button class="primary" :disabled="busy">
                    {{
                        busy
                            ? t('saving')
                            : pendingGoogle || mode === 'register'
                              ? t('createAccount')
                              : mode === 'forgot'
                                ? t('sendResetLink')
                                : mode === 'reset'
                                  ? t('resetPassword')
                                  : t('signIn')
                    }}
                </button>
            </form>
            <button v-if="pendingGoogle" :disabled="busy" @click="action('/api/google/cancel')">
                {{ t('cancel') }}
            </button>
            <template v-if="!pendingGoogle">
                <a
                    v-if="session.googleEnabled && mode === 'login'"
                    class="account-google"
                    :href="`/auth/google/redirect?remember=${remember ? 1 : 0}`"
                    >{{ t('continueGoogle') }}</a
                >
                <div class="actions">
                    <button
                        v-if="mode !== 'login'"
                        class="quiet"
                        :disabled="busy"
                        @click="changeMode('login')"
                    >
                        {{ t('signIn') }}
                    </button>
                    <button
                        v-if="mode === 'login'"
                        class="quiet"
                        :disabled="busy"
                        @click="changeMode('register')"
                    >
                        {{ t('createAccount') }}
                    </button>
                    <button
                        v-if="mode === 'login' && session.emailEnabled"
                        class="quiet"
                        :disabled="busy"
                        @click="changeMode('forgot')"
                    >
                        {{ t('forgotPassword') }}
                    </button>
                </div>
            </template>
            <p class="local-note">{{ t('accountLocalNotice') }}</p>
        </template>
        <p v-else>
            {{ t('accountsUnavailable') }}
            <button @click="emit('refresh')">{{ t('retry') }}</button>
        </p>
    </main>
</template>
