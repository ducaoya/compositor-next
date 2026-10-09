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
    // A step answers with its state and whatever pixels belong to it; this one has none.
    expect(restored?.state).toEqual(before)
    expect(restored?.attachment).toBeNull()
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
    expect(restored?.state).toEqual(doc('a', 1))
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

    live = history.undo(live)!.state
    expect(live.name).toBe('v3')
    live = history.undo(live)!.state
    expect(live.name).toBe('v2')
    live = history.redo(live)!.state
    expect(live.name).toBe('v3')
    expect(history.redoLabel).toBe('To v4')
  })

  it('forgets the redo branch once a new edit lands', () => {
    const history = new EditHistory<Doc>()
    let live = doc('v1')
    history.begin('A', live)
    live = doc('v2')
    history.commit(live)
    live = history.undo(live)!.state
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

describe('attachments, which are what the pixels are', () => {
  it('hands back the attachment that belongs to the step being left', () => {
    const history = new EditHistory<number, string[]>({ limit: 10 })
    history.begin('first', 1, ['pixels as they were'])
    history.commit(2)
    const step = history.undo(2, ['pixels as they are now'])
    expect(step).toEqual({ state: 1, attachment: ['pixels as they were'] })
    // And the way forward holds the pixels the undo just replaced.
    const forward = history.redo(1, ['pixels as they were'])
    expect(forward).toEqual({ state: 2, attachment: ['pixels as they are now'] })
  })

  it('carries nothing for a step that has no pixels to put back', () => {
    const history = new EditHistory<number, string[]>({ limit: 10 })
    history.begin('a slider', 1)
    history.commit(2)
    expect(history.undo(2)?.attachment).toBeNull()
  })

  it('drops whole steps when the bytes run out, never half of one', () => {
    const history = new EditHistory<number, number>({
      limit: 50,
      byteLimit: 300,
      bytesOf: (bytes) => bytes,
    })
    for (let step = 1; step <= 5; step += 1) {
      history.begin(`step ${step}`, step, 100)
      history.commit(step + 1)
    }
    // Three steps of a hundred bytes fit in three hundred.
    expect(history.attachmentBytes).toBe(300)
    expect(history.depth).toBe(3)
    expect(history.undoLabel).toBe('step 5')
    // The oldest steps went whole: their states are gone with their pixels.
    expect(history.undo(6)?.state).toBe(5)
    expect(history.undo(5)?.state).toBe(4)
    expect(history.undo(4)?.state).toBe(3)
    expect(history.undo(3)).toBeNull()
  })

  it('keeps the newest step even when it alone is over the budget', () => {
    // A crop of a big document can cost more than the whole budget. Dropping it would leave an edit
    // that cannot be undone, which is worse than holding more memory than intended.
    const history = new EditHistory<number, number>({
      limit: 50,
      byteLimit: 100,
      bytesOf: (bytes) => bytes,
    })
    history.begin('a small edit', 1, 10)
    history.commit(2)
    history.begin('a crop', 2, 4000)
    history.commit(3)
    expect(history.depth).toBe(1)
    expect(history.undoLabel).toBe('a crop')
    expect(history.undo(3)?.attachment).toBe(4000)
  })

  it('leaves the step count cap alone when there is no byte budget', () => {
    const history = new EditHistory<number>({ limit: 3 })
    for (let step = 1; step <= 5; step += 1) {
      history.begin(`step ${step}`, step)
      history.commit(step + 1)
    }
    expect(history.depth).toBe(3)
    expect(history.attachmentBytes).toBe(0)
  })
})

describe('a step that only changed pixels', () => {
  it('is recorded even though the manifest is identical', () => {
    // This is the case that hid for so long: a filter or a brush stroke leaves the document's
    // structure exactly as it was, so a commit comparing manifests dropped the step — and with it
    // the only record of what the pixels used to be.
    const history = new EditHistory<Doc, string[]>({ limit: 10 })
    const document = doc('a')
    history.begin('Gaussian Blur', document, ['the pixels before'])
    expect(history.commit(document)).toBe(true)
    expect(history.undoLabel).toBe('Gaussian Blur')
    expect(history.undo(document)?.attachment).toEqual(['the pixels before'])
  })

  it('is still dropped when it carries nothing and changed nothing', () => {
    const history = new EditHistory<Doc, string[]>({ limit: 10 })
    const document = doc('a')
    history.begin('A slider', document)
    expect(history.commit(document)).toBe(false)
    expect(history.canUndo).toBe(false)
  })
})
