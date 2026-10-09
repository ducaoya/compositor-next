/**
 * Undo, as whole-document snapshots.
 *
 * The reference app does the same: its history holds document states rather than inverse
 * operations. That is what makes a change like "delete a folder with twelve clipped children"
 * trivially reversible, and the cost — one snapshot per edit — is bounded by the cap below.
 *
 * An edit is `begin(label, current)` … `commit(current)`, so a drag that ends up changing nothing
 * never lands in the stack.
 *
 * A step can also carry an **attachment**: whatever the caller needs to put the *pixels* back,
 * because the manifest is the document's structure and the pixels live in the paint store beside it.
 * The manifest is small — JSON, so two hundred steps cost nothing — and an attachment is not: a
 * layer's pixels are four bytes a pixel, so a 4,000 × 4,000 layer is 64 MB a step. That is why the
 * two are capped differently, and why the byte budget evicts **whole steps**, oldest first: an undo
 * that restored the manifest but not the pixels would be worse than one that cannot be taken at all.
 */

export interface HistoryEntry<S, A> {
  label: string
  state: S
  /** The pixels before this step, or null for a step that touches none. */
  attachment: A | null
}

export interface HistoryOptions<S, A> {
  /** How many edits to keep. The oldest are dropped. */
  limit?: number
  /** How many bytes of attachments to keep. The oldest whole steps are dropped first. */
  byteLimit?: number
  /** How big an attachment is. Without it, `byteLimit` means nothing. */
  bytesOf?: (attachment: A) => number
  /** Used to snapshot state. Defaults to `structuredClone`. */
  clone?: (state: S) => S
}

export class EditHistory<S, A = null> {
  private past: HistoryEntry<S, A>[] = []
  private future: HistoryEntry<S, A>[] = []
  private pending: HistoryEntry<S, A> | null = null
  private readonly limit: number
  private readonly byteLimit: number
  private readonly bytesOf: ((attachment: A) => number) | null
  private readonly clone: (state: S) => S

  constructor(options: HistoryOptions<S, A> = {}) {
    this.limit = options.limit ?? 200
    this.byteLimit = options.byteLimit ?? Number.POSITIVE_INFINITY
    this.bytesOf = options.bytesOf ?? null
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

  /** How many bytes of attachments are held. For the status bar, and for the tests. */
  get attachmentBytes(): number {
    const bytesOf = this.bytesOf
    if (!bytesOf) return 0
    return this.past.reduce((sum, entry) => sum + (entry.attachment ? bytesOf(entry.attachment) : 0), 0)
  }

  /**
   * The attachment of the step `undo` would leave, without leaving it.
   *
   * The caller needs it to know *which* pixels the step touched, so it can capture what they are now
   * — that is what a redo comes back to. The alternative would be for the history to know how to
   * snapshot pixels, which is the caller's business: it holds the paint store.
   */
  get nextUndoAttachment(): A | null {
    return this.past.at(-1)?.attachment ?? null
  }

  /** The attachment of the step `redo` would come back to. */
  get nextRedoAttachment(): A | null {
    return this.future.at(-1)?.attachment ?? null
  }

  /** Starts an edit, remembering `current` as the state — and the pixels — to come back to. */
  begin(label: string, current: S, attachment: A | null = null): void {
    this.pending = { label, state: this.clone(current), attachment }
  }

  /** True while an edit is open. A second `begin` replaces the first, as a re-entrant edit should. */
  get isEditing(): boolean {
    return this.pending !== null
  }

  /**
   * Ends an edit. Returns whether anything was recorded.
   *
   * A commit whose state matches the one the edit started from is dropped, so clicking a slider back
   * to where it was costs no undo step — *unless* the step carries an attachment. An attachment means
   * the step changed pixels, and a filter or a brush stroke usually changes nothing else: the
   * manifest is the same document with the same layers, and comparing it would drop the step and
   * with it the only record of what the pixels used to be.
   */
  commit(current: S, changed?: (before: S, after: S) => boolean): boolean {
    const pending = this.pending
    this.pending = null
    if (!pending) return false
    const differs = changed
      ? changed(pending.state, current)
      : pending.attachment !== null || !sameJson(pending.state, current)
    if (!differs) return false
    this.past.push(pending)
    this.trim()
    this.future = []
    return true
  }

  /**
   * Drops the oldest steps until the stack fits.
   *
   * The newest step is never dropped, however big it is: dropping it would leave a step that cannot
   * be undone at all, which is what the editor did before any of this existed — and the alternative,
   * keeping a step whose pixels were thrown away, is a half-undo, which is worse than either.
   */
  private trim(): void {
    while (this.past.length > this.limit) this.past.shift()
    const bytesOf = this.bytesOf
    if (!bytesOf || this.byteLimit === Number.POSITIVE_INFINITY) return
    let total = this.attachmentBytes
    while (this.past.length > 1 && total > this.byteLimit) {
      const dropped = this.past.shift()
      if (dropped?.attachment) total -= bytesOf(dropped.attachment)
    }
  }

  /** Abandons an open edit without recording it. */
  cancel(): void {
    this.pending = null
  }

  /**
   * Steps back.
   *
   * Answers with the state *and* the attachment that belong to the step being left. The caller hands
   * over the attachment it holds on the way in, because the pixels as they are now are what a redo
   * would have to come back to.
   */
  undo(
    current: S,
    currentAttachment: A | null = null,
  ): { state: S; attachment: A | null } | null {
    const entry = this.past.pop()
    if (!entry) return null
    this.future.push({ label: entry.label, state: this.clone(current), attachment: currentAttachment })
    return { state: entry.state, attachment: entry.attachment }
  }

  /** Steps forward, on the same terms as `undo`. */
  redo(
    current: S,
    currentAttachment: A | null = null,
  ): { state: S; attachment: A | null } | null {
    const entry = this.future.pop()
    if (!entry) return null
    this.past.push({ label: entry.label, state: this.clone(current), attachment: currentAttachment })
    return { state: entry.state, attachment: entry.attachment }
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
