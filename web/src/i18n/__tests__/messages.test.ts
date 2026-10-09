import { describe, expect, it } from 'vitest'

import en from '../locales/en.json'
import zhCN from '../locales/zh-CN.json'
import { BUILT_IN, FALLBACK_LOCALE, validatePack, isPackProblem } from '../index'
import { BLEND_MODES, SAMPLINGS, blendModeKey, samplingKey } from '../../model/types'
import { COMMANDS } from '../../model/keymap'

type Tree = { [key: string]: string | Tree }

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.set(path, value)
    else for (const [nested, text] of flatten(value, path)) out.set(nested, text)
  }
  return out
}

const EN = flatten(en as Tree)
const ZH = flatten(zhCN as Tree)

describe('the message tables', () => {
  it('cover exactly the same keys in both languages', () => {
    const missingInChinese = [...EN.keys()].filter((key) => !ZH.has(key))
    const missingInEnglish = [...ZH.keys()].filter((key) => !EN.has(key))
    expect(missingInChinese).toEqual([])
    expect(missingInEnglish).toEqual([])
    expect(EN.size).toBeGreaterThan(200)
  })

  it('have no empty strings', () => {
    for (const [key, value] of [...EN, ...ZH]) {
      expect(value.trim(), `${key} is empty`).not.toBe('')
    }
  })

  /**
   * A `{name}` in English but `{nome}` in Chinese would show a placeholder as literal text at
   * runtime, which is the kind of thing nobody notices until a screenshot.
   */
  it('use the same placeholders in both languages', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const [key, english] of EN) {
      const chinese = ZH.get(key)
      if (!chinese) continue
      expect(placeholders(chinese), `${key} has different placeholders`).toEqual(placeholders(english))
    }
  })

  it('name every blend mode and sampling the format holds', () => {
    for (const mode of BLEND_MODES) {
      const key = blendModeKey(mode)
      expect(EN.get(key), `${key} is missing from English`).toBeTruthy()
      expect(ZH.get(key), `${key} is missing from Chinese`).toBeTruthy()
    }
    for (const sampling of SAMPLINGS) {
      const key = samplingKey(sampling)
      expect(EN.get(key), `${key} is missing from English`).toBeTruthy()
      expect(ZH.get(key), `${key} is missing from Chinese`).toBeTruthy()
    }
  })

  /** The format stores English names, so the key has to survive what a name can contain. */
  it('slug blend-mode names into keys vue-i18n accepts', () => {
    expect(blendModeKey('Normal')).toBe('blendModes.normal')
    expect(blendModeKey('Color Burn')).toBe('blendModes.color-burn')
    expect(blendModeKey('Linear Dodge (Add)')).toBe('blendModes.linear-dodge-add')
    for (const mode of BLEND_MODES) {
      expect(blendModeKey(mode)).toMatch(/^[a-zA-Z0-9.-]+$/)
    }
  })

  it('carries every failure Rust can name', () => {    // The keys the command layer builds with `message_key()`, plus the rule codes.
    const keys = [
      'error.invalid',
      'error.version',
      'error.missingImage',
      'error.tooLarge',
      'error.encode',
      'error.notFound',
      'error.notASnapshot',
      'error.io',
      'error.json',
      'error.saveEnded',
      'error.notAManifest',
      'error.badHeader',
      'error.expectedRawBody',
      'error.notPng',
      'error.assetFileName',
      'error.rule.duplicateLayerId',
      'error.rule.maskFileName',
      'error.rule.hierarchyCycle',
      'error.rule.clippingSource',
      'error.rule.guidePosition',
    ]
    for (const key of keys) {
      expect(EN.has(key), `${key} is missing from English`).toBe(true)
      expect(ZH.has(key), `${key} is missing from Chinese`).toBe(true)
    }
  })

  /**
   * A command's label is its menu item's, which is what keeps the shortcut sheet from needing a
   * table of names of its own. A command whose key is not in the tables would show as a raw key name.
   */
  it('names every command that can be bound to a key', () => {
    for (const command of COMMANDS) {
      expect(EN.has(command.labelKey), `${command.id} → ${command.labelKey}, in English`).toBe(true)
      expect(ZH.has(command.labelKey), `${command.id} → ${command.labelKey}, in Chinese`).toBe(true)
    }
  })
})

describe('language packs', () => {
  it('ships English as the fallback and both built-in locales', () => {
    expect(FALLBACK_LOCALE).toBe('en')
    expect(BUILT_IN.map((pack) => pack.locale)).toEqual(['en', 'zh-CN'])
  })

  it('accepts a partial pack, because a half-translated interface beats none', () => {
    const pack = validatePack({
      locale: 'fr',
      name: 'Français',
      messages: { menu: { file: 'Fichier' } },
    })
    expect(isPackProblem(pack)).toBe(false)
    if (!isPackProblem(pack)) {
      expect(pack.locale).toBe('fr')
      expect(pack.messages).toEqual({ menu: { file: 'Fichier' } })
    }
  })

  it('refuses a file that is not a pack, and says why', () => {
    const notAnObject = validatePack('hello')
    expect(isPackProblem(notAnObject) && notAnObject.reason).toMatch(/JSON object/)

    const noLocale = validatePack({ name: 'X', messages: {} })
    expect(isPackProblem(noLocale) && noLocale.reason).toMatch(/locale/)

    const noName = validatePack({ locale: 'fr', messages: {} })
    expect(isPackProblem(noName) && noName.reason).toMatch(/name/)

    const noMessages = validatePack({ locale: 'fr', name: 'Français' })
    expect(isPackProblem(noMessages) && noMessages.reason).toMatch(/messages/)
  })

  it('keeps the optional metadata a pack may carry', () => {
    const pack = validatePack({
      locale: 'de',
      name: 'Deutsch',
      englishName: 'German',
      version: '1.2.0',
      authors: ['Someone'],
      messages: {},
    })
    expect(isPackProblem(pack)).toBe(false)
    if (!isPackProblem(pack)) {
      expect(pack.englishName).toBe('German')
      expect(pack.version).toBe('1.2.0')
      expect(pack.authors).toEqual(['Someone'])
    }
  })
})
