/**
 * The keyboard map: the reactive copy, and the one place it is stored.
 *
 * The arithmetic — what a chord is, which command a key press means, who loses a key when someone
 * takes it — lives in `web/src/model/keymap.ts`, where it is tested without a browser. This is the
 * part that needs one: a `ref` for the interface to bind to, a round trip through local storage so a
 * rebind survives a restart, and the state of the sheet that edits it.
 *
 * Only the *overrides* are stored. A build that changes a default therefore changes it for someone
 * who has rebound something else, instead of pinning them to whatever the default used to be.
 */

import { computed, ref } from 'vue'

import {
  assignBinding,
  clearBinding,
  conflictingChords,
  effectiveBindings,
  type CommandId,
  type Overrides,
} from '../model/keymap'

const STORAGE_KEY = 'compositor.keymap'

/** Reads the overrides back, dropping anything that is not the shape it should be. */
function load(): Overrides {
  if (typeof localStorage === 'undefined') return {}
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return {}
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const overrides: Overrides = {}
    for (const [id, chord] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof chord === 'string') overrides[id as CommandId] = chord
    }
    return overrides
  } catch {
    // A store that cannot be read is a keyboard that has never been remapped, which is a working
    // keyboard.
    return {}
  }
}

function save(overrides: Overrides): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // A browser refusing storage still has a keyboard; the bindings just last as long as the tab.
  }
}

const overrides = ref<Overrides>(load())

/** What every command is bound to right now. */
export const keymap = computed(() => effectiveBindings(overrides.value))

/** Chords that two menu commands both answer to. Normally empty; the sheet says so when not. */
export const keymapConflicts = computed(() => conflictingChords(keymap.value))

/** Whether the shortcut sheet is up. */
export const shortcutSheetOpen = ref(false)

/**
 * The command waiting for a key, or null.
 *
 * Held here rather than inside the sheet so the window's own key handler can see it: while a chord
 * is being recorded, a key press is an answer to the sheet and nothing else.
 */
export const recordingCommand = ref<CommandId | null>(null)

/**
 * Binds a chord to a command, taking it from whatever had it.
 *
 * Returns the commands that lost the key, so the sheet can name them: a shortcut that quietly
 * stopped working is worse than one that was never set.
 */
export function setBinding(id: CommandId, chord: string): CommandId[] {
  const { overrides: next, takenFrom } = assignBinding(overrides.value, id, chord)
  overrides.value = next
  save(next)
  return takenFrom
}

/** Unbinds one command. Not the same as giving it back its default. */
export function clearKeyBinding(id: CommandId): void {
  overrides.value = clearBinding(overrides.value, id)
  save(overrides.value)
}

/** Puts every command back to the key it shipped with. */
export function resetKeymap(): void {
  overrides.value = {}
  save(overrides.value)
}

/** What a command is bound to, formatted. Empty when it has no key. */
export function shortcutFor(id: CommandId): string {
  return keymap.value[id] ?? ''
}
