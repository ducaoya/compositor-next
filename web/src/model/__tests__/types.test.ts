import { describe, expect, it } from 'vitest'

import { manifestProblems } from '../document'
import {
  BLEND_MODES,
  BLEND_MODE_GROUPS,
  DEFAULT_LIMITS,
  hierarchyEntries,
  indexLayers,
  type Manifest,
} from '../types'

/** The manifest printed in the reference project's `docs/writing-comp-files.md`, verbatim. */
const DOCUMENTED_EXAMPLE: Manifest = JSON.parse(`{
  "format": "com.compositor.project",
  "version": 11,
  "colorSpace": "sRGB",
  "documentID": "0C5E7A91-3B2D-4F6A-8E1C-9D0B7A6F5E4D",
  "width": 1920,
  "height": 1080,
  "resolution": 72,
  "activeLayerID": "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F",
  "layers": [
    {
      "id": "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F",
      "name": "Background",
      "imageFile": "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.png",
      "isVisible": true,
      "isGroup": false,
      "opacity": 1,
      "blendMode": "Normal",
      "transform": {
        "origin": [0, 0],
        "size": [1920, 1080],
        "rotation": 0,
        "flipX": false,
        "flipY": false,
        "sampling": "High quality"
      }
    }
  ]
}`)

describe('the format', () => {
  it('accepts the documented example unchanged', () => {
    expect(manifestProblems(DOCUMENTED_EXAMPLE)).toEqual([])
    expect(DOCUMENTED_EXAMPLE.layers[0].transform.origin).toEqual([0, 0])
    expect(DOCUMENTED_EXAMPLE.layers[0].transform.sampling).toBe('High quality')
  })

  it('indexes layers by id', () => {
    const byId = indexLayers(DOCUMENTED_EXAMPLE)
    expect(byId.get('6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F')?.name).toBe('Background')
  })

  it('draws the documented example as one layer', () => {
    expect(hierarchyEntries(DOCUMENTED_EXAMPLE.layers).map((entry) => entry.layer.name)).toEqual([
      'Background',
    ])
  })
})

describe('blend mode names', () => {
  it('lists all 24, spelled as the format spells them', () => {
    expect(BLEND_MODES).toEqual([
      'Normal',
      'Darken',
      'Multiply',
      'Color Burn',
      'Linear Burn',
      'Lighten',
      'Screen',
      'Color Dodge',
      'Linear Dodge (Add)',
      'Overlay',
      'Soft Light',
      'Hard Light',
      'Vivid Light',
      'Linear Light',
      'Pin Light',
      'Hard Mix',
      'Difference',
      'Exclusion',
      'Subtract',
      'Divide',
      'Hue',
      'Saturation',
      'Color',
      'Luminosity',
    ])
  })

  it('groups them without losing or repeating one', () => {
    const flattened = BLEND_MODE_GROUPS.flat()
    expect(flattened).toEqual([...BLEND_MODES])
    expect(new Set(flattened).size).toBe(BLEND_MODES.length)
  })
})

describe('limits', () => {
  it('starts from the reference app\'s ceilings', () => {
    expect(DEFAULT_LIMITS.maxSide).toBe(30_000)
    expect(DEFAULT_LIMITS.maxLayers).toBe(10_000)
    expect(DEFAULT_LIMITS.supportedVersions).toEqual([1, 11])
  })
})

describe('problem reporting', () => {
  it('names the layer at fault', () => {
    const manifest: Manifest = {
      ...DOCUMENTED_EXAMPLE,
      layers: [{ ...DOCUMENTED_EXAMPLE.layers[0], imageFile: 'wrong-name.png' }],
    }
    expect(manifestProblems(manifest).join()).toMatch(/not named after it/)
  })

  it('catches an active layer that is not in the document', () => {
    const manifest: Manifest = { ...DOCUMENTED_EXAMPLE, activeLayerID: '00000000-0000-0000-0000-000000000000' }
    expect(manifestProblems(manifest).join()).toMatch(/active layer/)
  })

  it('says nothing about a project in good order', () => {
    expect(manifestProblems(createRicher())).toEqual([])
  })
})

function createRicher(): Manifest {
  return {
    format: 'com.compositor.project',
    version: 11,
    colorSpace: 'sRGB',
    resolution: 72,
    documentID: 'AAAAAAAA-0000-0000-0000-000000000000',
    width: 64,
    height: 64,
    activeLayerID: 'BBBBBBBB-0000-0000-0000-000000000000',
    layers: [
      {
        id: 'BBBBBBBB-0000-0000-0000-000000000000',
        name: 'Base',
        isVisible: true,
        transform: {
          origin: [0, 0],
          size: [64, 64],
          rotation: 0,
          flipX: false,
          flipY: false,
          sampling: 'High quality',
        },
        imageFile: 'BBBBBBBB-0000-0000-0000-000000000000.png',
        maskFile: 'BBBBBBBB-0000-0000-0000-000000000000.mask.png',
        maskEnabled: true,
      },
      {
        id: 'CCCCCCCC-0000-0000-0000-000000000000',
        name: 'Folder',
        isVisible: true,
        isGroup: true,
        opacity: 0.5,
        transform: {
          origin: [0, 0],
          size: [64, 64],
          rotation: 0,
          flipX: false,
          flipY: false,
          sampling: 'High quality',
        },
      },
    ],
    guides: [{ id: 'DDDDDDDD-0000-0000-0000-000000000000', axis: 'vertical', position: 32 }],
  }
}
