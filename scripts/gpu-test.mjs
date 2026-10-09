/**
 * Pixel tests for the renderer.
 *
 * The Rust side has had tests from the start; the GPU side had none, and that is why a whole
 * feature could be measured as broken for an afternoon when it was working. Every measurement then
 * came from a hand-written probe that rendered and read the frame back while the canvas's own loop
 * was still drawing, so a second frame could land in between and the readback described a different
 * document.
 *
 * These run against a running dev build: headless Chrome on :9222 and Vite on :1420. Start them with
 * `node scripts/dev-browser.mjs` and `pnpm dev` (or `pnpm tauri dev`).
 *
 * Assertions happen inside the page and only small verdicts come back, because a frame is two and a
 * half million numbers and sending one over the wire per check is not a test, it is a transfer.
 *
 *   node scripts/gpu-test.mjs            # every case
 *   node scripts/gpu-test.mjs invert     # cases whose name contains "invert"
 */
const CDP_PORT = 9222
const APP = 'http://localhost:1420/'

/** Everything the probes share: the readback, the sampling, and adding an adjustment where it counts. */
const PRELUDE = `
  const s = window.__compositor
  const wait = (n) => new Promise((r) => setTimeout(r, n || 400))
  const at = (f, x, y) => { const i = (y * f.width + x) * 4; return [f.data[i], f.data[i + 1], f.data[i + 2]] }
  const changed = (a, b) => {
    let n = 0
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n += 1
    }
    return n
  }
  const saturation = (f, x, y) => {
    const [r, g, b] = at(f, x, y).map((v) => v / 255)
    const hi = Math.max(r, g, b); const lo = Math.min(r, g, b)
    return hi === lo ? 0 : (hi - lo) / (1 - Math.abs(hi + lo - 1))
  }
  /** The hue of a pixel in degrees, so a rotation can be measured rather than assumed. */
  const hueOf = (f, x, y) => {
    const [r, g, b] = at(f, x, y).map((v) => v / 255)
    const hi = Math.max(r, g, b); const lo = Math.min(r, g, b)
    if (hi === lo) return 0
    const delta = hi - lo
    let hue = hi === r ? (g - b) / delta : hi === g ? (b - r) / delta + 2 : (r - g) / delta + 4
    hue *= 60
    return hue < 0 ? hue + 360 : hue
  }
  const meanLuma = (f) => {
    let total = 0
    for (let i = 0; i < f.data.length; i += 4) total += 0.3 * f.data[i] + 0.59 * f.data[i + 1] + 0.11 * f.data[i + 2]
    return total / (f.data.length / 4)
  }
  /** How much neighbouring pixels differ, which is what a blur removes. */
  const roughness = (f, x, y) => {
    let total = 0
    for (let row = 0; row < 24; row += 1) {
      for (let column = 0; column < 24; column += 1) {
        const here = at(f, x + column, y + row)
        const next = at(f, x + column + 1, y + row)
        total += Math.abs(here[0] - next[0]) + Math.abs(here[1] - next[1]) + Math.abs(here[2] - next[2])
      }
    }
    return total / 576
  }
  /**
   * The first \`count\` pixels whose hue passes \`test\`, sampled on a grid.
   *
   * A colour-range case has to know where its colours are, and hand-picked coordinates were wrong:
   * the old "blues" were magenta, so the case measured the wrong pixels and reported a working
   * feature as broken. Finding them by hue means the case states its own precondition instead of
   * trusting a coordinate nobody re-checked.
   */
  const findByHue = (f, test, count, minSaturation) => {
    const found = []
    for (let y = 0; y < f.height; y += 3) {
      for (let x = 0; x < f.width; x += 3) {
        if (saturation(f, x, y) < (minSaturation ?? 0.3)) continue
        if (!test(hueOf(f, x, y))) continue
        found.push([x, y])
        if (found.length >= count) return found
      }
    }
    return found
  }
  const same = (f, g, [x, y]) => at(f, x, y).join() === at(g, x, y).join()

  /**
   * Adds an adjustment above the topmost layer.
   *
   * \`addAdjustment\` inserts above the *active* layer, which is where Photoshop puts it and where a
   * test must not leave it: four layers above it would hide all but about half the canvas, and a
   * feature that works would look broken.
   */
  const freshDocument = async () => {
    await s.openProject()
    await wait(2400)
    return s.renderAndRead()
  }
  const addAtTop = async (kind) => {
    const top = s.manifest.layers[s.manifest.layers.length - 1]
    s.selectLayer(top.id)
    const ids = new Set(s.manifest.layers.map((l) => l.id))
    s.addAdjustment(kind)
    await wait(600)
    return s.manifest.layers.find((l) => !ids.has(l.id))
  }
  const setup = async (kind, mutate) => {
    const before = await freshDocument()
    const coloured = saturation(before, 480, 320) > 0.5
    const added = await addAtTop(kind)
    if (!added || !added.adjustment) return { precondition: coloured, error: 'the adjustment was not added' }
    if (mutate) { mutate(added.adjustment); await wait(600) }
    const after = await s.renderAndRead()
    return { precondition: coloured, before, after, added, kind: added.adjustment.kind }
  }
`

const CASES = [
  {
    name: 'the fixture renders in colour',
    // Without this the rest are meaningless: every earlier false reading came from measuring a
    // canvas that was not in the state the test assumed.
    probe: `(async () => { ${PRELUDE}
      const frame = await freshDocument()
      const sample = at(frame, 480, 320)
      return {
        pass: frame.width === 960 && frame.height === 640 && saturation(frame, 480, 320) > 0.5,
        detail: { size: [frame.width, frame.height], sample, saturation: Math.round(saturation(frame, 480, 320) * 100) / 100 },
      }
    })()`,
  },
  {
    name: 'invert inverts every pixel',
    probe: `(async () => { ${PRELUDE}
      const r = await setup('Invert')
      if (r.error) return { pass: false, detail: r }
      const count = changed(r.before, r.after)
      const samples = [[480, 320], [200, 300], [700, 400]].map(([x, y]) => {
        const b = at(r.before, x, y); const a = at(r.after, x, y)
        return { at: [x, y], before: b, after: a, exact: b.every((v, i) => a[i] === 255 - v) }
      })
      return {
        pass: count > 500000 && samples.every((s) => s.exact),
        detail: { precondition: r.precondition, changed: count, samples },
      }
    })()`,
  },
  {
    name: 'exposure brightens',
    probe: `(async () => { ${PRELUDE}
      const r = await setup('Exposure', (a) => { a.exposureSettings = { exposure: 1.5, offset: 0, gamma: 1 } })
      if (r.error) return { pass: false, detail: r }
      const before = meanLuma(r.before); const after = meanLuma(r.after)
      return {
        pass: after > before + 10,
        detail: { precondition: r.precondition, meanBefore: Math.round(before * 10) / 10, meanAfter: Math.round(after * 10) / 10, changed: changed(r.before, r.after) },
      }
    })()`,
  },
  {
    name: 'hue rotates the whole wheel',
    probe: `(async () => { ${PRELUDE}
      const r = await setup('Hue/Saturation', (a) => {
        a.hsvSettings = { hue: 60, saturation: 0, lightness: 0, colorize: false }
      })
      if (r.error) return { pass: false, detail: r }
      // The rotation is the assertion, not the change count: a canvas that went black also
      // "changed", and an earlier version of this case passed on exactly that.
      const spots = [[480, 320], [200, 300], [700, 400]]
      const rotations = spots.map(([x, y]) => {
        const delta = (hueOf(r.after, x, y) - hueOf(r.before, x, y) + 360) % 360
        return { at: [x, y], before: at(r.before, x, y), after: at(r.after, x, y), rotated: Math.round(delta) }
      })
      return {
        pass: rotations.every((s) => Math.abs(s.rotated - 60) <= 6),
        detail: { precondition: r.precondition, changed: changed(r.before, r.after), rotations },
      }
    })()`,
  },
  {
    name: 'a colour range moves only its own hues',
    // The whole point of the bands: one family of colours moves, the rest of the frame is
    // byte-identical, and the master covers everything. The pixels are found by hue and the case
    // checks it found some, because a range test with no pixels of that range in it proves nothing
    // whichever way it reports.
    //
    // The fixture is a magenta-and-pink composition with a dark blue underneath: its magentas sit
    // at 292…308, on the magentas band's plateau, and its blues at 226…254, which the magentas band
    // — 255…345 with its falloff — does not reach at all. Those are the two families this measures.
    // The case reports the coverage it found rather than assuming a coordinate, because the earlier
    // version of it measured magenta pixels it had called blue and reported a working feature broken.
    probe: `(async () => { ${PRELUDE}
      const before = await freshDocument()
      const magentas = findByHue(before, (h) => h >= 292 && h <= 308, 8, 0.12)
      const blues = findByHue(before, (h) => h >= 226 && h <= 254, 8, 0.12)
      if (magentas.length < 4 || blues.length < 4) {
        return { pass: false, detail: { error: 'the fixture has neither magentas nor blues to measure', magentas, blues } }
      }
      const added = await addAtTop('Hue/Saturation')
      if (!added || !added.adjustment) return { pass: false, detail: { error: 'the adjustment was not added' } }

      // One range, nothing else: the magentas rotate and the blues do not move at all.
      added.adjustment.hsvSettings = { hue: 0, saturation: 0, lightness: 0, colorize: false, adjustments: { magentas: { hue: 60 } } }
      await wait(600)
      const ranged = await s.renderAndRead()
      const moved = magentas.filter((p) => !same(before, ranged, p)).length
      const untouched = blues.filter((p) => same(before, ranged, p)).length
      const rotations = magentas.slice(0, 3).map((p) => ({
        at: p,
        before: at(before, p[0], p[1]),
        after: at(ranged, p[0], p[1]),
        rotated: Math.round((hueOf(ranged, p[0], p[1]) - hueOf(before, p[0], p[1]) + 360) % 360),
      }))

      // The master claims every hue, so the blues move too.
      added.adjustment.hsvSettings = { hue: 60, saturation: 0, lightness: 0, colorize: false }
      await wait(600)
      const mastered = await s.renderAndRead()
      const masteredBlues = blues.filter((p) => !same(before, mastered, p)).length

      // An empty table is nothing at all, so the frame has to come back byte for byte — the
      // strongest statement the encoder can make, and the one the old half-byte offset broke.
      added.adjustment.hsvSettings = { hue: 0, saturation: 0, lightness: 0, colorize: false }
      await wait(600)
      const restored = await s.renderAndRead()
      const restoredChanged = changed(before, restored)

      return {
        pass: moved === magentas.length
          && untouched === blues.length
          && rotations.every((point) => Math.abs(point.rotated - 60) <= 6)
          && masteredBlues === blues.length
          && restoredChanged === 0,
        detail: {
          ofMagentas: magentas.length,
          moved,
          ofBlues: blues.length,
          untouched,
          bluesAfterTheMaster: masteredBlues,
          changedByTheRange: changed(before, ranged),
          pixelsChangedAfterTheTableWasEmptied: restoredChanged,
          rotations,
        },
      }
    })()`,
  },
  {
    name: 'gaussian blur smooths',
    probe: `(async () => { ${PRELUDE}
      const r = await setup('Gaussian Blur', (a) => { a.blurRadius = 24 })
      if (r.error) return { pass: false, detail: r }
      const before = roughness(r.before, 300, 200); const after = roughness(r.after, 300, 200)
      return {
        pass: after < before * 0.7,
        detail: { precondition: r.precondition, roughnessBefore: Math.round(before * 100) / 100, roughnessAfter: Math.round(after * 100) / 100, changed: changed(r.before, r.after) },
      }
    })()`,
  },
]

// MARK: - A very small CDP client

async function pageTarget() {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
  const pages = await response.json()
  const page = pages.find((p) => p.type === 'page' && p.url.startsWith(APP)) ?? pages.find((p) => p.type === 'page')
  if (!page) throw new Error('no page to drive')
  return page
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let next = 1
    const waiting = new Map()
    socket.addEventListener('open', () =>
      resolve({
        send(method, params) {
          const id = next++
          socket.send(JSON.stringify({ id, method, params }))
          return new Promise((done, fail) => waiting.set(id, { done, fail }))
        },
        close: () => socket.close(),
      }),
    )
    socket.addEventListener('error', reject)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = waiting.get(message.id)
      if (!entry) return
      waiting.delete(message.id)
      if (message.error) entry.fail(new Error(message.error.message))
      else entry.done(message.result)
    })
  })
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'the probe threw')
  }
  return result.result.value
}

async function navigate(client, url) {
  // A cache-busting query, because navigating to the URL a page is already on is not a reload: the
  // module state survives, and a document a previous case left open is mistaken for a clean one.
  await client.send('Page.navigate', { url: `${url}?case=${Date.now()}` })
  // The app has to have attached its debug handle before a probe can mean anything.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((r) => setTimeout(r, 500))
    // The handle exists as soon as the app mounts; its manifest stays null until a document opens,
    // so readiness is the handle and the readback being there.
    const ready = await evaluate(client, "Boolean(window.__compositor && typeof window.__compositor.renderAndRead === 'function')")
    if (ready) return
  }
  throw new Error('the app never became ready')
}

// MARK: - Run

const filter = process.argv[2]
const selected = filter ? CASES.filter((c) => c.name.includes(filter)) : CASES

let client
try {
  const page = await pageTarget()
  client = await connect(page.webSocketDebuggerUrl)
} catch (error) {
  console.error(`could not reach headless Chrome on :${CDP_PORT} — start it with: node scripts/dev-browser.mjs`)
  console.error(String(error.message ?? error))
  process.exit(2)
}

if (selected.length === 0) {
  console.error(`no case matches "${filter}"`)
  client.close()
  process.exit(2)
}

let failed = 0
for (const testCase of selected) {
  // A fresh navigation per case, so nothing a previous case left in the page can be mistaken for
  // this one's subject.
  await navigate(client, APP)
  const started = Date.now()
  try {
    const result = await evaluate(client, testCase.probe)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (result.pass) {
      console.log(`  ok   ${testCase.name}  (${seconds}s)`)
      console.log(`       ${JSON.stringify(result.detail)}`)
    } else {
      failed += 1
      console.log(`  FAIL ${testCase.name}  (${seconds}s)`)
      console.log(`       ${JSON.stringify(result.detail)}`)
    }
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${testCase.name}`)
    console.log(`       ${String(error.message ?? error).split('\n')[0]}`)
  }
}

client.close()
console.log(`\n${selected.length - failed}/${selected.length} passed`)
process.exit(failed === 0 ? 0 : 1)
