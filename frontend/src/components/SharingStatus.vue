<script setup lang="ts">
import type { SharingEntry } from '../community/model'
import { t } from '../i18n/en'
defineProps<{ entry?: SharingEntry; badgeOnly?: boolean; detailsOnly?: boolean }>()
</script>

<template>
    <span v-if="entry && !detailsOnly" class="sharing-badge">{{
        t(
            !entry.publication.published
                ? 'sharingWithdrawn'
                : entry.publication.hidden
                  ? 'sharingHidden'
                  : 'sharedBadge',
        )
    }}</span>
    <p
        v-if="
            entry &&
            !badgeOnly &&
            (entry.blocked ||
                entry.setting ||
                entry.settingInFlight ||
                entry.update ||
                entry.inFlight)
        "
        class="sharing-status"
        :class="{ error: entry.blocked }"
        role="status"
    >
        <span>{{ entry.blocked ? t('sharingBlocked') : t('sharingPending') }}</span>
        <span v-if="entry.blocked">{{ entry.blocked }}</span>
    </p>
</template>
