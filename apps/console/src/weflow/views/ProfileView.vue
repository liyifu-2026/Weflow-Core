<script setup lang="ts">
/**
 * 信息名片：操作员编辑自己的对外形象（头像、显示名、专家标签）。
 * 标签与专家队列同源——转人工时系统按标签把相关任务定向推送。
 * 与移动端 Client1（app/profile.tsx）同一 Server2 契约，跨端一致。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { agentDisplayName } from "../labels";
import { useWeflowAuthStore, type AgentTag } from "../auth-store";
import DefaultAvatar from "../components/DefaultAvatar.vue";
import AvatarPickerDialog from "../components/AvatarPickerDialog.vue";

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
const nameError = ref("");
const tagError = ref("");
// 头像选择器：预设头像 / 自定义上传 / 恢复默认。
// 头像 URL 由服务端附带基于 updated_at 的版本号，变更后所有位置自动刷新。
const pickerOpen = ref(false);

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
  pickerOpen.value = true;
}
</script>

<template>
  <div class="wf-profile-drawer">
    <section class="wf-section-block">
      <div class="wf-profile-row">
        <button
          class="wf-profile-avatar"
          type="button"
          title="上传头像（预设 / 自定义）"
          @click="pickAvatar"
        >
          <img v-if="user?.avatarUrl" :src="user.avatarUrl" :alt="agentDisplayName(user)" />
          <DefaultAvatar v-else :name="user?.username" :size="52" />
        </button>
        <div class="wf-profile-copy">
          <strong>{{ agentDisplayName(user) }}</strong>
        </div>
      </div>
      <AvatarPickerDialog
        :open="pickerOpen"
        :current-preset-id="user?.avatarPreset ?? null"
        @close="pickerOpen = false"
      />
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
      <div v-if="nameError" class="wf-error" role="alert">{{ nameError }}</div>
    </section>

    <!-- 擅长领域（专家标签）暂隐藏：产品决策待定，先不做；
         相关 script 逻辑保留以备启用。 -->
    <!--
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
      <div v-if="tagError" class="wf-error" role="alert">{{ tagError }}</div>
    </section>
    -->

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
  background: var(--wf-surface-soft);
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
  color: var(--wf-primary);
  font-weight: 600;
}
.wf-tag-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.wf-chip {
  border: 1px solid var(--wf-border-strong);
  background: transparent;
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  color: inherit;
}
.wf-chip.active {
  background: var(--wf-primary-soft);
  border-color: var(--wf-primary);
  color: var(--wf-primary);
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
