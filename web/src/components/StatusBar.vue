<script setup lang="ts">
/** The footer: where the pointer is, how far in the view is, and what just happened. */
import { computed } from 'vue'

import { useSession } from '../state/session'

const { manifest, view, message, busy, limits, canGPU } = useSession()

const size = computed(() =>
  manifest.value ? `${manifest.value.width} × ${manifest.value.height}` : '—',
)

const resolution = computed(() => {
  const value = manifest.value?.resolution ?? 72
  return `${Math.round(value)} ppi`
})

const version = computed(() =>
  manifest.value ? `v${manifest.value.version}` : `v${limits.value.currentVersion}`,
)

const writable = computed(() => !busy.value)
</script>

<template>
  <footer class="status">
    <span class="status__item">{{ size }}</span>
    <span class="status__item">{{ resolution }}</span>
    <span class="status__item">{{ version }}</span>
    <span class="status__item">{{ Math.round(view.zoom * 100) }}%</span>
    <span class="status__item status__item--gpu" :class="{ 'status__item--off': !canGPU }">
      {{ canGPU ? 'WebGPU' : 'no WebGPU' }}
    </span>
    <span class="status__spacer" />
    <span v-if="busy" class="status__item">Working…</span>
    <span v-else-if="message && writable" class="status__item status__item--message">{{ message }}</span>
  </footer>
</template>

<style scoped>
.status {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 5px 10px;
  background: #232428;
  border-top: 1px solid #33353a;
  font-size: 11px;
  color: #7d838d;
  font-variant-numeric: tabular-nums;
}

.status__spacer {
  flex: 1;
}

.status__item--gpu {
  color: #6fbf8f;
}

.status__item--off {
  color: #d08b6a;
}

.status__item--message {
  color: #9aa0ab;
}
</style>
