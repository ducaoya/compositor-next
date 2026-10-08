/**
 * Undo, as whole-document snapshots.
 *
 * The reference app does the same: its history holds document states rather than inverse
 * operations. That is what makes a change like "delete a folder with twelve clipped children"
 * trivially reversible, and the cost — one snapshot per edit — is bounded by the cap below.
 *
 * An edit is `begin(label, current)` … `commit(current)`, so a drag that ends up changing nothing
 * never lands in the stack.
 */

export interface HistoryEntry<S> {
  label: string
  state: S
}

export interface HistoryOptions {
  /** How many edits to keep. The oldest are dropped. */
  limit?: number
  /** Used to snapshot state. Defaults to `structuredClone`. */
  clone?: <S>(state: S) => S
}

export class EditHistory<S> {
  private past: HistoryEntry<S>[] = []
  private future: HistoryEntry<S>[] = []
  private pending: HistoryEntry<S> | null = null
  private readonly limit: number
  private readonly clone: <T>(state: T) => T

  constructor(options: HistoryOptions = {}) {
    this.limit = options.limit ?? 200
    this.clone = options.clone ?? ((state) => structuredClone(state))
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null
  }

  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null
  }

  get depth(): number {
    return this.past.length
  }

  /** Starts an edit, remembering `current` as the state to come back to. */
  begin(label: string, current: S): void {
    this.pending = { label, state: this.clone(current) }
  }

  /** True while an edit is open. A second `begin` replaces the first, as a re-entrant edit should. */
  get isEditing(): boolean {
    return this.pending !== null
  }

  /**
   * Ends an edit. Returns whether anything was recorded: a commit whose state matches the one the
   * edit started from is dropped, so clicking a slider back to where it was costs no undo step.
   */
  commit(current: S, changed?: (before: S, after: S) => boolean): boolean {
    const pending = this.pending
    this.pending = null
    if (!pending) return false
    const differs = changed ? changed(pending.state, current) : !sameJson(pending.state, current)
    if (!differs) return false
    this.past.push(pending)
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
    return true
  }

  /** Abandons an open edit without recording it. */
  cancel(): void {
    this.pending = null
  }

  undo(current: S): S | null {
    const entry = this.past.pop()
    if (!entry) return null
    this.future.push({ label: entry.label, state: this.clone(current) })
    return entry.state
  }

  redo(current: S): S | null {
    const entry = this.future.pop()
    if (!entry) return null
    this.past.push({ label: entry.label, state: this.clone(current) })
    return entry.state
  }

  /** Throws the history away, as opening a file does. */
  clear(): void {
    this.past = []
    this.future = []
    this.pending = null
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}
