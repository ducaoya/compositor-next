<script setup lang="ts">
/**
 * The status bar, in Photoshop's shape: the zoom level and a document summary on the left, and the
 * last thing the app had to say on the right.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { TOOLS_BY_ID } from '../model/tools'
import { useSession } from '../state/session'

const { t } = useI18n()
const { manifest, view, message, busy, limits, canGPU, selection, tool } = useSession()

const zoom = computed(() => t('status.zoom', { percent: (view.zoom * 100).toFixed(view.zoom < 0.1 ? 1 : 0) }))

const summary = computed(() => {
  const current = manifest.value
  if (!current) return t('status.noDocument')
  return t('status.document', {
    width: current.width,
    height: current.height,
    megapixels: ((current.width * current.height) / 1_000_000).toFixed(1),
    version: current.version,
  })
})

const selectionText = computed(() => {
  const current = selection.value
  if (!current) return t('status.noSelection')
  const shape = t(current.kind === 'ellipse' ? 'status.ellipse' : 'status.rectangle')
  const described = t('status.selection', {
    kind: shape,
    width: Math.round(current.width),
    height: Math.round(current.height),
  })
  return current.inverted ? t('status.inverseOf', { shape: described }) : described
})

const toolName = computed(() => {
  const definition = TOOLS_BY_ID.get(tool.value)
  return definition ? t(definition.labelKey) : tool.value
})
</script>

<template>
  <footer class="status">
    <span class="status__zoom">{{ zoom }}</span>
    <span class="status__sep" />
    <span class="status__cell">{{ summary }}</span>
    <span class="status__sep" />
    <span class="status__cell">{{ selectionText }}</span>
    <span class="status__sep" />
    <span class="status__cell">{{ toolName }}</span>
    <span class="status__spacer" />
    <span v-if="busy" class="status__cell">{{ t('common.working') }}</span>
    <span v-else-if="message" class="status__cell status__cell--message">{{ message }}</span>
    <span class="status__sep" />
    <span class="status__cell" :class="{ 'status__cell--off': !canGPU }">
      {{ canGPU ? t('status.webgpu') : t('status.noWebgpu') }}
    </span>
    <span class="status__sep" />
    <span class="status__cell status__cell--dim">
      {{ t('status.budget', { megapixels: limits.documentPixelBudget / 1_000_000 }) }}
    </span>
  </footer>
</template>

<style scoped>
.status {
  display: flex;
  gap: 8px;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  background: var(--ps-frame);
  border-top: 1px solid var(--ps-line-hard);
  box-shadow: 0 -1px 0 rgb(255 255 255 / 5%);
  font-size: 11px;
  color: var(--ps-text-dim);
}

.status__zoom {
  min-width: 44px;
  color: var(--ps-text);
  font-variant-numeric: tabular-nums;
}

.status__spacer {
  flex: 1;
}

.status__sep {
  width: 1px;
  height: 12px;
  background: var(--ps-line);
}

.status__cell {
  font-variant-numeric: tabular-nums;
}

.status__cell--dim {
  color: var(--ps-text-faint);
}

.status__cell--message {
  color: var(--ps-text);
}

.status__cell--off {
  color: #d08b6a;
}
</style>
