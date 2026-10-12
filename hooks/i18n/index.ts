// The band's languages. Adding one is a file beside these that fills every key of
// en.ts (the type says which are missing) and a line below. Right-to-left scripts are
// left out: terminals draw them unreliably.
import { de } from './de'
import { en } from './en'
import type { Strings } from './en'
import { es } from './es'
import { fr } from './fr'
import { id } from './id'
import { it } from './it'
import { ja } from './ja'
import { ko } from './ko'
import { nl } from './nl'
import { pl } from './pl'
import { pt } from './pt'
import { ru } from './ru'
import { tr } from './tr'
import { uk } from './uk'
import { zhCN } from './zh-CN'
import { zhTW } from './zh-TW'

export type { Strings }

export const LANGUAGES: Record<string, Strings> = {
  en, tr, de, fr, es, pt, it, nl, pl, ru, uk, ja, ko, 'zh-CN': zhCN, 'zh-TW': zhTW, id,
}

/** a language code from a locale ("tr", "pt-BR", "zh-Hant-TW"), or none we have */
function fromLocale(locale: string | undefined): string | undefined {
  const l = locale?.toLowerCase().replace(/_/g, '-')
  if (!l) return undefined
  if (l.startsWith('zh')) return /hant|tw|hk|mo/.test(l) ? 'zh-TW' : 'zh-CN'
  const primary = l.split('-')[0]!
  return primary in LANGUAGES ? primary : undefined
}

/** the setting when it names a language; for "auto", the first locale we have, else English */
export function resolveLanguage(setting: string, ...locales: (string | undefined)[]): string {
  if (setting in LANGUAGES) return setting
  for (const locale of locales) {
    const code = fromLocale(locale)
    if (code) return code
  }
  return 'en'
}

export const stringsOf = (code: string): Strings => LANGUAGES[code] ?? en

/** the template with each {name} filled in */
export function fmt(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (name in values ? String(values[name]) : all))
}
