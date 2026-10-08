<script setup lang="ts">
/**
 * The document tabs.
 *
 * One row, one tab per open project, and the same controls Photoshop puts on them: click to
 * switch, the dot means unsaved, the cross closes. The tab's name comes from the record rather
 * than from whatever is active, so a background tab still reads correctly.
 */
import { useI18n } from 'vue-i18n'

import { activateDocument, closeDocument, documentTabs, newCanvasPrompt } from '../state/session'

const { t } = useI18n()
</script>

<template>
  <div class="tabs">
    <button
      v-for="tab in documentTabs"
      :key="tab.id"
      class="tab"
      :class="{ 'tab--on': tab.active }"
      :title="tab.name"
      @click="activateDocument(tab.id)"
    >
      <span class="tab__icon">▣</span>
      <span class="tab__name">{{ tab.name }}</span>
      <span v-if="tab.dirty" class="tab__dot" :title="t('tab.unsaved')">•</span>
      <span
        class="tab__close"
        role="button"
        :title="t('tab.close')"
        @click.stop="closeDocument(tab.id)"
      >
        ✕
      </span>
    </button>
    <button class="tab tab--new" :title="t('tab.newCanvas')" @click="newCanvasPrompt.open = true">
      +
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 26px;
  padding: 3px 4px 0;
  background: var(--ps-frame-dark);
  overflow-x: auto;
  overflow-y: hidden;
}

.tab {
  display: flex;
  gap: 6px;
  align-items: center;
  flex: none;
  max-width: 200px;
  padding: 3px 8px;
  border: 0;
  border-radius: 3px 3px 0 0;
  background: var(--ps-panel-tab);
  color: var(--ps-text-dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.tab:hover {
  background: var(--ps-control);
}

.tab--on {
  background: var(--ps-panel);
  color: var(--ps-text-strong);
}

.tab--new {
  padding: 3px 9px;
  color: var(--ps-text-dim);
}

.tab__icon {
  color: #9aa0a8;
  font-size: 10px;
}

.tab__name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tab__dot {
  color: #e0b060;
}

.tab__close {
  padding: 0 1px;
  color: var(--ps-text-faint);
  font-size: 10px;
}

.tab__close:hover {
  color: #ffffff;
}
</style>
