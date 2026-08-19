<script setup lang="ts">
/**
 * 信息名片：客服编辑自己的对外形象（头像、显示名、专家标签）。
 * 标签与专家队列同源——转人工时系统按标签把相关任务定向推送。
 * 与移动端 Client1（app/profile.tsx）同一 Server2 契约，跨端一致。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { agentDisplayName } from "../labels";
import { useWeflowAuthStore, type AgentTag } from "../auth-store";

const auth = useWeflowAuthStore();
const router = useRouter();

/** 标签上限（与 Server2 词表一致） */
const MAX_TAGS = 7;

const vocabulary = ref<AgentTag[]>([]);
const vocabularyError = ref(false);
const nameDraft = ref("");
const selectedTags = ref<string[]>([]);
const savedFeedback = ref("");
const savingName = ref(false);
const savingTags = ref(false);
const uploading = ref(false);
const avatarError = ref("");
const nameError = ref("");
const tagError = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

const user = computed(() => auth.user);
const nameDirty = computed(
  () => nameDraft.value.trim() !== (user.value?.displayName ?? ""),
);
const tagsDirty = computed(
  () =>
    JSON.stringify(selectedTags.value) !== JSON.stringify(user.value?.tags ?? []),
);
const fallbackLetter = computed(() =>
  agentDisplayName(user.value).trim().slice(0, 1).toUpperCase() || "值",
);

onMounted(async () => {
  await auth.ensureSession();
  if (!user.value) return;
  nameDraft.value = user.value.displayName ?? "";
  selectedTags.value = user.value.tags ?? [];
  try {
    vocabulary.value = await auth.fetchTagVocabulary();
    vocabularyError.value = false;
  } catch {
    vocabularyError.value = true;
  }
});

function flashSaved(text: string) {
  savedFeedback.value = text;
  setTimeout(() => (savedFeedback.value = ""), 1800);
}

async function saveDisplayName() {
  if (savingName.value) return;
  const trimmed = nameDraft.value.trim();
  if (trimmed === (user.value?.displayName ?? "")) return;
  savingName.value = true;
  nameError.value = "";
  try {
    // 清空输入 = 清除显示名（回落为登录账号）
    await auth.updateProfile({
      displayName: trimmed.length > 0 ? trimmed : null,
    });
    nameDraft.value = auth.user?.displayName ?? "";
    flashSaved("资料已保存");
  } catch (reason) {
    nameError.value = reason instanceof Error ? reason.message : "保存失败";
  } finally {
    savingName.value = false;
  }
}

async function saveTags() {
  if (savingTags.value) return;
  savingTags.value = true;
  tagError.value = "";
  try {
    await auth.updateProfile({ tags: selectedTags.value });
    selectedTags.value = auth.user?.tags ?? [];
    flashSaved("标签已保存");
  } catch (reason) {
    tagError.value = reason instanceof Error ? reason.message : "保存失败";
  } finally {
    savingTags.value = false;
  }
}

function toggleTag(key: string) {
  if (selectedTags.value.includes(key)) {
    selectedTags.value = selectedTags.value.filter((tag) => tag !== key);
    return;
  }
  if (selectedTags.value.length >= MAX_TAGS) {
    tagError.value = "最多选择 7 个标签，请先取消一个已选标签。";
    return;
  }
  selectedTags.value = [...selectedTags.value, key];
}

function pickAvatar() {
  fileInput.value?.click();
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploading.value = true;
  avatarError.value = "";
  try {
    await auth.uploadAvatar(file);
    flashSaved("头像已更新");
  } catch (reason) {
    avatarError.value = reason instanceof Error ? reason.message : "上传失败";
  } finally {
    uploading.value = false;
    input.value = "";
  }
}
</script>

<template>
  <div class="wf-page wf-page-narrow">
    <header class="wf-page-head">
      <h1>信息名片</h1>
      <p>头像与显示名会展示给客户和同事；标签用于转人工时定向推送。</p>
    </header>

    <section class="wf-section-block">
      <div class="wf-profile-row">
        <button
          class="wf-profile-avatar"
          type="button"
          :title="uploading ? '上传中' : '更换头像'"
          :disabled="uploading"
          @click="pickAvatar"
        >
          <img v-if="user?.avatarUrl" :src="user.avatarUrl" :alt="agentDisplayName(user)" />
          <span v-else class="wf-avatar">{{ fallbackLetter }}</span>
          <span v-if="uploading" class="wf-spinner"></span>
        </button>
        <div class="wf-profile-copy">
          <strong>{{ agentDisplayName(user) }}</strong>
          <span class="wf-muted">点击头像更换 · 展示给客户与同事</span>
        </div>
        <input
          ref="fileInput"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          class="wf-file-hidden"
          @change="onFileChange"
        />
      </div>
      <div v-if="avatarError" class="wf-error">{{ avatarError }}</div>
    </section>

    <section class="wf-section-block">
      <div class="wf-section-heading"><h2>显示名</h2></div>
      <div class="wf-field">
        <input
          v-model="nameDraft"
          class="wf-input"
          maxlength="24"
          :placeholder="user?.username ?? '填写显示名'"
        />
      </div>
      <div class="wf-profile-foot">
        <span class="wf-muted">
          登录账号 {{ user?.username ?? "" }} 不可修改
          <span v-if="savedFeedback" class="wf-profile-saved">　{{ savedFeedback }}</span>
        </span>
        <button
          class="wf-button primary"
          :disabled="!nameDirty || savingName"
          @click="saveDisplayName"
        >
          <span v-if="savingName" class="wf-spinner"></span>{{ savingName ? "保存中" : "保存" }}
        </button>
      </div>
      <div v-if="nameError" class="wf-error">{{ nameError }}</div>
    </section>

    <section class="wf-section-block">
      <div class="wf-section-heading"><h2>擅长领域</h2></div>
      <p v-if="vocabularyError" class="wf-muted">标签加载失败，请刷新页面重试。</p>
      <p v-else-if="!vocabulary.length" class="wf-muted">加载中…</p>
      <div v-else class="wf-tag-chips">
        <button
          v-for="tag in vocabulary"
          :key="tag.key"
          type="button"
          class="wf-chip"
          :class="{ active: selectedTags.includes(tag.key) }"
          @click="toggleTag(tag.key)"
        >
          {{ tag.displayName }}
        </button>
      </div>
      <div class="wf-profile-foot">
        <span class="wf-muted">
          转人工时，系统会按标签把相关任务定向推送给你
          <span v-if="savedFeedback" class="wf-profile-saved">　{{ savedFeedback }}</span>
        </span>
        <button
          class="wf-button primary"
          :disabled="!tagsDirty || savingTags"
          @click="saveTags"
        >
          <span v-if="savingTags" class="wf-spinner"></span>{{ savingTags ? "保存中" : "保存" }}
        </button>
      </div>
      <div v-if="tagError" class="wf-error">{{ tagError }}</div>
    </section>

    <section class="wf-section-block">
      <div class="wf-section-heading"><h2>账号</h2></div>
      <button class="wf-row-button" @click="router.push('/change-password')">
        <span>修改密码</span>
        <span class="wf-muted">→</span>
      </button>
    </section>
  </div>
</template>

<style scoped>
.wf-profile-row {
  display: flex;
  align-items: center;
  gap: 14px;
}
.wf-profile-avatar {
  position: relative;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: none;
  padding: 0;
  overflow: hidden;
  cursor: pointer;
  background: var(--wf-subtle, #f1f3f5);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.wf-profile-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.wf-profile-avatar .wf-spinner {
  position: absolute;
  inset: 0;
  margin: auto;
}
.wf-profile-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wf-file-hidden {
  display: none;
}
.wf-profile-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}
.wf-profile-saved {
  color: var(--wf-green, #1a9e6c);
  font-weight: 600;
}
.wf-tag-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.wf-chip {
  border: 1px solid var(--wf-rule, #e2e6ea);
  background: transparent;
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  color: inherit;
}
.wf-chip.active {
  background: var(--wf-blue-wash, #eaf3ff);
  border-color: var(--wf-blue, #2f6fed);
  color: var(--wf-blue, #2f6fed);
}
.wf-row-button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px 0;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  color: inherit;
}
</style>
