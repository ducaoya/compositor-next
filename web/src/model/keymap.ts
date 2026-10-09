/**
 * Keyboard shortcuts, as data rather than as a chain of `if`s.
 *
 * One table, read by everything that has an opinion about a key: the menu bar puts the chord on its
 * labels, the command palette prints it beside a command, the shortcut sheet edits it, and the
 * keyboard resolves a key press through it. That is what makes a rebind show up everywhere at once
 * — a menu that says `Ctrl+S` is reading the binding, not a string someone typed next to it once.
 *
 * A binding is a *chord*: the platform modifier, Shift, Alt, and one key, written the way Photoshop
 * writes it — `Ctrl+Shift+Z`, `Ctrl+]`, `Ctrl++`, `Delete`, `V`. Parsing and formatting are the two
 * functions worth having without a browser, and the rest of this module is the arithmetic of which
 * command a key press means, which is the part with edge cases: a chord that two commands claim, a
 * binding that has been cleared to nothing, a keyboard layout where Shift turns `z` into `Z`.
 *
 * What is *not* here: the arrow keys nudging the active layer, Enter applying a crop and Escape
 * cancelling one. Those are not commands with menu items to hang a binding on, and pretending
 * otherwise would mean inventing four menu entries nobody asked for.
 */

import { TOOLS, type ToolId } from './tools'

/**
 * A command that can be bound to a key.
 *
 * The menu commands first, in the order the menus present them, then one per tool — that is also the
 * order a key press is resolved in, so a plain-letter binding for a menu command beats a tool that
 * happens to share the letter, which is what the hardcoded keyboard did before this existed.
 */
export type CommandId =
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.exportPng'
  | 'file.exportJpeg'
  | 'file.import'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.fillForeground'
  | 'edit.fillBackground'
  | 'edit.clear'
  | 'edit.contentAwareFill'
  | 'edit.copyMerged'
  | 'image.canvasSize'
  | 'image.imageSize'
  | 'image.trim'
  | 'image.flipHorizontal'
  | 'image.flipVertical'
  | 'layer.new'
  | 'layer.newGroup'
  | 'layer.duplicate'
  | 'layer.group'
  | 'layer.ungroup'
  | 'layer.bringForward'
  | 'layer.sendBackward'
  | 'layer.merge'
  | 'layer.effects'
  | 'layer.delete'
  | 'select.all'
  | 'select.deselect'
  | 'select.inverse'
  | 'select.fromPixels'
  | 'select.fromMask'
  | 'select.feather'
  | 'select.expand'
  | 'select.contract'
  | 'filter.blur'
  | 'filter.noise'
  | 'filter.vignette'
  | 'filter.glow'
  | 'filter.tonal'
  | 'filter.lens'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.palette'
  | 'view.fit'
  | 'view.actualPixels'
  | 'view.rulers'
  | 'view.grid'
  | 'view.gridLarger'
  | 'view.gridSmaller'
  | 'view.gridSubdivide'
  | 'help.checkUpdates'
  | 'help.installUpdate'
  | `tool.${ToolId}`

/** Which section of the shortcut sheet a command belongs to. */
export type CommandGroup =
  | 'file'
  | 'edit'
  | 'image'
  | 'layer'
  | 'select'
  | 'filter'
  | 'view'
  | 'help'
  | 'tool'

export interface CommandDefinition {
  id: CommandId
  /** The translation key the command is named by, which is also the menu item's own label. */
  labelKey: string
  group: CommandGroup
  /** What it ships bound to. Empty for a command that has no default key. */
  default: string
  /**
   * Keys that also run it and cannot be rebound.
   *
   * Only one command needs this: Delete clears a layer, and Backspace is the key half the world
   * reaches for on a keyboard whose Delete is somewhere else. Remapping one of a pair and not the
   * other would be a worse surprise than not remapping it at all.
   */
  alt?: readonly string[]
}

/**
 * The menu commands, in menu order.
 *
 * A command with no default is still listed: the sheet exists so that a command without a shortcut
 * can be given one, which is half of what remapping is for.
 */
const MENU_COMMANDS: readonly CommandDefinition[] = [
  { id: 'file.new', labelKey: 'menu.newProject', group: 'file', default: 'Ctrl+N' },
  { id: 'file.open', labelKey: 'menu.open', group: 'file', default: 'Ctrl+O' },
  { id: 'file.save', labelKey: 'menu.save', group: 'file', default: 'Ctrl+S' },
  { id: 'file.exportPng', labelKey: 'menu.exportPng', group: 'file', default: 'Ctrl+E' },
  { id: 'file.exportJpeg', labelKey: 'menu.exportJpeg', group: 'file', default: '' },
  { id: 'file.import', labelKey: 'menu.importImages', group: 'file', default: '' },
  { id: 'edit.undo', labelKey: 'menu.undo', group: 'edit', default: 'Ctrl+Z' },
  { id: 'edit.redo', labelKey: 'menu.redo', group: 'edit', default: 'Ctrl+Shift+Z' },
  { id: 'edit.fillForeground', labelKey: 'menu.fillForeground', group: 'edit', default: '' },
  { id: 'edit.fillBackground', labelKey: 'menu.fillBackground', group: 'edit', default: '' },
  { id: 'edit.clear', labelKey: 'menu.clear', group: 'edit', default: 'Delete', alt: ['Backspace'] },
  { id: 'edit.contentAwareFill', labelKey: 'menu.contentAwareFill', group: 'edit', default: '' },
  { id: 'edit.copyMerged', labelKey: 'menu.copyMerged', group: 'edit', default: 'Ctrl+Shift+C' },
  { id: 'image.canvasSize', labelKey: 'menu.canvasSize', group: 'image', default: '' },
  { id: 'image.imageSize', labelKey: 'menu.imageSize', group: 'image', default: '' },
  { id: 'image.trim', labelKey: 'menu.trim', group: 'image', default: '' },
  { id: 'image.flipHorizontal', labelKey: 'menu.flipCanvasH', group: 'image', default: '' },
  { id: 'image.flipVertical', labelKey: 'menu.flipCanvasV', group: 'image', default: '' },
  { id: 'layer.new', labelKey: 'menu.newLayer', group: 'layer', default: 'Ctrl+Shift+N' },
  { id: 'layer.newGroup', labelKey: 'menu.newGroup', group: 'layer', default: '' },
  { id: 'layer.duplicate', labelKey: 'menu.duplicateLayer', group: 'layer', default: 'Ctrl+J' },
  { id: 'layer.group', labelKey: 'menu.groupLayers', group: 'layer', default: 'Ctrl+G' },
  { id: 'layer.ungroup', labelKey: 'menu.ungroupLayers', group: 'layer', default: 'Ctrl+Shift+G' },
  { id: 'layer.bringForward', labelKey: 'menu.bringForward', group: 'layer', default: 'Ctrl+]' },
  { id: 'layer.sendBackward', labelKey: 'menu.sendBackward', group: 'layer', default: 'Ctrl+[' },
  // Merge was on Ctrl+E, which is export PNG — the keyboard had to pick one of them and always
  // picked export. A shortcut sheet cannot ship a duplicate binding, so merge keeps Photoshop's
  // other merge key instead.
  { id: 'layer.merge', labelKey: 'menu.mergeLayers', group: 'layer', default: 'Ctrl+Shift+E' },
  { id: 'layer.effects', labelKey: 'menu.layerEffects', group: 'layer', default: '' },
  { id: 'layer.delete', labelKey: 'menu.deleteLayer', group: 'layer', default: '' },
  { id: 'select.all', labelKey: 'menu.selectAll', group: 'select', default: 'Ctrl+A' },
  { id: 'select.deselect', labelKey: 'menu.deselect', group: 'select', default: 'Ctrl+D' },
  { id: 'select.inverse', labelKey: 'menu.inverse', group: 'select', default: 'Ctrl+Shift+I' },
  { id: 'select.fromPixels', labelKey: 'select.loadPixels', group: 'select', default: '' },
  { id: 'select.fromMask', labelKey: 'select.loadMask', group: 'select', default: '' },
  { id: 'select.feather', labelKey: 'select.feather', group: 'select', default: '' },
  { id: 'select.expand', labelKey: 'select.expand', group: 'select', default: '' },
  { id: 'select.contract', labelKey: 'select.contract', group: 'select', default: '' },
  { id: 'filter.blur', labelKey: 'menu.gaussianBlur', group: 'filter', default: '' },
  { id: 'filter.noise', labelKey: 'menu.addNoise', group: 'filter', default: '' },
  { id: 'filter.vignette', labelKey: 'menu.vignette', group: 'filter', default: '' },
  { id: 'filter.glow', labelKey: 'menu.bloomGlow', group: 'filter', default: '' },
  { id: 'filter.tonal', labelKey: 'menu.tonalContrast', group: 'filter', default: '' },
  { id: 'filter.lens', labelKey: 'menu.lensCorrection', group: 'filter', default: '' },
  { id: 'view.zoomIn', labelKey: 'menu.zoomIn', group: 'view', default: 'Ctrl++' },
  { id: 'view.zoomOut', labelKey: 'menu.zoomOut', group: 'view', default: 'Ctrl+-' },
  { id: 'view.palette', labelKey: 'menu.commandPalette', group: 'view', default: 'F' },
  { id: 'view.fit', labelKey: 'menu.fitOnScreen', group: 'view', default: 'Ctrl+0' },
  { id: 'view.actualPixels', labelKey: 'menu.actualPixels', group: 'view', default: 'Ctrl+1' },
  { id: 'view.rulers', labelKey: 'menu.rulers', group: 'view', default: '' },
  { id: 'view.grid', labelKey: 'menu.grid', group: 'view', default: '' },
  { id: 'view.gridLarger', labelKey: 'menu.gridLarger', group: 'view', default: '' },
  { id: 'view.gridSmaller', labelKey: 'menu.gridSmaller', group: 'view', default: '' },
  { id: 'view.gridSubdivide', labelKey: 'menu.gridSubdivide', group: 'view', default: '' },
  { id: 'help.checkUpdates', labelKey: 'menu.checkUpdates', group: 'help', default: '' },
  { id: 'help.installUpdate', labelKey: 'menu.installUpdate', group: 'help', default: '' },
]

/**
 * Every bindable command: the menus, then one per tool that this build implements.
 *
 * A tool that is not implemented has nothing to select, so it is not offered — which is also why
 * the Type tool has no entry in the sheet.
 */
export const COMMANDS: readonly CommandDefinition[] = [
  ...MENU_COMMANDS,
  ...TOOLS.filter((tool) => tool.implemented).map(
    (tool): CommandDefinition => ({
      id: `tool.${tool.id}`,
      labelKey: tool.labelKey,
      group: 'tool',
      default: tool.shortcut,
    }),
  ),
]

const BY_ID = new Map<string, CommandDefinition>(COMMANDS.map((command) => [command.id, command]))

export function commandById(id: CommandId): CommandDefinition | undefined {
  return BY_ID.get(id)
}

/** The tool a `tool.*` command selects, or null for a menu command. */
export function toolOf(id: CommandId): ToolId | null {
  return id.startsWith('tool.') ? (id.slice('tool.'.length) as ToolId) : null
}

/** A key press: the platform modifier, Shift, Alt, and the key itself. */
export interface Chord {
  /** Ctrl on Windows and Linux, Cmd on macOS — Photoshop's own conflation of the two. */
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** One character, upper-cased, or a named key such as `Delete` or `ArrowLeft`. */
  key: string
}

/** What a keyboard event looks like, as far as a chord cares. */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const MODIFIER_PREFIX = /^(ctrl|cmd|meta|⌘|shift|alt)\+/i

/**
 * Reads a binding.
 *
 * The awkward case is a key that *is* a plus: `Ctrl++` is Ctrl and plus, not Ctrl and two empty
 * strings, so the modifiers are peeled off the front one at a time and whatever is left is the key.
 * `Cmd` and `Meta` are accepted as spellings of `Ctrl`, because that is what they mean here, and the
 * modifiers are matched whatever their case so a hand-edited store is not silently dropped.
 */
export function parseChord(text: string): Chord | null {
  let rest = text.trim()
  if (!rest) return null
  const chord: Chord = { ctrl: false, shift: false, alt: false, key: '' }
  let match = MODIFIER_PREFIX.exec(rest)
  while (match) {
    const modifier = match[1].toLowerCase()
    if (modifier === 'shift') chord.shift = true
    else if (modifier === 'alt') chord.alt = true
    else chord.ctrl = true
    rest = rest.slice(match[0].length)
    match = MODIFIER_PREFIX.exec(rest)
  }
  if (!rest) return null
  chord.key = rest.length === 1 ? rest.toUpperCase() : rest
  return chord
}

/** Writes a binding the way Photoshop writes it. */
export function formatChord(chord: Chord): string {
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.shift) parts.push('Shift')
  if (chord.alt) parts.push('Alt')
  parts.push(chord.key)
  return parts.join('+')
}

/** Whether two chords are the same key press. */
export function sameChord(one: Chord, other: Chord): boolean {
  return (
    one.ctrl === other.ctrl && one.shift === other.shift && one.alt === other.alt && one.key === other.key
  )
}

/**
 * The chords a command answers to: its binding, and any fixed alternates.
 *
 * Empty for a command with no binding, which is the whole answer for most of the menu.
 */
export function chordsOf(binding: string, command: CommandDefinition): Chord[] {
  const texts = [binding, ...(command.alt ?? [])].filter((text) => text.trim() !== '')
  const chords: Chord[] = []
  for (const text of texts) {
    const chord = parseChord(text)
    if (chord) chords.push(chord)
  }
  return chords
}

/** Named keys whose event name is not the name to show. */
const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Esc: 'Escape',
  Del: 'Delete',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
}

/** Keys that are not a chord on their own: a modifier mid-press, or a dead key. */
const NOT_A_KEY = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Unidentified',
  'Process',
  'AltGraph',
])

/**
 * The chord a key press is, or null when the press is not one.
 *
 * Shift is kept as a flag *and* not folded into the key, even though pressing Shift and z gives
 * `Z`: a binding of `Ctrl+Shift+Z` has to be distinguishable from `Ctrl+Z`, and `event.key` alone
 * cannot tell them apart. A single character is upper-cased so `z` and `Z` are the same key.
 */
export function chordFromEvent(event: KeyEventLike): Chord | null {
  const key = event.key
  if (!key || NOT_A_KEY.has(key)) return null
  const named = KEY_NAMES[key] ?? key
  return {
    ctrl: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
    key: named.length === 1 ? named.toUpperCase() : named,
  }
}

/** Overrides the user has made, keyed by command. An empty string means "unbound". */
export type Overrides = Partial<Record<CommandId, string>>

/** What every command is bound to, defaults and overrides together. Empty means no key. */
export type Bindings = Partial<Record<CommandId, string>>

/**
 * The bindings in force.
 *
 * An override that names a command this build does not have is dropped rather than shown, and one
 * whose chord will not parse falls back to the default rather than unbinding: a stale entry in local
 * storage should cost nothing. Two *menu* commands that end up claiming one chord — which takes a
 * hand-edited store, because assigning a key takes it away from whoever had it — are resolved in
 * table order, so whoever comes first keeps it and the other reads as unbound. Tools are exempt, and
 * deliberately: three of them sharing `R` is the cycle, not a clash.
 */
export function effectiveBindings(overrides: Overrides): Bindings {
  const bindings: Bindings = {}
  const claimed = new Set<string>()
  for (const command of COMMANDS) {
    const own = Object.prototype.hasOwnProperty.call(overrides, command.id)
    const explicit = own ? (overrides[command.id] ?? '') : null
    // A default is a better answer than nothing for an override that makes no sense.
    const text =
      explicit !== null && explicit !== '' && !parseChord(explicit)
        ? command.default
        : (explicit ?? command.default)
    if (text.trim() === '') {
      // An explicit empty override is a command the user unbound; a default of empty is one that
      // never had a key. Either way there is no key to claim.
      if (own) bindings[command.id] = ''
      continue
    }
    const chord = parseChord(text)
    if (!chord) continue
    const written = formatChord(chord)
    // Tools are allowed to share: pressing `R` repeatedly is how blur, sharpen and smudge are
    // reached, and a tool that could not share a key would need one of its own per variant. Two
    // *menu* commands on one chord is the thing that must not happen.
    if (command.group !== 'tool' && claimed.has(written)) continue
    claimed.add(written)
    bindings[command.id] = written
  }
  return bindings
}

/**
 * Assigns a chord, taking it from whatever had it.
 *
 * One chord, one command: a keyboard that runs two things is a keyboard nobody can predict, and
 * silently leaving the loser in place would mean the winner works only if the loser is disabled. The
 * commands that lost the key come back so the sheet can say so.
 */
export function assignBinding(
  overrides: Overrides,
  id: CommandId,
  chord: string,
): { overrides: Overrides; takenFrom: CommandId[] } {
  const parsed = parseChord(chord)
  if (!parsed) return { overrides, takenFrom: [] }
  const text = formatChord(parsed)
  const next: Overrides = { ...overrides, [id]: text }
  // Who holds it *now*, rather than who would hold it afterwards: asking afterwards would miss the
  // command this one has just displaced, which is the one the sheet has to name.
  const held = effectiveBindings(overrides)
  const takenFrom: CommandId[] = []
  for (const command of COMMANDS) {
    if (command.id === id) continue
    if (held[command.id] === text) {
      next[command.id] = ''
      takenFrom.push(command.id)
    }
  }
  return { overrides: next, takenFrom }
}

/** Unbinds a command, which is not the same as giving it back its default. */
export function clearBinding(overrides: Overrides, id: CommandId): Overrides {
  return { ...overrides, [id]: '' }
}

/**
 * Chords that two menu commands both answer to, for the sheet to warn about.
 *
 * Tools are left out: a chord several tools share is a cycle, not a clash, and the point of the
 * warning is the case nobody can predict. The fixed alternates do count, so anything bound to
 * `Backspace` collides with the layer-clear that always answers to it.
 */
export function conflictingChords(bindings: Bindings): string[] {
  const seen = new Map<string, number>()
  for (const command of COMMANDS) {
    if (command.group === 'tool') continue
    const text = bindings[command.id]
    if (!text) continue
    // The fixed alternates count: Delete clearing a layer collides with anything bound to Backspace.
    for (const chord of chordsOf(text, command)) {
      const written = formatChord(chord)
      seen.set(written, (seen.get(written) ?? 0) + 1)
    }
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([written]) => written)
}

/**
 * The command a key press means, or null.
 *
 * Table order decides: the menus come before the tools, which is what keeps `F` opening the command
 * palette rather than reaching for a tool that is not bound to it.
 */
export function commandForEvent(bindings: Bindings, event: KeyEventLike): CommandId | null {
  const pressed = chordFromEvent(event)
  if (!pressed) return null
  for (const command of COMMANDS) {
    for (const chord of chordsOf(bindings[command.id] ?? '', command)) {
      if (sameChord(chord, pressed)) return command.id
    }
  }
  return null
}

/**
 * The commands bound to one chord, in table order.
 *
 * The tools read this to cycle: pressing `R` repeatedly walks blur, sharpen, smudge — the tools that
 * share the key rather than a hardcoded list, so a rebind changes what cycles together.
 */
export function commandsForChord(bindings: Bindings, chord: string): CommandId[] {
  const wanted = parseChord(chord)
  if (!wanted) return []
  return COMMANDS.filter((command) =>
    chordsOf(bindings[command.id] ?? '', command).some((own) => sameChord(own, wanted)),
  ).map((command) => command.id)
}

/** The tools bound to one chord, in rail order. */
export function toolsForChord(bindings: Bindings, chord: string): ToolId[] {
  const ids: ToolId[] = []
  for (const id of commandsForChord(bindings, chord)) {
    const tool = toolOf(id)
    if (tool) ids.push(tool)
  }
  return ids
}
