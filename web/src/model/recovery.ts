/**
 * Autosave and recovery: when a snapshot is due, and what a snapshot is called.
 *
 * The shell does the writing — a snapshot is an ordinary `.comp` package in the app's data folder —
 * and this is the part worth testing without a filesystem: how long a document has to be quiet
 * before it is snapshotted, how often snapshots are allowed, and what a recovered document is
 * offered as.
 */

/** A snapshot, as the shell describes it over IPC. */
export interface RecoveryEntry {
  /** The project it came from, empty when that document was never saved. */
  origin: string
  /** The tab it belonged to, which is what identifies a snapshot of an unsaved document. */
  document: string
  /** What to offer it as. */
  name: string
  /** Unix milliseconds, when it was written. */
  savedAt: number
  /** The app version that wrote it. */
  appVersion: string
  /** The `.comp` inside the recovery folder, which opens like any project. */
  target: string
}

/**
 * How long a document must be untouched before an autosave.
 *
 * A pause is the signal that a thought is finished; snapshotting mid-drag would write a document
 * nobody meant to keep and spend the encode time on every dab.
 */
export const AUTOSAVE_QUIET_MS = 5_000

/**
 * The shortest gap between two autosaves.
 *
 * The quiet time alone is not enough: a document edited in bursts is *always* quiet at the instant
 * the timer fires, so without a floor a long session of steady work would encode every surface
 * every two seconds.
 */
export const AUTOSAVE_MIN_GAP_MS = 30_000

export interface AutosaveInput {
  /** Whether there is anything that is not on disk. */
  dirty: boolean
  /** Now, in milliseconds. */
  now: number
  /** When the document last changed. */
  changedAt: number
  /** When it was last snapshotted, or when it was opened if it never was. */
  autosavedAt: number
}

/** Whether a document should be snapshotted now. */
export function autosaveDue(input: AutosaveInput): boolean {
  if (!input.dirty) return false
  if (input.now - input.changedAt < AUTOSAVE_QUIET_MS) return false
  return input.now - input.autosavedAt >= AUTOSAVE_MIN_GAP_MS
}

/**
 * What a snapshot is offered as.
 *
 * The name the shell recorded is the document's own name, and a project's file name is the same
 * thing said from the other side; the last resort names the fact that it has never been saved,
 * which is the one case where a file name would be a lie.
 */
export function recoveryLabel(entry: RecoveryEntry): string {
  if (entry.name.trim()) return entry.name
  if (entry.origin.trim()) return entry.origin.split(/[\\/]/).pop() ?? entry.origin
  return 'Untitled.comp'
}
