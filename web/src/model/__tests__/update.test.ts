import { describe, expect, it } from 'vitest'

import {
  NOT_DOWNLOADING,
  applyDownloadEvent,
  bundleFor,
  compareVersions,
  downloadPercent,
  newerRelease,
  parseVersion,
  platformKey,
} from '../update'

describe('reading a version', () => {
  it('takes the parts a release has', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] })
    expect(parseVersion('v0.10.0')).toEqual({ major: 0, minor: 10, patch: 0, pre: [] })
    expect(parseVersion('2.0.0-rc.1')?.pre).toEqual(['rc', '1'])
  })

  it('drops build metadata, which never decides precedence', () => {
    expect(parseVersion('1.2.3+build.47')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] })
    expect(compareVersions('1.2.3+a', '1.2.3+b')).toBe(0)
  })

  it('refuses what is not a version rather than guessing', () => {
    for (const text of ['1.2', 'one.two.three', '1.2.3.4', '', 'v']) {
      expect(parseVersion(text), text).toBeNull()
    }
  })
})

describe('the order of two versions', () => {
  it('compares numbers rather than text, which is the whole point', () => {
    // The bug this exists to prevent: as strings, "0.10.0" sorts before "0.9.0".
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('treats a release as newer than its own pre-releases', () => {
    expect(compareVersions('1.2.0', '1.2.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBeLessThan(0)
    expect(compareVersions('1.2.0-rc.2', '1.2.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0-alpha', '1.2.0-beta')).toBeLessThan(0)
    // A numeric identifier is older than a named one, and a shorter set is older when the rest match.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBeLessThan(0)
  })

  it('ignores a leading v, because a tag has one and a manifest does not', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })
})

describe('which release to offer', () => {
  const releases = [
    { version: '0.1.0', notes: 'the current one' },
    { version: '0.2.0', notes: 'newer', platforms: { 'windows-x86_64': { url: 'https://example/a', signature: 'sig' } } },
    { version: '0.3.0-rc.1', notes: 'a pre-release', platforms: { 'windows-x86_64': { url: 'https://example/b' } } },
    { version: 'not a version' },
  ]

  it('picks the highest version above the current one', () => {
    // 0.3.0-rc.1 is ahead of 0.2.0, and ahead of the release it leads to only in the sense that it
    // exists: the ranking is the version's, not the list's order.
    expect(newerRelease(releases, '0.1.0')?.version).toBe('0.3.0-rc.1')
    expect(newerRelease([{ version: '0.1.5' }, { version: '0.2.0' }], '0.1.0')?.version).toBe('0.2.0')
  })

  it('offers nothing when the app is already the newest', () => {
    expect(newerRelease(releases, '0.3.0')).toBeNull()
    expect(newerRelease(releases, '0.4.0')).toBeNull()
  })

  it('does not offer a pre-release as news to the release it belongs to', () => {
    // A running 0.2.0 has a 0.3.0-rc.1 ahead of it, which is newer, so it is offered; a running
    // 0.3.0 has nothing.
    expect(newerRelease(releases, '0.2.0')?.version).toBe('0.3.0-rc.1')
    expect(newerRelease(releases, '0.3.0')).toBeNull()
  })

  it('ignores a release whose version cannot be read at all', () => {
    const result = newerRelease([{ version: 'not a version' }], '0.1.0')
    expect(result).toBeNull()
  })

  it('finds the bundle for this platform, and says so when there is none', () => {
    const release = releases[1]
    expect(bundleFor(release, 'windows-x86_64')?.url).toBe('https://example/a')
    expect(bundleFor(release, 'darwin-aarch64')).toBeNull()
    expect(bundleFor(releases[0], 'windows-x86_64')).toBeNull()
  })
})

describe("this platform's key", () => {
  it('names the three the app builds for', () => {
    expect(platformKey('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows-x86_64')
    expect(platformKey('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('darwin-x86_64')
    expect(platformKey('Mozilla/5.0 (Macintosh; ARM Mac OS X 11_0)')).toBe('darwin-aarch64')
    expect(platformKey('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux-x86_64')
  })

  it('says unknown rather than guessing, so nothing is installed by accident', () => {
    expect(platformKey('something else entirely')).toBe('unknown')
  })
})

describe('a download in progress', () => {
  it('counts the bytes each event reports', () => {
    let state = applyDownloadEvent(NOT_DOWNLOADING, { event: 'Started', data: { contentLength: 1000 } })
    expect(state).toEqual({ received: 0, total: 1000, finished: false })
    state = applyDownloadEvent(state, { event: 'Progress', data: { chunkLength: 250 } })
    state = applyDownloadEvent(state, { event: 'Progress', data: { chunkLength: 250 } })
    expect(state.received).toBe(500)
    expect(state.total).toBe(1000)
    expect(downloadPercent(state)).toBe(50)
    state = applyDownloadEvent(state, { event: 'Finished' })
    expect(state).toEqual({ received: 500, total: 1000, finished: true })
  })

  it('keeps the length when a progress event does not repeat it', () => {
    let state = applyDownloadEvent(NOT_DOWNLOADING, { event: 'Started', data: { contentLength: 400 } })
    state = applyDownloadEvent(state, { event: 'Progress', data: { chunkLength: 100 } })
    expect(state.total).toBe(400)
    expect(downloadPercent(state)).toBe(25)
  })

  it('has no percentage to report when the server never said how big the bundle is', () => {
    let state = applyDownloadEvent(NOT_DOWNLOADING, { event: 'Started' })
    state = applyDownloadEvent(state, { event: 'Progress', data: { chunkLength: 100 } })
    expect(state.total).toBeNull()
    // Not zero: a bar stuck at zero looks like a failure rather than an unmeasured download.
    expect(downloadPercent(state)).toBeNull()
    state = applyDownloadEvent(state, { event: 'Finished' })
    expect(state.total).toBe(100)
    expect(downloadPercent(state)).toBe(100)
  })

  it('rounds and never reports more than all of it', () => {
    expect(downloadPercent({ received: 1, total: 3, finished: false })).toBe(33)
    // A server that under-reports its length must not make the bar read 140%.
    expect(downloadPercent({ received: 140, total: 100, finished: false })).toBe(100)
    expect(downloadPercent({ received: 0, total: 0, finished: false })).toBeNull()
  })
})
