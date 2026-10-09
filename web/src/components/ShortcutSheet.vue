<script setup lang="ts">
/**
 * The shortcut sheet: every command this build has, and the key it answers to.
 *
 * Built from the command table in `web/src/model/keymap.ts` rather than from a list of its own, so a
 * command added to the menu appears here without anyone remembering to add it twice — the same
 * argument the command palette is built on.
 *
 * Recording is the interaction Photoshop uses and the one that needs no instructions: click the
 * binding, press the keys, and it is bound. Escape leaves it alone, and Backspace takes the key
 * away — which is a thing a shortcut sheet has to be able to do, because a command with no key
 * cannot be expressed by pressing one.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  COMMANDS,
  chordFromEvent,
  commandById,
  formatChord,
  type CommandDefinition,
  type CommandId,
  type CommandGroup,
} from '../model/keymap'
import {
  clearKeyBinding,
  keymap,
  keymapConflicts,
  recordingCommand,
  resetKeymap,
  setBinding,
  shortcutSheetOpen,
} from '../state/keymap'

const { t } = useI18n()

/** The groups in the order the menus are in, with the tools last. */
const GROUPS: CommandGroup[] = ['file', 'edit', 'image', 'layer', 'select', 'filter', 'view', 'help', 'tool']

const sections = computed(() =>
  GROUPS.map((group) => ({
    group,
    label: group === 'tool' ? t('shortcuts.tools') : t(`menu.${group}`),
    commands: COMMANDS.filter((command) => command.group === group),
  })).filter((section) => section.commands.length > 0),
)

const problems = computed(() => keymapConflicts.value)

/** The chord shown for a command: what it is bound to, or the fact that nothing is. */
function shownFor(command: CommandDefinition): string {
  if (recordingCommand.value === command.id) return t('shortcuts.press')
  return keymap.value[command.id] || t('shortcuts.cleared')
}

function nameOf(id: CommandId): string {
  const command = commandById(id)
  return command ? t(command.labelKey) : id
}

let took = ''

function startRecording(command: CommandDefinition): void {
  took = ''
  recordingCommand.value = command.id
}

function stopRecording(): void {
  recordingCommand.value = null
}

/**
 * The key press that becomes a binding.
 *
 * Called by the sheet's own listener, which only runs while something is being recorded. A modifier
 * on its own is not a chord — it is the beginning of one — so it is ignored and the sheet keeps
 * waiting rather than binding `Ctrl` alone.
 */
function record(event: KeyboardEvent): void {
  const id = recordingCommand.value
  if (!id) return
  if (event.key === 'Escape') {
    stopRecording()
    return
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    clearKeyBinding(id)
    stopRecording()
    return
  }
  const chord = chordFromEvent(event)
  if (!chord) return
  const takenFrom = setBinding(id, formatChord(chord))
  took = takenFrom.length ? t('shortcuts.takenFrom', { names: takenFrom.map(nameOf).join(', ') }) : ''
  stopRecording()
}
</script>

<template>
  <div
    v-if="shortcutSheetOpen"
    class="scrim"
    @click.self="stopRecording()"
    @keydown="record"
    @keydown.esc="stopRecording()"
  >
    <div class="sheet" role="dialog" aria-label="Keyboard shortcuts">
      <h2 class="sheet__title">{{ t('shortcuts.title') }}</h2>
      <p class="sheet__hint">{{ t('shortcuts.hint') }}</p>
      <p v-if="problems.length" class="sheet__problem">
        {{ t('shortcuts.conflict', { chords: problems.join(', ') }) }}
      </p>
      <p v-if="took" class="sheet__notice">{{ took }}</p>

      <div class="sections">
        <section v-for="section in sections" :key="section.group" class="section">
          <h3 class="section__title">{{ section.label }}</h3>
          <div v-for="command in section.commands" :key="command.id" class="row">
            <span class="row__label">{{ t(command.labelKey) }}</span>
            <button
              class="row__binding"
              :class="{
                'row__binding--recording': recordingCommand === command.id,
                'row__binding--none': !keymap[command.id],
              }"
              @click="startRecording(command)"
              @blur="stopRecording()"
            >
              {{ shownFor(command) }}
            </button>
          </div>
        </section>
      </div>

      <p class="sheet__footnote">{{ t('shortcuts.fixed') }}</p>
      <div class="sheet__actions">
        <button class="sheet__button" @click="resetKeymap()">{{ t('shortcuts.reset') }}</button>
        <button class="sheet__button sheet__button--primary" @click="stopRecording(); shortcutSheetOpen = false">
          {{ t('shortcuts.done') }}
        </button>
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
  display: flex;
  flex-direction: column;
  width: 640px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  padding: 16px;
  border: 1px solid #3c3f46;
  border-radius: 8px;
  background: #2b2c31;
  box-shadow: 0 12px 40px rgb(0 0 0 / 45%);
}

.sheet__title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: #e6e8ec;
}

.sheet__hint,
.sheet__footnote {
  margin: 0 0 8px;
  font-size: 11px;
  color: #8b9099;
}

.sheet__footnote {
  margin-top: 10px;
}

.sheet__problem {
  margin: 0 0 8px;
  font-size: 11px;
  color: #e08a6a;
}

.sheet__notice {
  margin: 0 0 8px;
  font-size: 11px;
  color: #9fc48f;
}

.sections {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 20px;
  min-height: 0;
  overflow-y: auto;
}

.section {
  break-inside: avoid;
  margin-bottom: 10px;
}

.section__title {
  margin: 0 0 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #7d838d;
}

.row {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 1px 0;
}

.row__label {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: #d6d9df;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__binding {
  min-width: 112px;
  padding: 2px 6px;
  border: 1px solid #3c3f46;
  border-radius: 3px;
  background: #1f2024;
  color: #d6d9df;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.row__binding:hover {
  border-color: #4b7fbe;
}

.row__binding--recording {
  border-color: #4b7fbe;
  background: #3f6ea8;
  color: #ffffff;
}

.row__binding--none {
  color: #6f7580;
}

.sheet__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 12px;
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
