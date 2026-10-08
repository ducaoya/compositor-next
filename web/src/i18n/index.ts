/**
 * Translation, and the language packs around it.
 *
 * English is both the default and the fallback: a pack can translate as much or as little as it
 * likes, and every key it leaves out reads in English rather than showing a key name. That is what
 * makes a pack useful on the day it is started rather than on the day it is finished.
 *
 * Packs are plain JSON, in the same shape as `locales/en.json`, so a translator can copy that file
 * and work through it. They live outside the app, in the user's data folder, so installing one is
 * copying a file — no rebuild, no store, no restart.
 */

import { ref } from 'vue'
import { createI18n } from 'vue-i18n'

import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'

export const FALLBACK_LOCALE = 'en'

/** The message shape: nested objects of strings, as `locales/en.json` is written. */
export type Messages = { [key: string]: string | Messages }

/** One language pack file, which is also the shape of a built-in locale. */
export interface LanguagePack {
  locale: string
  /** The language's own name for itself, which is what the picker shows. */
  name: string
  /** The language's name in English, for someone who cannot read it. */
  englishName?: string
  version?: string
  authors?: string[]
  messages: Messages
}

/** What the picker lists. */
export interface LocaleInfo {
  code: string
  name: string
  englishName: string
  builtIn: boolean
  version?: string
  authors?: string[]
}

export const BUILT_IN: LanguagePack[] = [
  {
    locale: 'en',
    name: 'English',
    englishName: 'English',
    version: '1.0.0',
    messages: en as Messages,
  },
  {
    locale: 'zh-CN',
    name: '简体中文',
    englishName: 'Chinese (Simplified)',
    version: '1.0.0',
    messages: zhCN as Messages,
  },
]

const STORAGE_KEY = 'compositor.locale'

/** Bumped whenever the installed packs change, so the picker redraws. */
export const packsVersion = ref(0)

const installed = new Map<string, LanguagePack>()

export const i18n = createI18n({
  legacy: false,
  locale: readStoredLocale() ?? FALLBACK_LOCALE,
  fallbackLocale: FALLBACK_LOCALE,
  // A pack that is still being written is missing keys by definition, which is not a reason to
  // fill the console with warnings.
  missingWarn: false,
  fallbackWarn: false,
  messages: Object.fromEntries(BUILT_IN.map((pack) => [pack.locale, pack.messages])),
})

/**
 * Translates outside a component.
 *
 * Components use `useI18n()`; this is for the store and other plain modules, which have no setup
 * context to hang a `t` from.
 */
export function t(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params ?? {})
}

export function currentLocale(): string {
  return i18n.global.locale.value
}

export function setLocale(code: string): void {
  i18n.global.locale.value = code
  try {
    localStorage.setItem(STORAGE_KEY, code)
  } catch {
    // A webview with storage disabled still gets to switch language for this session.
  }
}

function readStoredLocale(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    return stored
  } catch {
    return null
  }
}

/** Every locale the picker should offer: the built-in ones, then whatever is installed. */
export function availableLocales(): LocaleInfo[] {
  void packsVersion.value
  const built = BUILT_IN.map((pack) => ({
    code: pack.locale,
    name: pack.name,
    englishName: pack.englishName ?? pack.name,
    builtIn: true,
    version: pack.version,
  }))
  const extra = [...installed.values()]
    // A pack for a language that ships with the app would only shadow it.
    .filter((pack) => !BUILT_IN.some((built_in) => built_in.locale === pack.locale))
    .map((pack) => ({
      code: pack.locale,
      name: pack.name,
      englishName: pack.englishName ?? pack.name,
      builtIn: false,
      version: pack.version,
      authors: pack.authors,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...built, ...extra]
}

export function isInstalled(code: string): boolean {
  return installed.has(code)
}

/** Applies a pack, replacing any previous version of the same locale. */
export function applyPack(pack: LanguagePack): void {
  installed.set(pack.locale, pack)
  i18n.global.setLocaleMessage(pack.locale, pack.messages)
  packsVersion.value += 1
  // A pack may have arrived for the language already in use.
  const active = i18n.global.locale.value
  if (active === pack.locale) i18n.global.locale.value = pack.locale
}

export function forgetPack(code: string): void {
  installed.delete(code)
  i18n.global.setLocaleMessage(code, {})
  if (i18n.global.locale.value === code) setLocale(FALLBACK_LOCALE)
  packsVersion.value += 1
}

export interface PackProblem {
  reason: string
}

/**
 * Checks a parsed JSON value is a language pack.
 *
 * The rule is deliberately loose — a locale, a name, and a message map — because a pack that
 * translates three strings is still worth more than no pack at all.
 */
export function validatePack(value: unknown): LanguagePack | PackProblem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { reason: 'the file does not contain a JSON object' }
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.locale !== 'string' || candidate.locale.trim() === '') {
    return { reason: 'there is no “locale”' }
  }
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    return { reason: 'there is no “name”' }
  }
  if (typeof candidate.messages !== 'object' || candidate.messages === null || Array.isArray(candidate.messages)) {
    return { reason: 'there is no “messages” object' }
  }
  return {
    locale: candidate.locale.trim(),
    name: candidate.name.trim(),
    englishName: typeof candidate.englishName === 'string' ? candidate.englishName : undefined,
    version: typeof candidate.version === 'string' ? candidate.version : undefined,
    authors: Array.isArray(candidate.authors) ? candidate.authors.filter((a): a is string => typeof a === 'string') : undefined,
    messages: candidate.messages as Messages,
  }
}

export function isPackProblem(value: LanguagePack | PackProblem): value is PackProblem {
  return 'reason' in value
}

/** What Rust sends back when a command fails: a key, its values, and a fallback. */
export interface CommandErrorShape {
  key: string
  params?: Record<string, unknown>
  fallback?: string
}

function looksLikeCommandError(value: unknown): value is CommandErrorShape {
  return typeof value === 'object' && value !== null && typeof (value as CommandErrorShape).key === 'string'
}

/**
 * Turns whatever a rejected `invoke` handed back into something a reader can understand.
 *
 * Three shapes arrive here: a structured error from Rust, a plain `Error` from the webview, and a
 * string from somewhere careless. Only the first is translatable, and it falls back to the English
 * Rust sent when the pack does not cover the key.
 */
export function translateError(value: unknown): string {
  if (looksLikeCommandError(value)) {
    const message = t(value.key, value.params ?? {})
    // vue-i18n answers with the key itself when it has nothing, which is not worth showing.
    return message === value.key ? (value.fallback ?? value.key) : message
  }
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  return t('error.invalid')
}
