import { describe, expect, it } from 'vitest'

import {
  AUTOSAVE_MIN_GAP_MS,
  AUTOSAVE_QUIET_MS,
  autosaveDue,
  recoveryLabel,
  type RecoveryEntry,
} from '../recovery'

const now = 1_000_000

function entry(patch: Partial<RecoveryEntry> = {}): RecoveryEntry {
  return {
    origin: '',
    document: 'tab-1',
    name: '',
    savedAt: now,
    appVersion: '0.1.0',
    target: 'C:/data/recovery/x/snapshot.comp',
    ...patch,
  }
}

describe('when a document is snapshotted', () => {
  it('never touches a document with nothing to save', () => {
    expect(
      autosaveDue({ dirty: false, now, changedAt: now - 60_000, autosavedAt: 0 }),
    ).toBe(false)
  })

  it('waits for the editing to stop', () => {
    const quiet = { dirty: true, now, changedAt: now - AUTOSAVE_QUIET_MS + 1, autosavedAt: 0 }
    expect(autosaveDue(quiet)).toBe(false)
    expect(autosaveDue({ ...quiet, changedAt: now - AUTOSAVE_QUIET_MS })).toBe(true)
  })

  it('does not snapshot twice in a row, however quiet the document is', () => {
    const state = { dirty: true, now, changedAt: now - 60_000, autosavedAt: now - 1_000 }
    expect(autosaveDue(state)).toBe(false)
    expect(autosaveDue({ ...state, autosavedAt: now - AUTOSAVE_MIN_GAP_MS })).toBe(true)
  })

  it('snapshots again once the gap has passed, on the next edit', () => {
    const change = now - AUTOSAVE_MIN_GAP_MS - 1
    expect(
      autosaveDue({ dirty: true, now, changedAt: change, autosavedAt: now - AUTOSAVE_MIN_GAP_MS }),
    ).toBe(true)
  })
})

describe('what a snapshot is offered as', () => {
  it('uses the name the shell recorded', () => {
    expect(recoveryLabel(entry({ name: 'Poster.comp' }))).toBe('Poster.comp')
  })

  it('falls back to the project it came from', () => {
    expect(recoveryLabel(entry({ origin: String.raw`C:\Work\Poster.comp` }))).toBe('Poster.comp')
  })

  it('says an unsaved document is untitled rather than inventing a file name', () => {
    expect(recoveryLabel(entry({ origin: '   ', name: '' }))).toBe('Untitled.comp')
  })
})
