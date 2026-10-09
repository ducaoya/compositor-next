/**
 * Update checks: what a version means, and which release a manifest offers.
 *
 * The installation half belongs to the shell — Tauri's updater downloads a bundle and checks its
 * signature against a public key compiled into the app — but the decision half is here, because
 * "is this newer" is the part with edge cases and the part worth testing without a network. A
 * version comparison that treats 0.10.0 as older than 0.9.0 (string ordering) or 1.0.0 as newer than
 * 1.0.0-rc.1 (ignoring the pre-release) is how an update prompt ends up wrong in exactly the cases
 * that matter.
 *
 * The versioning is semver's, which is what Tauri's updater speaks.
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** The pre-release identifiers, empty for a release. */
  pre: string[]
}

/**
 * A version string read as its parts.
 *
 * A leading `v` is accepted because release tags have one and the manifest does not, and the build
 * metadata after a `+` is dropped because it never affects precedence — two builds of the same
 * version are the same release as far as an update is concerned.
 */
export function parseVersion(text: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  }
}

/** A pre-release identifier compared the way semver compares them: numbers before names. */
function comparePre(a: string, b: string): number {
  const numericA = /^\d+$/.test(a)
  const numericB = /^\d+$/.test(b)
  if (numericA && numericB) return Number(a) - Number(b)
  if (numericA) return -1
  if (numericB) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The order of two versions: negative when `a` is older, positive when it is newer, zero when they
 * are the same release.
 *
 * A pre-release is *older* than the release it leads to, which is semver's rule and the one that
 * matters most here: an app running 1.2.0-rc.1 should be offered 1.2.0, and an app running 1.2.0
 * should not be offered 1.2.0-rc.2 as an upgrade.
 *
 * Two strings that do not parse are compared as strings, which is wrong but is only reachable if the
 * manifest itself is wrong; the caller checks that a version parses before it uses the answer.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return a < b ? -1 : a > b ? 1 : 0
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  // A release outranks its own pre-releases; two pre-releases are compared identifier by identifier,
  // and the shorter one is older when everything before it matches (1.0.0-rc is older than -rc.1).
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const one = left.pre[index]
    const other = right.pre[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    const order = comparePre(one, other)
    if (order !== 0) return order
  }
  return 0
}

/** One release as an update manifest describes it. */
export interface UpdateRelease {
  version: string
  notes?: string
  /** Where the bundle is, by platform key (`windows-x86_64` and friends). */
  platforms?: Record<string, { url: string; signature?: string }>
}

/** A release the app should offer, or null when there is nothing newer. */
export function newerRelease(
  releases: readonly UpdateRelease[],
  current: string,
): UpdateRelease | null {
  let best: UpdateRelease | null = null
  for (const release of releases) {
    if (!parseVersion(release.version)) continue
    if (compareVersions(release.version, current) <= 0) continue
    if (!best || compareVersions(release.version, best.version) > 0) best = release
  }
  return best
}

/** The bundle for this platform, or null when the release does not carry one. */
export function bundleFor(
  release: UpdateRelease,
  platform: string,
): { url: string; signature?: string } | null {
  return release.platforms?.[platform] ?? null
}

/**
 * This platform's key in an update manifest.
 *
 * Tauri names them `windows-x86_64`, `darwin-aarch64`, `linux-x86_64` and so on, and the webview
 * can only guess from its own user agent. A guess that is wrong produces a "no update for you"
 * rather than the wrong download, because nothing is installed without a bundle whose platform key
 * matched.
 */
export function platformKey(userAgent: string): string {
  const windows = /Windows/i.test(userAgent)
  const mac = /Macintosh|Mac OS X/i.test(userAgent)
  const linux = /Linux|X11/i.test(userAgent)
  const arm = /aarch64|arm64|ARM/i.test(userAgent)
  if (windows) return 'windows-x86_64'
  if (mac) return arm ? 'darwin-aarch64' : 'darwin-x86_64'
  if (linux) return arm ? 'linux-aarch64' : 'linux-x86_64'
  return 'unknown'
}
