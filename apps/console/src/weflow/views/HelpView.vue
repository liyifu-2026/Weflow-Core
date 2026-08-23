<script setup lang="ts">
import { computed } from "vue";
import technicalDocumentation from "@docs/technical-documentation.md?raw";
import { renderMiniMarkdown } from "../markdown";
import PageHeader from "../components/PageHeader.vue";

const rendered = computed(() => renderMiniMarkdown(technicalDocumentation));
</script>

<template>
  <div class="wf-page docs-page">
    <PageHeader title="技术文档" />

    <div class="docs-content" v-html="rendered"></div>
  </div>
</template>

<style scoped>
.docs-page .wf-page-head {
  margin-bottom: 8px;
}
.docs-page .wf-page-head p {
  color: var(--wf-text-secondary);
  font-size: 13px;
}
.docs-page code {
  background: var(--wf-surface-inset);
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 12px;
}
.docs-content {
  color: var(--wf-text);
  line-height: 1.75;
  font-size: 14px;
}
.docs-content h1,
.docs-content h2,
.docs-content h3,
.docs-content h4,
.docs-content h5,
.docs-content h6 {
  margin: 28px 0 10px;
  line-height: 1.35;
  color: var(--wf-text);
  scroll-margin-top: 16px;
}
.docs-content h1 {
  font-size: 24px;
  border-bottom: 1px solid var(--wf-border);
  padding-bottom: 8px;
}
.docs-content h2 {
  font-size: 20px;
  border-bottom: 1px solid var(--wf-border);
  padding-bottom: 6px;
}
.docs-content h3 {
  font-size: 17px;
}
.docs-content h4 {
  font-size: 15px;
}
.docs-content h5,
.docs-content h6 {
  font-size: 14px;
}
.docs-content p {
  margin: 10px 0;
}
.docs-content ul,
.docs-content ol {
  margin: 10px 0;
  padding-left: 24px;
}
.docs-content li {
  margin: 5px 0;
}
.docs-content li input[type="checkbox"] {
  margin-right: 6px;
}
.docs-content blockquote {
  margin: 14px 0;
  padding: 10px 14px;
  border-left: 3px solid var(--wf-primary);
  background: var(--wf-surface-soft);
  border-radius: 0 var(--wf-radius-control) var(--wf-radius-control) 0;
  color: var(--wf-text-secondary);
}
.docs-content blockquote p {
  margin: 4px 0;
}
.docs-content pre {
  margin: 12px 0;
  padding: 12px 14px;
  background: var(--wf-surface-inset);
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-control);
  overflow-x: auto;
  line-height: 1.55;
}
.docs-content pre code {
  padding: 0;
  background: transparent;
  font-size: 12.5px;
}
.docs-content table {
  width: 100%;
  margin: 14px 0;
  border-collapse: collapse;
  font-size: 13px;
}
.docs-content th,
.docs-content td {
  border: 1px solid var(--wf-border);
  padding: 7px 10px;
  text-align: left;
  vertical-align: top;
}
.docs-content th {
  background: var(--wf-surface-soft);
  font-weight: 650;
}
.docs-content tr:nth-child(even) td {
  background: var(--wf-surface-soft);
}
.docs-content hr {
  border: none;
  border-top: 1px solid var(--wf-border);
  margin: 24px 0;
}
.docs-content a {
  color: var(--wf-primary);
  text-decoration: none;
}
.docs-content a:hover {
  text-decoration: underline;
}
</style>
