// The person's settings, from the config menu (the manifest's userConfig), read once
// per load: a change there reloads the module. Anything out of range falls back.
import { CONTEXT_RAMP, LIMIT_RAMP } from './colors'
import type { Ramp } from './colors'

export type Settings = {
  /** a notification at alertAt and at the limit, and when a warned 5 Hour window resets */
  notify: boolean
  alertAt: number
  /** "This chat used" under the 5 Hour bar */
  chatCost: boolean
  /** the usage in the status line while the band is off */
  statusLine: boolean
  /** the Auto compact % a chat starts from */
  autoCompactAt: number
  limitRamp: Ramp
  contextRamp: Ramp
}

const number = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

/** three whole %s, rising, from text such as "50 75 95"; else the fallback */
export function parseRamp(value: unknown, fallback: Ramp): Ramp {
  if (typeof value !== 'string') return fallback
  const parts = value.trim().split(/[\s,/]+/).map(Number)
  const isRamp = parts.length === 3 && parts.every(p => Number.isInteger(p) && p >= 0 && p <= 100) && parts[0]! < parts[1]! && parts[1]! < parts[2]!
  return isRamp ? [parts[0]!, parts[1]!, parts[2]!] : fallback
}

export function readSettings(options: Readonly<Record<string, unknown>> = {}): Settings {
  return {
    notify: options.notify !== false,
    alertAt: number(options.alertAt, 90, 50, 100),
    chatCost: options.chatCost !== false,
    statusLine: options.statusLine !== false,
    autoCompactAt: number(options.autoCompactAt, 30, 15, 99),
    limitRamp: parseRamp(options.limitColors, LIMIT_RAMP),
    contextRamp: parseRamp(options.contextColors, CONTEXT_RAMP),
  }
}
