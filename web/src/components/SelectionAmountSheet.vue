<script setup lang="ts">
/**
 * The amount prompt for Feather, Expand and Contract.
 *
 * One sheet for all three because they differ only in what the number means, and three near-identical
 * dialogs would be three places to fix the same bug.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  contractSelection,
  expandSelection,
  featherSelection,
  selectionAmountPrompt,
  useSession,
} from '../state/session'

const { t } = useI18n()
const { selection } = useSession()

const amount = ref('5')
const field = ref<HTMLInputElement | null>(null)

const title = computed(() => t(`select.${selectionAmountPrompt.mode}`))
const note = computed(() => t(`select.${selectionAmountPrompt.mode}Note`))

watch(
  () => selectionAmountPrompt.open,
  async (open) => {
    if (!open) return
    amount.value = String(selectionAmountPrompt.amount)
    await nextTick()
    field.value?.select()
  },
)

function close(): void {
  selectionAmountPrompt.open = false
}

function apply(): void {
  const value = Number(amount.value)
  if (!Number.isFinite(value) || value <= 0) return
  const mode = selectionAmountPrompt.mode
  selectionAmountPrompt.amount = value
  close()
  if (mode === 'feather') featherSelection(value)
  else if (mode === 'expand') expandSelection(value)
  else contractSelection(value)
}
</script>

<template>
  <div v-if="selectionAmountPrompt.open" class="scrim" @click.self="close">
    <div class="sheet" role="dialog">
      <h2 class="sheet__title">{{ title }}</h2>
      <label class="sheet__field">
        <span>{{ t('select.amount') }}</span>
        <input ref="field" v-model="amount" type="number" min="0.1" step="1" @keydown.enter="apply" />
      </label>
      <p class="sheet__hint">{{ note }}</p>
      <p v-if="!selection" class="sheet__problem">{{ t('select.nothingSelected') }}</p>
      <div class="sheet__actions">
        <button class="sheet__button" @click="close">{{ t('common.cancel') }}</button>
        <button class="sheet__button sheet__button--primary" @click="apply">{{ t('common.ok') }}</button>
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
  z-index: 12;
}

.sheet {
  width: 300px;
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

.sheet__field {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #7d838d;
}

.sheet__field input {
  flex: 1;
  min-width: 0;
  padding: 5px 7px;
  border: 1px solid #3c3f46;
  border-radius: 4px;
  background: #1c1d21;
  color: #d6d9df;
  font: inherit;
  font-size: 13px;
}

.sheet__hint,
.sheet__problem {
  margin: 10px 0 0;
  font-size: 11px;
  color: #6f7580;
}

.sheet__problem {
  color: #e08a6a;
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
