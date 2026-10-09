<script setup lang="ts">
/**
 * The tool rail, as Photoshop draws it: one column of 26px cells, a flyout corner on the cells
 * that hold more than one tool, and the foreground/background colour wells at the bottom.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { TOOLS, type ToolDefinition } from '../model/tools'
import { shortcutFor } from '../state/keymap'
import { selectTool, setForeground, swapColors, resetColors, useSession } from '../state/session'

const { t } = useI18n()
const { tool, foreground, background } = useSession()

/** Which cell has its flyout open, if any. */
const flyoutId = ref<string | null>(null)

const flyout = computed(() => TOOLS.find((entry) => entry.id === flyoutId.value) ?? null)

function choose(entry: ToolDefinition, variant?: string): void {
  selectTool((variant as typeof entry.id) ?? entry.id)
  flyoutId.value = null
}

function toggleFlyout(entry: ToolDefinition): void {
  if (!entry.variants) return
  flyoutId.value = flyoutId.value === entry.id ? null : entry.id
}

const foregroundCss = computed(
  () => `rgb(${foreground.r}, ${foreground.g}, ${foreground.b})`,
)
const backgroundCss = computed(
  () => `rgb(${background.r}, ${background.g}, ${background.b})`,
)

function onPicker(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  const r = Number.parseInt(value.slice(1, 3), 16)
  const g = Number.parseInt(value.slice(3, 5), 16)
  const b = Number.parseInt(value.slice(5, 7), 16)
  setForeground({ r, g, b })
}

function hex(): string {
  const part = (value: number) => value.toString(16).padStart(2, '0')
  return `#${part(foreground.r)}${part(foreground.g)}${part(foreground.b)}`
}

/**
 * The tool's key, as it is bound right now.
 *
 * A tooltip that kept naming the key a tool shipped with would be worse than none: it would send
 * someone to press a key that does something else.
 */
function keyFor(entry: ToolDefinition): string {
  return shortcutFor(`tool.${entry.id}`) || t('shortcuts.cleared')
}
</script>

<template>
  <nav class="rail">
    <div class="rail__tools">
      <div v-for="entry in TOOLS" :key="entry.id" class="rail__cell">
        <button
          class="rail__tool"
          :class="{ 'rail__tool--on': tool === entry.id }"
          :disabled="!entry.implemented"
          :title="
            entry.implemented
              ? `${t(entry.labelKey)} (${keyFor(entry)})`
              : t('tools.notInBuild', { tool: t(entry.labelKey) })
          "
          @click="choose(entry)"
        >
          <!-- eslint-disable-next-line vue/no-v-html -- the icons are this app's own markup -->
          <svg viewBox="0 0 24 24" width="20" height="20" v-html="entry.icon" />
        </button>
        <button
          v-if="entry.variants"
          class="rail__corner"
          :title="t('tools.options', { tool: t(entry.labelKey) })"
          @click.stop="toggleFlyout(entry)"
        />
        <div v-if="flyoutId === entry.id && flyout" class="rail__flyout">
          <button
            v-for="variant in flyout.variants"
            :key="variant.id"
            class="rail__flyout-item"
            :class="{ 'rail__flyout-item--on': tool === variant.id }"
            @click="choose(flyout, variant.id)"
          >
            {{ t(variant.labelKey) }}
          </button>
        </div>
      </div>
    </div>

    <div class="rail__colors">
      <div class="rail__wells">
        <label class="rail__well rail__well--back" :style="{ background: backgroundCss }">
          <input type="color" :value="hex()" @input="onPicker" />
        </label>
        <label class="rail__well rail__well--front" :style="{ background: foregroundCss }">
          <input type="color" :value="hex()" @input="onPicker" />
        </label>
        <button class="rail__swap" :title="t('tools.swapColors')" @click="swapColors">⇄</button>
      </div>
      <div class="rail__defaults">
        <button class="rail__mini" :title="t('tools.defaultColors')" @click="resetColors">▣</button>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 4px 0 0;
  background: var(--ps-frame);
  border-right: 1px solid var(--ps-line-hard);
}

.rail__tools {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}

.rail__cell {
  position: relative;
}

.rail__tool {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 2px;
  background: none;
  color: #c8c8c8;
  cursor: pointer;
}

.rail__tool svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.35;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.rail__tool:hover:not(:disabled) {
  background: var(--ps-control);
  border-color: var(--ps-line);
}

.rail__tool--on {
  background: #5a5a5a;
  border-color: #6e6e6e;
  color: #ffffff;
}

.rail__tool:disabled {
  opacity: 0.35;
  cursor: default;
}

.rail__corner {
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 0;
  height: 0;
  padding: 0;
  border: 0;
  border-left: 5px solid transparent;
  border-bottom: 5px solid #b8b8b8;
  background: none;
  cursor: pointer;
}

.rail__flyout {
  position: absolute;
  left: 30px;
  top: 0;
  z-index: 20;
  min-width: 168px;
  padding: 3px;
  border: 1px solid var(--ps-line);
  background: var(--ps-panel);
  box-shadow: 0 6px 18px rgb(0 0 0 / 45%);
}

.rail__flyout-item {
  display: block;
  width: 100%;
  padding: 4px 8px;
  border: 0;
  background: none;
  color: var(--ps-text);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.rail__flyout-item:hover {
  background: var(--ps-control);
}

.rail__flyout-item--on {
  background: var(--ps-accent-dim);
  color: #ffffff;
}

.rail__colors {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 0 10px;
}

.rail__wells {
  position: relative;
  width: 40px;
  height: 40px;
}

.rail__well {
  position: absolute;
  width: 25px;
  height: 25px;
  border: 1px solid #101010;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 22%);
  cursor: pointer;
}

.rail__well input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.rail__well--front {
  left: 0;
  top: 0;
  z-index: 2;
}

.rail__well--back {
  right: 0;
  bottom: 0;
}

.rail__swap {
  position: absolute;
  right: -1px;
  top: -3px;
  padding: 0;
  border: 0;
  background: none;
  color: #d0d0d0;
  font-size: 11px;
  cursor: pointer;
}

.rail__mini {
  padding: 0 2px;
  border: 0;
  background: none;
  color: #d0d0d0;
  font-size: 11px;
  cursor: pointer;
}
</style>
