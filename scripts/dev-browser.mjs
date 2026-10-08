#!/usr/bin/env node
/**
 * Starts a headless Chrome with remote debugging, for scripted checks.
 *
 * Headless on purpose: a debugging browser that takes the foreground every time it navigates is a
 * debugging browser nobody runs. `--enable-unsafe-swiftshader` gives it a software Vulkan device,
 * so WebGPU works without a display.
 *
 *   node scripts/dev-browser.mjs          # start (or report the one already running)
 *   node scripts/dev-browser.mjs --stop
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PORT = 9222
const PROFILE = join(homedir(), '.cache', 'compositor-dev-browser')

function chromePath() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

async function running() {
  try {
    const response = await fetch(`http://localhost:${PORT}/json/version`)
    return response.ok
  } catch {
    return false
  }
}

if (process.argv.includes('--stop')) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore' })
  } else {
    spawnSync('pkill', ['-f', `remote-debugging-port=${PORT}`], { stdio: 'ignore' })
  }
  console.log('stopped')
  process.exit(0)
}

if (await running()) {
  console.log(`✓ a debugging Chrome is already on :${PORT}`)
  process.exit(0)
}

const chrome = chromePath()
if (!chrome) {
  console.error('Chrome was not found.')
  process.exit(1)
}

mkdirSync(PROFILE, { recursive: true })

spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    // A software Vulkan device, so WebGPU comes up without a display or a real GPU.
    '--enable-unsafe-swiftshader',
    '--window-size=1440,900',
    'about:blank',
  ],
  { detached: true, stdio: 'ignore', windowsHide: true },
).unref()

for (let attempt = 0; attempt < 30; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (await running()) {
    console.log(`✓ headless Chrome listening on :${PORT}`)
    process.exit(0)
  }
}
console.error('Chrome did not come up.')
process.exit(1)
