import { describe, expect, it } from 'vitest'

import { EditHistory } from '../history'

interface Doc {
  name: string
  values: number[]
}

function doc(name: string, ...values: number[]): Doc {
  return { name, values }
}

describe('undo history', () => {
  it('records an edit and comes back to it', () => {
    const history = new EditHistory<Doc>()
    const before = doc('a')
    history.begin('Rename', before)
    expect(history.commit(doc('b'))).toBe(true)
    expect(history.canUndo).toBe(true)
    expect(history.undoLabel).toBe('Rename')

    const restored = history.undo(doc('b'))
    expect(restored).toEqual(before)
    expect(history.canRedo).toBe(true)
    expect(history.redoLabel).toBe('Rename')
  })

  it('drops an edit that changed nothing', () => {
    const history = new EditHistory<Doc>()
    const state = doc('a', 1, 2)
    history.begin('Nudge', state)
    expect(history.commit(doc('a', 1, 2))).toBe(false)
    expect(history.canUndo).toBe(false)
  })

  it('snapshots, so a later mutation of the live document cannot reach back into the stack', () => {
    const history = new EditHistory<Doc>()
    const live = doc('a', 1)
    history.begin('Edit', live)
    live.values.push(2)
    history.commit(live)
    live.values.push(3)

    const restored = history.undo(live)
    expect(restored).toEqual(doc('a', 1))
  })

  it('walks back and forward through several edits', () => {
    const history = new EditHistory<Doc>()
    let live = doc('v1')
    for (const name of ['v2', 'v3', 'v4']) {
      history.begin(`To ${name}`, live)
      live = doc(name)
      history.commit(live)
    }
    expect(history.depth).toBe(3)

    live = history.undo(live)!
    expect(live.name).toBe('v3')
    live = history.undo(live)!
    expect(live.name).toBe('v2')
    live = history.redo(live)!
    expect(live.name).toBe('v3')
    expect(history.redoLabel).toBe('To v4')
  })

  it('forgets the redo branch once a new edit lands', () => {
    const history = new EditHistory<Doc>()
    let live = doc('v1')
    history.begin('A', live)
    live = doc('v2')
    history.commit(live)
    live = history.undo(live)!
    expect(history.canRedo).toBe(true)

    history.begin('B', live)
    live = doc('v3')
    history.commit(live)
    expect(history.canRedo).toBe(false)
  })

  it('drops the oldest edits past the limit', () => {
    const history = new EditHistory<Doc>({ limit: 3 })
    let live = doc('v0')
    for (let step = 0; step < 10; step += 1) {
      history.begin(`Step ${step}`, live)
      live = doc(`v${step + 1}`)
      history.commit(live)
    }
    expect(history.depth).toBe(3)
    expect(history.undoLabel).toBe('Step 9')
  })

  it('abandons an open edit on cancel', () => {
    const history = new EditHistory<Doc>()
    const live = doc('a')
    history.begin('Edit', live)
    history.cancel()
    expect(history.commit(doc('b'))).toBe(false)
    expect(history.canUndo).toBe(false)
  })

  it('has nothing to undo or redo when empty', () => {
    const history = new EditHistory<Doc>()
    expect(history.undo(doc('a'))).toBeNull()
    expect(history.redo(doc('a'))).toBeNull()
    expect(history.undoLabel).toBeNull()
  })

  it('clears everything, as opening a file does', () => {
    const history = new EditHistory<Doc>()
    history.begin('Edit', doc('a'))
    history.commit(doc('b'))
    history.clear()
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
  })
})
