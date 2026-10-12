import type { Limit, PaceOf } from '../types'
import { fmt } from './i18n'
import type { Strings } from './i18n'

export const HOUR = 3_600_000
export const WINDOWS: Record<string, { ms: number }> = {
  five_hour: { ms: 5 * HOUR },
  seven_day: { ms: 7 * 24 * HOUR },
}

/** a window's name in the band's language: "5 Hour", "Weekly", or short: "5H", "W" */
export const windowName = (kind: string, t: Strings, isShort = false) =>
  kind === 'five_hour' ? (isShort ? t.fiveHourShort : t.fiveHour) : kind === 'seven_day' ? (isShort ? t.weeklyShort : t.weekly) : kind

// 5 hour on the left, Weekly on the right
export const order = (kind: string) => (kind === 'five_hour' ? 0 : 1)

export type Forecast = {
  kind: string
  percent: number
  resetsAt: number
  /** 'idle': no window running (unused, or reset): 0% until the next message starts one */
  status: 'hit' | 'ok' | 'out' | 'idle'
  projected: number
  runOutAt: number
}

// The pace a window is forecast at: your usual one (the median of how far your past
// windows got) blended with this window's own, which takes over as the window runs.
// For the first EARLY share of a window its own pace counts for nothing (a burst at
// the start, re-reading a big context, says little), then it blends in smoothly,
// counting for half a quarter of the way past that. `skip`: the % the first reply of
// a reopened chat took re-reading its old context, a one-off left out of the pace
// (still in the % used).
export const TYPICAL_DEFAULT = 50
const TRUST = 0.25
const EARLY = 0.15
// one window's reset time as two readings give it: a few minutes apart at most
export const SAME_WINDOW_MS = 10 * 60_000

export function forecast(limit: Limit, now: number, pace?: PaceOf): Forecast | null {
  const win = WINDOWS[limit.kind]
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!win) return null
  const p = limit.percentUsed
  // no reset time, or one already passed: the window is not running, so it is at 0
  if (!Number.isFinite(resetsAt) || resetsAt <= now) {
    return { kind: limit.kind, percent: 0, resetsAt: NaN, status: 'idle', projected: 0, runOutAt: Infinity }
  }
  const remaining = Math.max(0, resetsAt - now)
  const elapsed = Math.max(1, win.ms - remaining)
  const base = { kind: limit.kind, percent: p, resetsAt }
  if (p >= 100) return { ...base, status: 'hit', projected: p, runOutAt: now }
  const typical = pace?.typical ?? TYPICAL_DEFAULT
  const own = Math.max(0, p - (pace?.skip ?? 0)) / elapsed
  const settled = Math.max(0, elapsed - win.ms * EARLY)
  const weight = settled / (settled + win.ms * TRUST)
  const rate = weight * own + (1 - weight) * (typical / win.ms)
  const projected = p + rate * remaining
  if (projected < 100 || rate <= 0) return { ...base, status: 'ok', projected, runOutAt: Infinity }
  return { ...base, status: 'out', projected, runOutAt: now + (100 - p) / rate }
}

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const hours = Math.floor((m % 1440) / 60)
  const min = m % 60
  if (d > 0) return hours > 0 ? `${d}d ${hours}h` : `${d}d`
  if (hours > 0) return min > 0 ? `${hours}h ${min}m` : `${hours}h`
  return `${min}m`
}

// times and days in the language's own form: "4:40 PM" / "16:40", "Sunday" / "Pazar"
const time = (at: number, locale: string) =>
  new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
const weekday = (at: number, locale: string) => new Date(at).toLocaleDateString(locale, { weekday: 'long' })
const isSameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

/** when a reset is: its time today, its weekday and time later */
export const resumesAt = (at: number, now: number, t: Strings) =>
  isSameDay(at, now) ? time(at, t.locale) : `${weekday(at, t.locale)} ${time(at, t.locale)}`

/** a past window by its end: "Sun 4:40 PM" for a 5 hour one, "Oct 5" for a week */
export const endedAt = (at: number, kind: string, t: Strings) =>
  kind === 'five_hour'
    ? `${new Date(at).toLocaleDateString(t.locale, { weekday: 'short' })} ${time(at, t.locale)}`
    : new Date(at).toLocaleDateString(t.locale, { month: 'short', day: 'numeric' })

/** the headline and the window it speaks for (its colour follows that window's %) */
export function headline(list: Forecast[], now: number, t: Strings): { text: string; lead: Forecast } | null {
  // the reset by its time when it is under a day away (an after-midnight one included),
  // else by its weekday: a time that far off would only lengthen the headline
  const reset = (at: number, byTime: string, byDay: string) =>
    at - now < 24 * HOUR ? fmt(byTime, { time: time(at, t.locale) }) : fmt(byDay, { day: weekday(at, t.locale) })
  const hit = list.find(f => f.status === 'hit')
  if (hit) return { text: fmt(t.limitReached, { when: resumesAt(hit.resetsAt, now, t) }), lead: hit }
  const out = list.filter(f => f.status === 'out').sort((a, b) => a.runOutAt - b.runOutAt)[0]
  if (out) return { text: reset(out.resetsAt, t.runOutAt, t.runOutOn), lead: out }
  const lead = list.find(f => f.kind === 'seven_day' && f.status !== 'idle') ?? list.find(f => f.status !== 'idle')
  if (!lead) return null
  return { text: reset(lead.resetsAt, t.onTrackAt, t.onTrackOn), lead }
}

// the forecast tick's percent, or none when there is nothing ahead to mark
export function markerOf(f: Forecast): number | undefined {
  if (f.status === 'hit' || f.status === 'idle') return undefined
  const at = Math.min(100, f.projected)
  return at - f.percent >= 1 ? at : undefined
}

export function median(list: number[] | undefined): number | undefined {
  if (!list || list.length === 0) return undefined
  const s = [...list].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

export const sameWindow = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_WINDOW_MS
