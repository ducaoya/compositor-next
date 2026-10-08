import { describe, expect, it } from 'vitest'

import {
  addLayer,
  covering,
  createLayer,
  createManifest,
  groupLayers,
  imageFileName,
  manifestProblems,
  moveLayer,
  newUuid,
  removeLayers,
  setMaskSource,
  siblings,
  topLevelSelection,
  ungroupLayers,
} from '../document'
import { effectiveOpacity, hierarchyEntries, isFolder, visibleLeaves, type Manifest } from '../types'

function document(): Manifest {
  return createManifest(400, 300)
}

function push(manifest: Manifest, name: string, parentID?: string) {
  const layer = createLayer({ name, transform: covering(400, 300), hasPixels: true, parentID })
  addLayer(manifest, layer)
  return layer
}

describe('layer identifiers', () => {
  it('are uppercase, as the format writes them', () => {
    const id = newUuid()
    expect(id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
    expect(imageFileName(id)).toBe(`${id}.png`)
  })

  it('are unique', () => {
    const ids = new Set(Array.from({ length: 500 }, newUuid))
    expect(ids.size).toBe(500)
  })
})

describe('document edits', () => {
  it('creates a manifest the validator accepts', () => {
    const manifest = document()
    expect(manifestProblems(manifest)).toEqual([])
    expect(manifest.format).toBe('com.compositor.project')
    expect(manifest.version).toBe(11)
    expect(manifest.colorSpace).toBe('sRGB')
  })

  it('adds layers bottom to top and makes the new one active', () => {
    const manifest = document()
    const base = push(manifest, 'Base')
    const top = push(manifest, 'Top')
    expect(manifest.layers.map((layer) => layer.name)).toEqual(['Base', 'Top'])
    expect(manifest.activeLayerID).toBe(top.id)
    expect(visibleLeaves(manifest.layers).map((layer) => layer.name)).toEqual(['Base', 'Top'])
    expect(base.imageFile).toBe(imageFileName(base.id))
  })

  it('leaves a blank layer without pixels, so an empty document costs nothing', () => {
    const manifest = document()
    const blank = createLayer({ name: 'Blank', transform: covering(400, 300) })
    addLayer(manifest, blank)
    expect(blank.imageFile).toBeUndefined()
    expect(manifestProblems(manifest)).toEqual([])
  })

  it('refuses a folder that holds pixels', () => {
    const manifest = document()
    const layer = push(manifest, 'Base')
    layer.isGroup = true
    // The record still names an image file, which the format forbids for a folder.
    expect(manifestProblems(manifest).join()).toMatch(/holds pixels/)
  })

  it('removes a folder with everything inside it', () => {
    const manifest = document()
    const base = push(manifest, 'Base')
    const folder = createLayer({ name: 'Folder', transform: covering(400, 300), isGroup: true })
    addLayer(manifest, folder)
    const child = push(manifest, 'Child', folder.id)
    expect(removeLayers(manifest, [folder.id])).toBe(true)
    expect(manifest.layers.map((layer) => layer.id)).toEqual([base.id])
    expect(manifest.layers.find((layer) => layer.id === child.id)).toBeUndefined()
  })

  it('clears a clipping link into a layer it deletes', () => {
    const manifest = document()
    const base = push(manifest, 'Base')
    const clipped = push(manifest, 'Clipped')
    expect(setMaskSource(manifest, clipped.id, base.id)).toBe(true)
    removeLayers(manifest, [base.id])
    expect(clipped.maskSourceID).toBeUndefined()
    expect(manifestProblems(manifest)).toEqual([])
  })

  it('moves a layer among its siblings', () => {
    const manifest = document()
    const a = push(manifest, 'A')
    const b = push(manifest, 'B')
    const c = push(manifest, 'C')
    expect(moveLayer(manifest, a.id, 1)).toBe(true)
    expect(manifest.layers.map((layer) => layer.name)).toEqual(['B', 'A', 'C'])
    expect(moveLayer(manifest, c.id, 1)).toBe(false)
    expect(moveLayer(manifest, b.id, -1)).toBe(false)
  })

  it('drops a clipping link that a move breaks', () => {
    const manifest = document()
    const base = push(manifest, 'Base')
    const clipped = push(manifest, 'Clipped')
    setMaskSource(manifest, clipped.id, base.id)
    // Moving the base above the clipped layer separates them.
    expect(moveLayer(manifest, base.id, 1)).toBe(true)
    expect(clipped.maskSourceID).toBeUndefined()
  })

  it('groups and ungroups around a selection', () => {
    const manifest = document()
    const a = push(manifest, 'A')
    const b = push(manifest, 'B')
    const c = push(manifest, 'C')
    const folderId = groupLayers(manifest, [b.id, c.id])
    expect(folderId).not.toBeNull()
    expect(manifest.activeLayerID).toBe(folderId)
    expect(manifest.layers.find((layer) => layer.id === a.id)?.parentID).toBeUndefined()
    expect(isFolder(manifest.layers.find((layer) => layer.id === folderId!)!)).toBe(true)
    expect(siblings(manifest, folderId).map((layer) => layer.name)).toEqual(['B', 'C'])
    expect(manifestProblems(manifest)).toEqual([])

    expect(ungroupLayers(manifest, [folderId!])).toBe(true)
    expect(manifest.layers.some((layer) => layer.id === folderId)).toBe(false)
    expect(siblings(manifest, null).map((layer) => layer.name)).toEqual(['A', 'B', 'C'])
  })

  it('treats a folder and its own child as one selection', () => {
    const manifest = document()
    const folder = createLayer({ name: 'Folder', transform: covering(400, 300), isGroup: true })
    addLayer(manifest, folder)
    const child = push(manifest, 'Child', folder.id)
    expect(topLevelSelection(manifest, [folder.id, child.id])).toEqual([folder.id])
  })

  it('refuses to clip a folder, or to a folder', () => {
    const manifest = document()
    const folder = createLayer({ name: 'Folder', transform: covering(400, 300), isGroup: true })
    addLayer(manifest, folder)
    const layer = push(manifest, 'Layer')
    expect(setMaskSource(manifest, layer.id, folder.id)).toBe(false)
    expect(setMaskSource(manifest, folder.id, layer.id)).toBe(false)
    expect(setMaskSource(manifest, layer.id, layer.id)).toBe(false)
  })
})

describe('the layer tree', () => {
  it('walks depth first, bottom to top, with inherited visibility', () => {
    const manifest = document()
    push(manifest, 'Base')
    const folder = createLayer({ name: 'Folder', transform: covering(400, 300), isGroup: true })
    addLayer(manifest, folder)
    const child = push(manifest, 'Child', folder.id)
    push(manifest, 'Top')

    const entries = hierarchyEntries(manifest.layers)
    expect(entries.map((entry) => [entry.layer.name, entry.depth, entry.visible])).toEqual([
      ['Base', 0, true],
      ['Folder', 0, true],
      ['Child', 1, true],
      ['Top', 0, true],
    ])

    folder.isVisible = false
    expect(hierarchyEntries(manifest.layers).find((entry) => entry.layer.id === child.id)?.visible).toBe(false)
    expect(visibleLeaves(manifest.layers).map((layer) => layer.name)).toEqual(['Base', 'Top'])
  })

  it('tolerates a child that is not adjacent to its folder', () => {
    // Siblings are grouped by parentID and keep their array order; the format does not require a
    // subtree to be contiguous.
    const manifest = document()
    const folder = createLayer({ name: 'Folder', transform: covering(400, 300), isGroup: true })
    const child = push(manifest, 'Child')
    child.parentID = folder.id
    manifest.layers.unshift(folder)
    expect(hierarchyEntries(manifest.layers).map((entry) => entry.layer.name)).toEqual(['Folder', 'Child'])
  })

  it('hides everything inside a collapsed folder from the panel walk when asked', () => {
    const manifest = document()
    const folder = createLayer({ name: 'Folder', transform: covering(400, 300), isGroup: true })
    addLayer(manifest, folder)
    push(manifest, 'Child', folder.id)
    const collapsed = new Set([folder.id])
    expect(hierarchyEntries(manifest.layers, { collapsed }).map((entry) => entry.layer.name)).toEqual([
      'Folder',
    ])
  })

  it('can walk top first, as the panel draws it', () => {
    const manifest = document()
    push(manifest, 'Base')
    push(manifest, 'Top')
    expect(hierarchyEntries(manifest.layers, { topFirst: true }).map((entry) => entry.layer.name)).toEqual([
      'Top',
      'Base',
    ])
  })
})

describe('folder opacity', () => {
  it('multiplies into every layer inside', () => {
    const manifest = document()
    const outer = createLayer({ name: 'Outer', transform: covering(400, 300), isGroup: true })
    const inner = createLayer({ name: 'Inner', transform: covering(400, 300), isGroup: true, parentID: outer.id })
    addLayer(manifest, outer)
    addLayer(manifest, inner)
    const leaf = push(manifest, 'Leaf', inner.id)
    leaf.opacity = 0.5
    inner.opacity = 0.5
    outer.opacity = 0.5

    const byId = new Map(manifest.layers.map((layer) => [layer.id, layer]))
    expect(effectiveOpacity(leaf, byId)).toBeCloseTo(0.125, 12)
    // The layer's own opacity still reads back as itself in the panel.
    expect(leaf.opacity).toBe(0.5)
  })
})
