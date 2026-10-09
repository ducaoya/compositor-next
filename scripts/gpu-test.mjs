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
  const findByHue = (f, test, count, minSaturation, inset) => {
    const found = []
    const margin = inset ?? 0
    for (let y = margin; y < f.height - margin; y += 3) {
      for (let x = margin; x < f.width - margin; x += 3) {
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
   * A rectangle, as \`[x, y, width, height]\`, and whether everything outside it is byte-identical.
   *
   * Every retouch case needs both halves of this: the tool did something inside the stroke, and
   * nothing at all outside it. A tool that quietly repainted the whole layer would pass the first
   * half on its own.
   */
  const rectOf = (r) => ({ x: r[0], y: r[1], width: r[2], height: r[3] })
  const changedInside = (before, after, rect) => {
    let n = 0
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        if (at(before, x, y).join() !== at(after, x, y).join()) n += 1
      }
    }
    return n
  }
  const changedOutside = (before, after, rect) => {
    let n = 0
    for (let y = 0; y < before.height; y += 1) {
      for (let x = 0; x < before.width; x += 1) {
        if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) continue
        if (at(before, x, y).join() !== at(after, x, y).join()) n += 1
      }
    }
    return n
  }
  /** Mean luma of a rectangle, for the tone tools. */
  const rectLuma = (f, rect) => {
    let total = 0
    let n = 0
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const [r, g, b] = at(f, x, y)
        total += 0.3 * r + 0.59 * g + 0.11 * b
        n += 1
      }
    }
    return total / n
  }
  const rectSaturation = (f, rect) => {
    let total = 0
    let n = 0
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        total += saturation(f, x, y)
        n += 1
      }
    }
    return total / n
  }
  /** How much neighbouring pixels differ inside a rectangle, which is what a blur removes. */
  const rectRoughness = (f, rect) => {
    let total = 0
    let n = 0
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const here = at(f, x, y)
        const next = at(f, x + 1, y)
        const below = at(f, x, y + 1)
        total += Math.abs(here[0] - next[0]) + Math.abs(here[1] - next[1]) + Math.abs(here[2] - next[2])
        total += Math.abs(here[0] - below[0]) + Math.abs(here[1] - below[1]) + Math.abs(here[2] - below[2])
        n += 2
      }
    }
    return total / n
  }

  /**
   * The rectangle with the most neighbouring-pixel detail.
   *
   * The fixture is a mostly flat composition, so a smoothing case that guessed a coordinate measured
   * a flat patch and found that blurring it changed almost nothing. Finding the detail means the
   * case states its own precondition.
   */
  const roughestRect = (f, side) => {
    let best = { x: 8, y: 8, width: side, height: side }
    let bestScore = -1
    // Inset by eight pixels so a stroke over the centre of the window is not clipped by the frame,
    // which would make "the brush changed something" false for a reason that has nothing to do with
    // the brush.
    for (let y = 8; y + side < f.height - 8; y += Math.max(1, Math.floor(side / 2))) {
      for (let x = 8; x + side < f.width - 8; x += Math.max(1, Math.floor(side / 2))) {
        const rect = { x, y, width: side, height: side }
        const score = rectRoughness(f, rect)
        if (score > bestScore) {
          bestScore = score
          best = rect
        }
      }
    }
    return { rect: best, score: bestScore }
  }
  /**
   * The rectangle with the least neighbouring-pixel detail.
   *
   * A spot heal is measurable where there is something flat around the spot to heal *from*: heal
   * into a busy patch and the result is honest but there is no single right answer to compare it
   * with.
   */
  const flattestRect = (f, side) => {
    let best = { x: 8, y: 8, width: side, height: side }
    let bestScore = Infinity
    for (let y = 8; y + side < f.height - 8; y += Math.max(1, Math.floor(side / 2))) {
      for (let x = 8; x + side < f.width - 8; x += Math.max(1, Math.floor(side / 2))) {
        const rect = { x, y, width: side, height: side }
        const score = rectRoughness(f, rect)
        if (score < bestScore) {
          bestScore = score
          best = rect
        }
      }
    }
    return { rect: best, score: bestScore }
  }
  /** The mean colour of a rectangle, and of a band around it, which is what a heal has to match. */
  const rectColour = (f, rect) => {
    let red = 0
    let green = 0
    let blue = 0
    let n = 0
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const colour = at(f, x, y)
        red += colour[0]
        green += colour[1]
        blue += colour[2]
        n += 1
      }
    }
    return [red / n, green / n, blue / n]
  }
  const bandColour = (f, rect, margin) => {
    let red = 0
    let green = 0
    let blue = 0
    let n = 0
    for (let y = rect.y - margin; y < rect.y + rect.height + margin; y += 1) {
      for (let x = rect.x - margin; x < rect.x + rect.width + margin; x += 1) {
        if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) continue
        if (x < 0 || y < 0 || x >= f.width || y >= f.height) continue
        const colour = at(f, x, y)
        red += colour[0]
        green += colour[1]
        blue += colour[2]
        n += 1
      }
    }
    return n ? [red / n, green / n, blue / n] : null
  }
  const colourDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  /**
   * A point where the colour changes sharply \`span\` pixels to the right.
   *
   * A smudge is only measurable across a boundary: dragging inside one flat colour has nothing to
   * drag, and the first version of that case measured exactly that and reported nothing happened.
   */
  const findEdge = (f, span, minimum) => {
    for (let y = 4; y < f.height - 4; y += 3) {
      for (let x = 4; x + span < f.width - 4; x += 3) {
        const here = at(f, x, y)
        const there = at(f, x + span, y)
        if (Math.hypot(here[0] - there[0], here[1] - there[1], here[2] - there[2]) >= (minimum ?? 60)) return [x, y]
      }
    }
    return null
  }
  const centreOf = (rect) => [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)]

  /**
   * A fresh document with only its bottom layer showing, which is what a retouch case needs.
   *
   * The fixture is twenty-five layers of blend modes stacked over each other, and a retouch stroke
   * paints on the *active* layer only. A stroke on any of them but the topmost is invisible in the
   * frame, so the first version of these cases reported that working tools did nothing. Hiding the
   * rest measures what the tool painted rather than what survived the stack; the bottom layer is
   * Normal, so nothing reinterprets the result. \`freshDocument\` reopens the project each time, so
   * the hidden layers never leak into another case.
   */
  const baseFrame = async () => {
    await freshDocument()
    const base = s.manifest.layers[0]
    s.selectLayer(base.id)
    for (const layer of s.manifest.layers) {
      if (layer.isGroup !== true && layer.id !== base.id) layer.isVisible = false
    }
    await wait(500)
    return s.renderAndRead()
  }

  /**
   * A retouch stroke, driven the way the canvas drives one: the tool selected, then a press, the
   * moves, and the release. Returns nothing — the caller reads the frame back.
   */
  const stroke = async (toolId, points) => {
    s.selectTool(toolId)
    s.beginRetouch(points[0][0], points[0][1], false)
    for (const point of points.slice(1)) {
      s.moveRetouch(point[0], point[1])
      await wait(30)
    }
    s.endRetouch()
    await wait(500)
  }
  const setBrush = (size, hardness, opacity) => {
    s.brush.size = size
    s.brush.hardness = hardness
    s.brush.opacity = opacity
  }

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
    name: 'moving a band moves a different family',
    // The band geometry is the panel's other half: Photoshop's blues start where the reference says
    // they start, but a project can move them, and the table has to follow. The blues band is moved
    // onto the fixtures magentas and the two families swap roles.
    probe: `(async () => { ${PRELUDE}
      const before = await freshDocument()
      const blues = findByHue(before, (h) => h >= 226 && h <= 254, 8, 0.12)
      const magentas = findByHue(before, (h) => h >= 292 && h <= 308, 8, 0.12)
      if (blues.length < 4 || magentas.length < 4) {
        return { pass: false, detail: { error: 'the fixture has neither blues nor magentas to measure', blues, magentas } }
      }
      const added = await addAtTop('Hue/Saturation')
      if (!added || !added.adjustment) return { pass: false, detail: { error: 'the adjustment was not added' } }

      // The blues band, exactly where Photoshop puts it: the blues move and the magentas do not.
      added.adjustment.hsvSettings = { hue: 0, saturation: 0, lightness: 0, colorize: false, adjustments: { blues: { hue: 60 } } }
      await wait(600)
      const shipped = await s.renderAndRead()
      const shippedBlues = blues.filter((p) => !same(before, shipped, p)).length
      const shippedMagentas = magentas.filter((p) => same(before, shipped, p)).length

      // Moved onto the magentas, with the band numbers the panel's edge editors write.
      added.adjustment.hsvSettings = {
        hue: 0,
        saturation: 0,
        lightness: 0,
        colorize: false,
        adjustments: { blues: { hue: 60 } },
        bands: { blues: { falloffStart: 285, rangeStart: 295, rangeEnd: 305, falloffEnd: 315 } },
      }
      await wait(600)
      const moved = await s.renderAndRead()
      const movedMagentas = magentas.filter((p) => !same(before, moved, p)).length
      const movedBlues = blues.filter((p) => same(before, moved, p)).length
      // 292 is a fifth of the way up the falloff and 300 is the middle of the plateau, so the
      // rotation runs from about 42 degrees to 60 rather than being one number.
      const rotations = magentas.slice(0, 3).map((p) =>
        Math.round((hueOf(moved, p[0], p[1]) - hueOf(before, p[0], p[1]) + 360) % 360),
      )

      return {
        pass: shippedBlues === blues.length
          && shippedMagentas === magentas.length
          && movedMagentas === magentas.length
          && movedBlues === blues.length
          && rotations.every((turned) => turned >= 38 && turned <= 66),
        detail: {
          ofBlues: blues.length,
          ofMagentas: magentas.length,
          bluesMovedWithTheShippedBand: shippedBlues,
          magentasUntouchedByTheShippedBand: shippedMagentas,
          magentasMovedWithTheBandOnThem: movedMagentas,
          bluesUntouchedOnceItMoved: movedBlues,
          rotations,
        },
      }
    })()`,
  },

  {
    name: 'clone stamp copies from where it was told to',
    // The source patch and the target patch both have to be a whole tip away from the frame's edge,
    // or the copy is "correctly" transparent where the source ran off the image — which is what the
    // first version of this case measured, and it looked like the tool was broken.
    probe: `(async () => { ${PRELUDE}
      const before = await baseFrame()
      const radius = 30
      setBrush(radius * 2, 1, 1)
      const inside = ([x, y]) => x >= radius + 2 && y >= radius + 2
        && x < before.width - radius - 2 && y < before.height - radius - 2
      // The inset keeps the scan away from the frame's edge, because a source or a target within a
      // tip of it cannot be copied whole — the patch would run off the image, which is correct
      // behaviour and useless as a measurement.
      const sources = findByHue(before, (h) => h >= 200 && h <= 235, 40, 0.3, radius + 4).filter(inside)
      const from = sources[0]
      const to = findByHue(before, (h) => h >= 10 && h <= 45, 40, 0.3, radius + 4)
        .filter(inside)
        .find((point) => from && Math.hypot(point[0] - from[0], point[1] - from[1]) > radius * 8)
      if (!from || !to) {
        return { pass: false, detail: { error: 'the fixture has no well-separated source and target', sources: sources.length } }
      }
      const source = at(before, from[0], from[1])

      s.setCloneSource(from[0], from[1])
      await stroke('clone', [to])
      const after = await s.renderAndRead()
      const painted = at(after, to[0], to[1])
      // The whole tip has to have been written, so the check rectangle covers it and nothing the
      // stroke touched can fall outside.
      const stamp = { x: to[0] - radius - 6, y: to[1] - radius - 6, width: radius * 2 + 12, height: radius * 2 + 12 }
      return {
        pass: changedInside(before, after, stamp) > 2000
          && changedOutside(before, after, stamp) === 0
          && painted.every((value, index) => Math.abs(value - source[index]) <= 2)
          && at(after, from[0], from[1]).join() === source.join(),
        detail: {
          source: { at: from, colour: source },
          target: { at: to, before: at(before, to[0], to[1]), after: painted },
          changedInside: changedInside(before, after, stamp),
          changedOutside: changedOutside(before, after, stamp),
          sourceUntouched: at(after, from[0], from[1]).join() === source.join(),
        },
      }
    })()`,
  },
  {
    name: 'blur softens the detail under the brush',
    // The roughness is measured on the busiest 40 by 40 window, which the tip covers completely;
    // "nothing outside the stroke" is measured on a rectangle that contains the whole tip.
    probe: `(async () => { ${PRELUDE}
      const before = await baseFrame()
      const { rect, score } = roughestRect(before, 40)
      if (score < 1) return { pass: false, detail: { error: 'the fixture has no detail to soften', score } }
      const radius = 40
      setBrush(radius * 2, 1, 1)
      await stroke('blur', [centreOf(rect)])
      const after = await s.renderAndRead()
      const smoothed = rectRoughness(after, rect)
      const stamp = { x: centreOf(rect)[0] - radius - 6, y: centreOf(rect)[1] - radius - 6, width: radius * 2 + 12, height: radius * 2 + 12 }
      return {
        pass: smoothed < score * 0.7 && changedOutside(before, after, stamp) === 0,
        detail: {
          rect: [rect.x, rect.y, rect.width, rect.height],
          roughnessBefore: Math.round(score * 100) / 100,
          roughnessAfter: Math.round(smoothed * 100) / 100,
          changedInside: changedInside(before, after, stamp),
          changedOutside: changedOutside(before, after, stamp),
        },
      }
    })()`,
  },
  {
    name: 'sharpen raises the contrast under the brush',
    probe: `(async () => { ${PRELUDE}
      const before = await baseFrame()
      const { rect, score } = roughestRect(before, 40)
      if (score < 1) return { pass: false, detail: { error: 'the fixture has no detail to sharpen', score } }
      const radius = 40
      s.retouch.blurRadius = 6
      setBrush(radius * 2, 1, 1)
      await stroke('sharpen', [centreOf(rect)])
      const after = await s.renderAndRead()
      const sharper = rectRoughness(after, rect)
      const stamp = { x: centreOf(rect)[0] - radius - 6, y: centreOf(rect)[1] - radius - 6, width: radius * 2 + 12, height: radius * 2 + 12 }
      return {
        pass: sharper > score * 1.15 && changedOutside(before, after, stamp) === 0,
        detail: {
          rect: [rect.x, rect.y, rect.width, rect.height],
          roughnessBefore: Math.round(score * 100) / 100,
          roughnessAfter: Math.round(sharper * 100) / 100,
          changedInside: changedInside(before, after, stamp),
          changedOutside: changedOutside(before, after, stamp),
        },
      }
    })()`,
  },
  {
    name: 'smudge drags colour along the stroke',
    // The smudge is a drag, so the assertion is about where the colour came from: the pixel under
    // the end of the stroke has to look like the one under the start of it, having been something
    // else before. Across a boundary, because inside one flat colour there is nothing to drag.
    probe: `(async () => { ${PRELUDE}
      const before = await baseFrame()
      const from = findEdge(before, 90, 90)
      if (!from) return { pass: false, detail: { error: 'the fixture has no colour boundary to drag across' } }
      const to = [from[0] + 90, from[1]]
      const startColour = at(before, from[0], from[1])
      const endBefore = at(before, to[0], to[1])

      const radius = 25
      setBrush(radius * 2, 0.6, 1)
      await stroke('smudge', [from, [from[0] + 30, from[1]], [from[0] + 60, from[1]], to])
      const after = await s.renderAndRead()
      const endAfter = at(after, to[0], to[1])
      const towardsStart = (colour) => Math.hypot(colour[0] - startColour[0], colour[1] - startColour[1], colour[2] - startColour[2])
      const stamp = { x: from[0] - radius - 6, y: from[1] - radius - 6, width: 90 + radius * 2 + 12, height: radius * 2 + 12 }
      return {
        pass: towardsStart(endAfter) < towardsStart(endBefore) - 20
          && changedInside(before, after, stamp) > 1000
          && changedOutside(before, after, stamp) === 0,
        detail: {
          start: { at: from, colour: startColour },
          end: { at: to, before: endBefore, after: endAfter },
          distanceBefore: Math.round(towardsStart(endBefore)),
          distanceAfter: Math.round(towardsStart(endAfter)),
          changedInside: changedInside(before, after, stamp),
          changedOutside: changedOutside(before, after, stamp),
        },
      }
    })()`,
  },
  {
    name: 'dodge lightens and burn darkens',
    probe: `(async () => { ${PRELUDE}
      const rect = { x: 440, y: 240, width: 120, height: 120 }
      s.retouch.exposure = 100
      s.retouch.toneRange = 'midtones'
      setBrush(100, 0.3, 1)

      const dodging = await baseFrame()
      const dodgedBefore = rectLuma(dodging, rect)
      await stroke('dodge', [centreOf(rect)])
      const dodgedFrame = await s.renderAndRead()
      const dodged = rectLuma(dodgedFrame, rect)

      // A second document, because burn has to start from the same pixels dodge did.
      const burning = await baseFrame()
      const burnedBefore = rectLuma(burning, rect)
      await stroke('burn', [centreOf(rect)])
      const burnedFrame = await s.renderAndRead()
      const burned = rectLuma(burnedFrame, rect)

      return {
        pass: dodged > dodgedBefore + 8
          && burned < burnedBefore - 8
          && changedOutside(burning, burnedFrame, rect) === 0
          && changedInside(burning, burnedFrame, rect) > 3000,
        detail: {
          rect: [rect.x, rect.y, rect.width, rect.height],
          dodged: { before: Math.round(dodgedBefore * 10) / 10, after: Math.round(dodged * 10) / 10 },
          burned: { before: Math.round(burnedBefore * 10) / 10, after: Math.round(burned * 10) / 10 },
          changedInside: changedInside(burning, burnedFrame, rect),
          changedOutside: changedOutside(burning, burnedFrame, rect),
        },
      }
    })()`,
  },
  {
    name: 'sponge drains colour under the brush',
    probe: `(async () => { ${PRELUDE}
      const before = await baseFrame()
      const rect = { x: 440, y: 240, width: 120, height: 120 }
      const saturationBefore = rectSaturation(before, rect)
      if (saturationBefore < 0.3) return { pass: false, detail: { error: 'the fixture has no colour there to drain', saturationBefore } }
      s.retouch.saturating = false
      s.retouch.exposure = 100
      setBrush(100, 0.5, 1)
      await stroke('sponge', [centreOf(rect)])
      const after = await s.renderAndRead()
      const saturationAfter = rectSaturation(after, rect)
      return {
        pass: saturationAfter < saturationBefore * 0.7 && changedOutside(before, after, rect) === 0,
        detail: {
          rect: [rect.x, rect.y, rect.width, rect.height],
          saturationBefore: Math.round(saturationBefore * 100) / 100,
          saturationAfter: Math.round(saturationAfter * 100) / 100,
          changedInside: changedInside(before, after, rect),
          changedOutside: changedOutside(before, after, rect),
        },
      }
    })()`,
  },
  {
    name: 'spot healing paints over what it covers',
    // The honest test of a spot heal needs a spot. The base image has none, so the case makes one:
    // a black disc painted on the flattest patch in the frame, which is then healed back towards the
    // colour around it. A heal that merely replaced the pixels with something that still did not
    // match would fail the colour assertion, and one that repainted the whole layer would fail the
    // "nothing outside the brush" one.
    probe: `(async () => { ${PRELUDE}
      const before = await baseFrame()
      const { rect, score } = flattestRect(before, 64)
      if (!Number.isFinite(score)) return { pass: false, detail: { error: 'the fixture has nowhere flat to heal from' } }
      const spot = { x: rect.x + 20, y: rect.y + 20, width: 24, height: 24 }
      const centre = centreOf(spot)
      const around = bandColour(before, spot, 14)
      const wanted = rectColour(before, spot)

      // The blemish: a hard black square, drawn with the shape tool the way anyone would. It goes on
      // the same surface the retouching does, so the two tools are measured against each other
      // rather than against a hand-written pixel buffer.
      s.setForeground({ r: 0, g: 0, b: 0 })
      s.drawShape([spot.x, spot.y], [spot.x + spot.width, spot.y + spot.height], true)
      await wait(500)
      const blemished = await s.renderAndRead()
      const blemish = rectColour(blemished, spot)

      const radius = 26
      s.retouch.healMode = 0
      setBrush(radius * 2, 0.6, 1)
      await stroke('heal', [centre])
      const healed = await s.renderAndRead()
      const stamp = { x: centre[0] - radius - 6, y: centre[1] - radius - 6, width: radius * 2 + 12, height: radius * 2 + 12 }
      const after = rectColour(healed, spot)
      const toStart = colourDistance(after, wanted)
      const toAround = colourDistance(after, around)

      return {
        pass: colourDistance(blemish, wanted) > 60
          && colourDistance(blemish, around) > 60
          && toStart < 20
          && toAround < 24
          && changedInside(before, healed, stamp) > 200
          && changedOutside(before, healed, stamp) === 0,
        detail: {
          spot: [spot.x, spot.y, spot.width, spot.height],
          flatRoughness: Math.round(score * 100) / 100,
          around: around.map((value) => Math.round(value)),
          wanted: wanted.map((value) => Math.round(value)),
          blemish: blemish.map((value) => Math.round(value)),
          healed: after.map((value) => Math.round(value)),
          distanceToWanted: Math.round(toStart),
          distanceToAround: Math.round(toAround),
          changedOutside: changedOutside(before, healed, stamp),
        },
      }
    })()`,
  },

  {
    name: 'content-aware fill rebuilds a selection',
    // The same shape of test as the spot heal, one tool further up: a black square is drawn on a flat
    // patch, the square is selected, and the fill has to put the patch's own colour back inside the
    // selection without touching the pixels outside it.
    probe: `(async () => { ${PRELUDE}
      const before = await baseFrame()
      const { rect, score } = flattestRect(before, 96)
      if (!Number.isFinite(score)) return { pass: false, detail: { error: 'the fixture has nowhere flat to fill into' } }
      const spot = { x: rect.x + 36, y: rect.y + 36, width: 28, height: 28 }
      const wanted = rectColour(before, spot)
      const around = bandColour(before, spot, 16)

      s.setForeground({ r: 0, g: 0, b: 0 })
      s.drawShape([spot.x, spot.y], [spot.x + spot.width, spot.y + spot.height], true)
      await wait(500)
      const blemished = await s.renderAndRead()
      const blemish = rectColour(blemished, spot)

      // The selection is the square, grown so the fill has to invent the pixels that were painted
      // over rather than reading them back out of the untouched edge.
      s.applySelectionMode(s.marqueeSelection([spot.x - 4, spot.y - 4], [spot.x + spot.width + 4, spot.y + spot.height + 4], false))
      s.contentAwareFill()
      await wait(600)
      const filled = await s.renderAndRead()
      const after = rectColour(filled, spot)
      const selection = { x: spot.x - 6, y: spot.y - 6, width: spot.width + 12, height: spot.height + 12 }

      return {
        pass: colourDistance(blemish, wanted) > 60
          && colourDistance(after, wanted) < 16
          && colourDistance(after, around) < 22
          && changedOutside(before, filled, selection) === 0,
        detail: {
          spot: [spot.x, spot.y, spot.width, spot.height],
          flatRoughness: Math.round(score * 100) / 100,
          wanted: wanted.map((value) => Math.round(value)),
          around: around.map((value) => Math.round(value)),
          blemish: blemish.map((value) => Math.round(value)),
          filled: after.map((value) => Math.round(value)),
          distanceAfter: Math.round(colourDistance(after, wanted)),
          changedOutside: changedOutside(before, filled, selection),
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
