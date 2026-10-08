<script setup lang="ts">
/**
 * The command palette.
 *
 * The commands are the menu, flattened: one list, one search, and no second place to add a command
 * to. Typing filters on the words in any order — "lay new" finds "New Layer" — which is what makes
 * it faster than the menu it mirrors.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSession } from '../state/session'

export interface Command {
  group: string
  label: string
  shortcut?: string
  run: () => void
}

const props = defineProps<{ commands: Command[] }>()

const { t } = useI18n()
const { paletteOpen } = useSession()
const query = ref('')
const chosen = ref(0)
const field = ref<HTMLInputElement | null>(null)

/** Every word of the query appears in the label, in order. */
function matches(label: string, needle: string): boolean {
  const haystack = label.toLowerCase()
  let at = 0
  for (const word of needle.toLowerCase().split(/\s+/).filter(Boolean)) {
    const found = haystack.indexOf(word, at)
    if (found < 0) return false
    at = found + word.length
  }
  return true
}

const results = computed(() => {
  const needle = query.value.trim()
  const all = props.commands
  if (!needle) return all.slice(0, 40)
  return all.filter((command) => matches(`${command.group} ${command.label}`, needle)).slice(0, 40)
})

watch(query, () => {
  chosen.value = 0
})

watch(paletteOpen, async (open) => {
  if (!open) return
  query.value = ''
  chosen.value = 0
  await nextTick()
  field.value?.focus()
})

function move(by: number): void {
  const count = results.value.length
  if (count === 0) return
  chosen.value = (chosen.value + by + count) % count
}

function run(): void {
  const command = results.value[chosen.value]
  if (!command) return
  paletteOpen.value = false
  command.run()
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    run()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    paletteOpen.value = false
  }
}
</script>

<template>
  <div v-if="paletteOpen" class="scrim" @click.self="paletteOpen = false">
    <div class="palette" role="dialog">
      <input
        ref="field"
        v-model="query"
        class="palette__input"
        type="text"
        :placeholder="t('palette.placeholder')"
        @keydown="onKey"
      />
      <ul class="palette__list">
        <li
          v-for="(command, index) in results"
          :key="`${command.group}-${command.label}`"
          class="palette__row"
          :class="{ 'palette__row--on': index === chosen }"
          @mouseenter="chosen = index"
          @click="run"
        >
          <span class="palette__group">{{ command.group }}</span>
          <span class="palette__label">{{ command.label }}</span>
          <span v-if="command.shortcut" class="palette__shortcut">{{ command.shortcut }}</span>
        </li>
        <li v-if="results.length === 0" class="palette__empty">{{ t('palette.empty') }}</li>
      </ul>
      <p class="palette__hint">{{ t('palette.hint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  background: rgb(0 0 0 / 35%);
  z-index: 20;
}

.palette {
  width: 480px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  border: 1px solid #4a4d55;
  border-radius: 8px;
  background: #2b2c31;
  box-shadow: 0 16px 48px rgb(0 0 0 / 55%);
  overflow: hidden;
}

.palette__input {
  padding: 10px 14px;
  border: 0;
  border-bottom: 1px solid #3c3f46;
  background: #1f2024;
  color: #e6e8ec;
  font: inherit;
  font-size: 14px;
  outline: none;
}

.palette__list {
  margin: 0;
  padding: 4px 0;
  list-style: none;
  overflow: auto;
}

.palette__row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 4px 14px;
  cursor: pointer;
}

.palette__row--on {
  background: var(--ps-accent-dim);
}

.palette__group {
  min-width: 60px;
  color: var(--ps-text-faint);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.palette__label {
  flex: 1;
  color: var(--ps-text);
}

.palette__row--on .palette__label,
.palette__row--on .palette__group {
  color: #ffffff;
}

.palette__shortcut {
  color: var(--ps-text-faint);
  font-size: 11px;
}

.palette__empty {
  padding: 10px 14px;
  color: var(--ps-text-faint);
}

.palette__hint {
  margin: 0;
  padding: 6px 14px;
  border-top: 1px solid #3c3f46;
  color: var(--ps-text-faint);
  font-size: 10px;
}
</style>
