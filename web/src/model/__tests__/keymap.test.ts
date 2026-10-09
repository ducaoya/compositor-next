import { describe, expect, it } from 'vitest'

import {
  COMMANDS,
  assignBinding,
  chordFromEvent,
  clearBinding,
  commandForEvent,
  conflictingChords,
  effectiveBindings,
  formatChord,
  parseChord,
  sameChord,
  toolOf,
  toolsForChord,
  type Chord,
  type Overrides,
} from '../keymap'

const DEFAULTS = effectiveBindings({})

function press(key: string, modifiers: Partial<Record<'ctrl' | 'shift' | 'alt', boolean>> = {}) {
  return {
    key,
    ctrlKey: modifiers.ctrl ?? false,
    shiftKey: modifiers.shift ?? false,
    altKey: modifiers.alt ?? false,
    metaKey: false,
  }
}

describe('reading a binding', () => {
  it('peels the modifiers off the front', () => {
    expect(parseChord('Ctrl+Shift+Z')).toEqual({ ctrl: true, shift: true, alt: false, key: 'Z' })
    expect(parseChord('V')).toEqual({ ctrl: false, shift: false, alt: false, key: 'V' })
    expect(parseChord('Delete')).toEqual({ ctrl: false, shift: false, alt: false, key: 'Delete' })
    expect(parseChord('Ctrl+0')).toEqual({ ctrl: true, shift: false, alt: false, key: '0' })
  })

  it('tells a plus key from an empty one', () => {
    // `Ctrl++` splits into three parts if it is split on `+`, and only one of them is the key.
    expect(parseChord('Ctrl++')).toEqual({ ctrl: true, shift: false, alt: false, key: '+' })
    expect(parseChord('Ctrl+-')).toEqual({ ctrl: true, shift: false, alt: false, key: '-' })
    expect(parseChord('+')).toEqual({ ctrl: false, shift: false, alt: false, key: '+' })
  })

  it('accepts the spellings of the platform modifier, and either case', () => {
    const expected: Chord = { ctrl: true, shift: false, alt: false, key: 'S' }
    expect(parseChord('Cmd+S')).toEqual(expected)
    expect(parseChord('Meta+S')).toEqual(expected)
    expect(parseChord('ctrl+s')).toEqual(expected)
  })

  it('refuses what is not a key press', () => {
    for (const text of ['', '   ', 'Ctrl+', 'Shift+', 'Ctrl+Shift+']) {
      expect(parseChord(text), text).toBeNull()
    }
  })

  it('writes a binding back the way it reads it', () => {
    for (const text of ['Ctrl+Shift+Z', 'V', 'Ctrl++', 'Ctrl+-', 'Delete', 'Ctrl+0', 'Ctrl+]']) {
      const chord = parseChord(text)
      expect(chord, text).not.toBeNull()
      expect(formatChord(chord as Chord), text).toBe(text)
    }
  })
})

describe('a key press as a chord', () => {
  it('keeps Shift as a flag rather than folding it into the key', () => {
    // Pressing Shift and z gives `Z`, which is also what pressing z with caps lock gives: the flag
    // is the only thing that tells Ctrl+Shift+Z from Ctrl+Z.
    expect(chordFromEvent(press('Z', { ctrl: true, shift: true }))).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      key: 'Z',
    })
    expect(sameChord(chordFromEvent(press('Z', { ctrl: true })) as Chord, parseChord('Ctrl+Z') as Chord)).toBe(true)
  })

  it('reads the platform modifier as Ctrl', () => {
    const meta = { ...press('S'), metaKey: true }
    expect(chordFromEvent(meta)?.ctrl).toBe(true)
  })

  it('refuses a modifier on its own, which is the middle of typing a chord', () => {
    for (const key of ['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'CapsLock']) {
      expect(chordFromEvent(press(key)), key).toBeNull()
    }
  })

  it('gives the keys whose event name is not their name a name', () => {
    expect(chordFromEvent(press(' '))?.key).toBe('Space')
    expect(chordFromEvent(press('ArrowLeft'))?.key).toBe('ArrowLeft')
  })
})

describe('the bindings in force', () => {
  it('ships every menu command bound or deliberately not', () => {
    expect(DEFAULTS['file.save']).toBe('Ctrl+S')
    expect(DEFAULTS['edit.redo']).toBe('Ctrl+Shift+Z')
    expect(DEFAULTS['view.zoomIn']).toBe('Ctrl++')
    expect(DEFAULTS['file.exportJpeg']).toBeUndefined()
    expect(DEFAULTS['tool.move']).toBe('V')
    expect(DEFAULTS['tool.blur']).toBe('R')
  })

  it('ships no two commands on one chord', () => {
    // Merge and export PNG were both on Ctrl+E, and the keyboard had to pick one silently.
    expect(conflictingChords(DEFAULTS)).toEqual([])
  })

  it('lets an override win, and an empty one unbound', () => {
    const rebound = effectiveBindings({ 'file.save': 'Ctrl+Shift+S' })
    expect(rebound['file.save']).toBe('Ctrl+Shift+S')
    const unbound = effectiveBindings({ 'file.save': '' })
    expect(unbound['file.save']).toBe('')
  })

  it('drops what this build cannot use rather than showing it', () => {
    // A store written by another build: a command this one has never heard of, a chord that will not
    // parse, and a real binding. Only the last of the three should survive.
    const stale = {
      'file.teleport': 'Ctrl+T',
      'file.open': 'Ctrl+',
      'file.save': 'Ctrl+Shift+S',
    } as Overrides
    const bindings = effectiveBindings(stale)
    expect(bindings['file.save']).toBe('Ctrl+Shift+S')
    expect(bindings['file.open']).toBe('Ctrl+O')
    expect(Object.keys(bindings)).not.toContain('file.teleport')
  })

  it('gives a chord to one command when a hand-edited store claims it twice', () => {
    // The override is on a command *later* in the table, so the earlier one keeps its default.
    const bindings = effectiveBindings({ 'file.save': 'Ctrl+O' })
    expect(bindings['file.open']).toBe('Ctrl+O')
    expect(bindings['file.save']).toBeUndefined()
  })
})

describe('assigning a chord', () => {
  it('takes the key from whoever had it, and says who', () => {
    const { overrides, takenFrom } = assignBinding({}, 'file.open', 'Ctrl+S')
    expect(overrides['file.open']).toBe('Ctrl+S')
    expect(overrides['file.save']).toBe('')
    expect(takenFrom).toEqual(['file.save'])
    const bindings = effectiveBindings(overrides)
    expect(bindings['file.save']).toBe('')
    expect(bindings['file.open']).toBe('Ctrl+S')
    expect(conflictingChords(bindings)).toEqual([])
  })

  it('normalizes what it was given', () => {
    const { overrides } = assignBinding({}, 'file.save', 'ctrl+shift+s')
    expect(overrides['file.save']).toBe('Ctrl+Shift+S')
  })

  it('refuses a chord that is not one', () => {
    const before: Overrides = { 'file.save': 'Ctrl+S' }
    expect(assignBinding(before, 'file.open', 'Ctrl+').overrides).toEqual(before)
  })

  it('unbinds without giving the default back', () => {
    const overrides = clearBinding({}, 'file.save')
    expect(effectiveBindings(overrides)['file.save']).toBe('')
  })
})

describe('which command a key press means', () => {
  it('resolves the shortcuts this build shipped with', () => {
    expect(commandForEvent(DEFAULTS, press('s', { ctrl: true }))).toBe('file.save')
    expect(commandForEvent(DEFAULTS, press('Z', { ctrl: true, shift: true }))).toBe('edit.redo')
    expect(commandForEvent(DEFAULTS, press('E', { ctrl: true, shift: true }))).toBe('layer.merge')
    expect(commandForEvent(DEFAULTS, press(']', { ctrl: true }))).toBe('layer.bringForward')
    expect(commandForEvent(DEFAULTS, press('0', { ctrl: true }))).toBe('view.fit')
    expect(commandForEvent(DEFAULTS, press('+'))) .toBe(null)
    expect(commandForEvent(DEFAULTS, press('+', { ctrl: true }))).toBe('view.zoomIn')
    expect(commandForEvent(DEFAULTS, press('v'))).toBe('tool.move')
    expect(commandForEvent(DEFAULTS, press('1'))).toBe(null)
  })

  it('answers to the fixed alternates a command declares', () => {
    expect(commandForEvent(DEFAULTS, press('Delete'))).toBe('edit.clear')
    expect(commandForEvent(DEFAULTS, press('Backspace'))).toBe('edit.clear')
  })

  it('prefers a menu command to a tool, which is what the old keyboard did', () => {
    expect(commandForEvent(DEFAULTS, press('f'))).toBe('view.palette')
  })

  it('answers nothing for a key nothing is bound to', () => {
    expect(commandForEvent(DEFAULTS, press('q'))).toBe(null)
    // Ctrl+Z without Ctrl is not Ctrl+Z — but z on its own is the zoom tool, which is bound to Z.
    expect(commandForEvent(DEFAULTS, press('z'))).toBe('tool.zoom')
  })

  it('follows a rebind, and only the rebind', () => {
    const bindings = effectiveBindings(assignBinding({}, 'file.save', 'Ctrl+Shift+S').overrides)
    expect(commandForEvent(bindings, press('S', { ctrl: true, shift: true }))).toBe('file.save')
    expect(commandForEvent(bindings, press('s', { ctrl: true }))).toBe(null)
  })
})

describe('what cycles together', () => {
  it('walks the tools that share a key, in rail order', () => {
    expect(toolsForChord(DEFAULTS, 'R')).toEqual(['blur', 'sharpen', 'smudge'])
    expect(toolsForChord(DEFAULTS, 'M')).toEqual(['marqueeRect', 'marqueeEllipse'])
    expect(toolsForChord(DEFAULTS, 'O')).toEqual(['dodge', 'burn', 'sponge'])
    expect(toolsForChord(DEFAULTS, 'V')).toEqual(['move'])
  })

  it('walks a new group after a rebind', () => {
    const bindings = effectiveBindings(assignBinding({}, 'tool.blur', 'K').overrides)
    expect(toolsForChord(bindings, 'R')).toEqual(['sharpen', 'smudge'])
    expect(toolsForChord(bindings, 'K')).toEqual(['blur'])
  })

  it('leaves the tools alone when a menu command takes a tool key', () => {
    const bindings = effectiveBindings(assignBinding({}, 'view.grid', 'G').overrides)
    expect(bindings['tool.gradient']).toBe('')
    expect(toolsForChord(bindings, 'G')).toEqual([])
    // The menu command wins, because the menus are resolved first.
    expect(commandForEvent(bindings, press('g'))).toBe('view.grid')
  })

  it('knows a tool command from a menu command', () => {
    expect(toolOf('tool.brush')).toBe('brush')
    expect(toolOf('file.save')).toBe(null)
  })
})

describe('the command table', () => {
  it('names every command it offers', () => {
    for (const command of COMMANDS) {
      expect(command.labelKey, command.id).toMatch(/^[a-z]+\.[A-Za-z0-9]+$/)
    }
  })

  it('offers one command per key press, not two', () => {
    const ids = COMMANDS.map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not offer a tool this build cannot select', () => {
    // The Type tool round-trips its layers and has no behaviour yet.
    expect(COMMANDS.some((command) => command.id === 'tool.type')).toBe(false)
  })
})
