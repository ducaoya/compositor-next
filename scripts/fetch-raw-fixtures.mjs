#!/usr/bin/env node
/**
 * Downloads RAW files from raw.pixls.us into fixtures/raw.
 *
 *   node scripts/fetch-raw-fixtures.mjs                 # list the archive
 *   node scripts/fetch-raw-fixtures.mjs <filter> [...]  # download matches
 *
 * The site serves at roughly 37 KB/s, so this writes progress to stderr as it goes and is meant to
 * be run in the background: a modern 30 MB RAW is a fifteen-minute download, and a silent
 * fifteen-minute command looks exactly like a hung one.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'

const LISTING = 'https://raw.pixls.us/json/getrepository.php?set=all'
const OUTPUT = new URL('../fixtures/raw/', import.meta.url).pathname.replace(/^\//, '')

const filters = process.argv.slice(2).map((value) => value.toLowerCase())

/** The download link and file name out of the listing's HTML cell. */
function describe(row) {
  const match = /href='([^']+)'/.exec(String(row[7] ?? ''))
  if (!match) return null
  const url = match[1]
  const name = basename(decodeURIComponent(new URL(url).pathname))
  return { url, name, camera: `${row[0]} ${row[1]}`, megapixels: row[3] }
}

console.error('fetching the archive listing…')
const response = await fetch(LISTING)
if (!response.ok) throw new Error(`listing failed: ${response.status}`)
const listing = await response.json()
const entries = listing.data.map(describe).filter(Boolean)
console.error(`${entries.length} files in the archive`)

if (filters.length === 0) {
  const byCamera = new Map()
  for (const entry of entries) {
    if (!byCamera.has(entry.camera)) byCamera.set(entry.camera, entry)
  }
  for (const entry of [...byCamera.values()].slice(0, 60)) {
    console.log(`${String(entry.megapixels).padStart(7)} MP  ${entry.camera.padEnd(34)} ${entry.name}`)
  }
  console.log(`\n${byCamera.size} cameras. Pass a filter to download, e.g. "sony a7r".`)
  process.exit(0)
}

await mkdir(OUTPUT, { recursive: true })
for (const entry of entries) {
  const haystack = `${entry.camera} ${entry.name}`.toLowerCase()
  if (!filters.some((filter) => haystack.includes(filter))) continue
  const target = join(OUTPUT, entry.name.replace(/[^\w.\-]+/g, '_'))
  process.stderr.write(`\n${entry.name}\n`)
  const started = Date.now()
  const response = await fetch(entry.url)
  if (!response.ok || !response.body) {
    process.stderr.write(`  failed: ${response.status}\n`)
    continue
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  let seen = 0
  let lastReport = 0
  const stream = Readable.fromWeb(response.body)
  stream.on('data', (chunk) => {
    seen += chunk.length
    // A line every two seconds, so a long transfer is visibly alive.
    if (Date.now() - lastReport > 2000) {
      lastReport = Date.now()
      const percent = total ? ((seen / total) * 100).toFixed(0) : '?'
      process.stderr.write(`\r  ${(seen / 1e6).toFixed(2)} MB of ${(total / 1e6).toFixed(2)} (${percent}%)`)
    }
  })
  await finished(stream.pipe(createWriteStream(target)))
  const seconds = ((Date.now() - started) / 1000).toFixed(0)
  process.stderr.write(`\r  ${(seen / 1e6).toFixed(2)} MB in ${seconds}s\n`)
}
