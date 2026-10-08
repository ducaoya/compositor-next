<script setup lang="ts">
/**
 * One sheet for Canvas Size and Image Size.
 *
 * They ask for the same two numbers and differ only in what happens next: Canvas Size moves
 * everything and leaves the pixels alone, Image Size resamples them.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { dimensionPrompt, resizeCanvas, resizeImage, useSession } from '../state/session'

const { t } = useI18n()
const { limits } = useSession()

const width = ref('0')
const height = ref('0')
const problem = ref<string | null>(null)
const field = ref<HTMLInputElement | null>(null)

const title = computed(() => t(dimensionPrompt.mode === 'canvas' ? 'size.canvasTitle' : 'size.imageTitle'))
const note = computed(() => t(dimensionPrompt.mode === 'canvas' ? 'size.canvasNote' : 'size.imageNote'))
const isImage = computed(() => dimensionPrompt.mode === 'image')

watch(
  () => dimensionPrompt.open,
  async (open) => {
    if (!open) return
    width.value = String(dimensionPrompt.width)
    height.value = String(dimensionPrompt.height)
    problem.value = null
    await nextTick()
    field.value?.select()
  },
)

function close(): void {
  dimensionPrompt.open = false
}

function apply(): void {
  const w = Math.round(Number(width.value))
  const h = Math.round(Number(height.value))
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    problem.value = t('size.invalid')
    return
  }
  if (w > limits.value.maxSide || h > limits.value.maxSide) {
    problem.value = t('size.tooLarge', { maxSide: limits.value.maxSide.toLocaleString() })
    return
  }
  close()
  if (isImage.value) resizeImage(w, h)
  else resizeCanvas(w, h, dimensionPrompt.anchor)
}
</script>

<template>
  <div v-if="dimensionPrompt.open" class="scrim" @click.self="close">
    <div class="sheet" role="dialog">
      <h2 class="sheet__title">{{ title }}</h2>
      <div class="sheet__fields">
        <label class="sheet__field">
          <span>{{ t('newCanvas.width') }}</span>
          <input ref="field" v-model="width" type="number" min="1" @keydown.enter="apply" />
        </label>
        <span class="sheet__times">×</span>
        <label class="sheet__field">
          <span>{{ t('newCanvas.height') }}</span>
          <input v-model="height" type="number" min="1" @keydown.enter="apply" />
        </label>
      </div>
      <label v-if="!isImage" class="sheet__field sheet__field--anchor">
        <span>{{ t('size.anchor') }}</span>
        <select v-model="dimensionPrompt.anchor">
          <option value="center">{{ t('size.anchorCenter') }}</option>
          <option value="centerTop">{{ t('size.anchorCenterTop') }}</option>
          <option value="topLeft">{{ t('size.anchorTopLeft') }}</option>
        </select>
      </label>
      <p class="sheet__hint">{{ note }}</p>
      <p v-if="problem" class="sheet__problem">{{ problem }}</p>
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
  width: 320px;
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

.sheet__fields {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

.sheet__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #7d838d;
}

.sheet__field--anchor {
  margin-top: 10px;
  flex: none;
}

.sheet__field input,
.sheet__field select {
  padding: 5px 7px;
  border: 1px solid #3c3f46;
  border-radius: 4px;
  background: #1c1d21;
  color: #d6d9df;
  font: inherit;
  font-size: 13px;
}

.sheet__times {
  padding-bottom: 6px;
  color: #7d838d;
}

.sheet__hint {
  margin: 10px 0 0;
  font-size: 11px;
  color: #6f7580;
}

.sheet__problem {
  margin: 8px 0 0;
  font-size: 11px;
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
