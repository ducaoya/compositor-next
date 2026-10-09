<script setup lang="ts">
/**
 * The offer to recover work the last run never saved.
 *
 * A snapshot exists only while a document has changes that never reached its own file, so anything
 * listed here is work that was lost to a crash or to a window closed with unsaved changes. Nothing
 * is recovered automatically: recovering replaces what is on screen, and only the person looking at
 * the list knows whether that work is wanted back.
 */
import { useI18n } from 'vue-i18n'

import { recoveryLabel, type RecoveryEntry } from '../model/recovery'
import {
  discardAllSnapshots,
  discardSnapshotEntry,
  dismissRecovery,
  recoverSnapshot,
  recoveryPrompt,
} from '../state/session'

const { t, locale } = useI18n()

/** A snapshot's time, in the reader's own language and conventions. */
function savedAt(entry: RecoveryEntry): string {
  return new Date(entry.savedAt).toLocaleString(locale.value)
}

/** Where the work came from, or the plain fact that it never had a home. */
function origin(entry: RecoveryEntry): string {
  return entry.origin ? t('recovery.from', { path: entry.origin }) : t('recovery.neverSaved')
}
</script>

<template>
  <div v-if="recoveryPrompt.open" class="scrim" @click.self="dismissRecovery" @keydown.esc="dismissRecovery">
    <div class="sheet" role="dialog" aria-label="Recover unsaved work">
      <h2 class="sheet__title">{{ t('recovery.title') }}</h2>
      <p class="sheet__hint">{{ t('recovery.body') }}</p>

      <ul class="list">
        <li v-for="entry in recoveryPrompt.entries" :key="entry.target" class="list__row">
          <div class="list__text">
            <span class="list__name">{{ recoveryLabel(entry) }}</span>
            <span class="list__meta">{{ origin(entry) }}</span>
            <span class="list__meta">{{ t('recovery.savedAt', { when: savedAt(entry) }) }}</span>
          </div>
          <div class="list__actions">
            <button class="sheet__button" @click="void discardSnapshotEntry(entry)">
              {{ t('recovery.discard') }}
            </button>
            <button class="sheet__button sheet__button--primary" @click="void recoverSnapshot(entry)">
              {{ t('recovery.recover') }}
            </button>
          </div>
        </li>
      </ul>

      <div class="sheet__actions">
        <button class="sheet__button" @click="void discardAllSnapshots()">
          {{ t('recovery.discardAll') }}
        </button>
        <button class="sheet__button" @click="dismissRecovery()">{{ t('recovery.notNow') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 45%);
  z-index: 10;
}

.sheet {
  width: 460px;
  max-width: calc(100vw - 32px);
  padding: 16px;
  border: 1px solid #3c3f46;
  border-radius: 8px;
  background: #2b2c31;
  box-shadow: 0 12px 40px rgb(0 0 0 / 45%);
}

.sheet__title {
  margin: 0 0 14px;
  font-size: 13px;
  font-weight: 600;
  color: #e6e8ec;
}

.sheet__hint {
  margin: 0 0 10px;
  font-size: 11px;
  color: #8b9099;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.list__row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid #3c3f46;
  border-radius: 4px;
  background: #1f2024;
}

.list__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.list__name {
  font-size: 12px;
  color: #e6e8ec;
}

.list__meta {
  font-size: 10px;
  color: #7d838d;
  overflow-wrap: anywhere;
}

.list__actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}

.sheet__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 16px;
}

.sheet__button {
  padding: 5px 12px;
  border: 1px solid #3c3f46;
  border-radius: 4px;
  background: #33353b;
  color: #d6d9df;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sheet__button:hover {
  background: #3d4047;
}

.sheet__button--primary {
  background: #3f6ea8;
  border-color: #4b7fbe;
}

.sheet__button--primary:hover {
  background: #4879b6;
}
</style>
