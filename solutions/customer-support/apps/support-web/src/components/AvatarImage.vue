<script setup lang="ts">
/**
 * Authenticated contact avatar.
 *
 * contactId → authenticated fetch (cookie) → Blob → object URL → <img>.
 * Missing contactId or any fetch failure renders the first character of
 * fallbackText as a muted letter block, keeping the same placeholder look.
 * The object URL is revoked on unmount.
 * 拉取生命周期来自 useAuthenticatedBlob（工作台媒体组件共用）。
 */
import { computed, watch } from "vue";
import { useAuthenticatedBlob } from "../composables/use-authenticated-blob";

const props = withDefaults(
  defineProps<{
    contactId?: string;
    fallbackText: string;
    size?: number;
  }>(),
  { size: 30 },
);

const { status: state, objectUrl, load } = useAuthenticatedBlob({
  url: () =>
    props.contactId
      ? `/api/v1/contacts/${encodeURIComponent(props.contactId)}/avatar`
      : null,
});

const fallbackLetter = computed(() =>
  (props.fallbackText || "?").trim().slice(0, 1).toUpperCase(),
);

watch(() => props.contactId, () => void load());
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center overflow-hidden"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <img
      v-if="state === 'ready'"
      :src="objectUrl"
      :alt="fallbackText"
      class="block h-full w-full rounded-md object-cover"
    />
    <span
      v-else
      class="inline-flex h-full w-full items-center justify-center rounded-md bg-muted font-semibold text-muted-foreground"
      :style="{ fontSize: `${Math.max(10, Math.round(size * 0.42))}px` }"
      >{{ fallbackLetter }}</span
    >
  </span>
</template>
