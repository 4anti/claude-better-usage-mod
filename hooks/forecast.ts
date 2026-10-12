import type { Limit, PaceOf } from '../types'

export const HOUR = 3_600_000
export const WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5 Hour', ms: 5 * HOUR },
  seven_day: { label: 'Weekly', ms: 7 * 24 * HOUR },
}

// 5 hour on the left, Weekly on the right
export const order = (kind: string) => (kind === 'five_hour' ? 0 : 1)

export type Forecast = {
  kind: string
  label: string
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
    return { kind: limit.kind, label: win.label, percent: 0, resetsAt: NaN, status: 'idle', projected: 0, runOutAt: Infinity }
  }
  const remaining = Math.max(0, resetsAt - now)
  const elapsed = Math.max(1, win.ms - remaining)
  const base = { kind: limit.kind, label: win.label, percent: p, resetsAt }
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

const time = (t: number) =>
  new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const weekday = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'long' })
const isSameDay = (a: number, b: number) =>
  new Date(a).toLocaleDateString('en-US') === new Date(b).toLocaleDateString('en-US')

// the reset by its time when it is under a day away (an after-midnight one included),
// else by its weekday: a time that far off would only lengthen the headline
function resetName(t: number, now: number): string {
  return t - now < 24 * HOUR ? `the ${time(t)} reset` : `${weekday(t)}'s reset`
}

/** the headline and the window it speaks for (its colour follows that window's %) */
export function headline(list: Forecast[], now: number): { text: string; lead: Forecast } | null {
  const hit = list.find(f => f.status === 'hit')
  if (hit) {
    const at = isSameDay(hit.resetsAt, now) ? time(hit.resetsAt) : `${weekday(hit.resetsAt)} ${time(hit.resetsAt)}`
    return { text: `Limit reached. Usage resumes at ${at}.`, lead: hit }
  }
  const out = list.filter(f => f.status === 'out').sort((a, b) => a.runOutAt - b.runOutAt)[0]
  if (out) return { text: `At this pace you'll run out before ${resetName(out.resetsAt, now)}.`, lead: out }
  const lead = list.find(f => f.kind === 'seven_day' && f.status !== 'idle') ?? list.find(f => f.status !== 'idle')
  if (!lead) return null
  return { text: `On track. You should reach ${resetName(lead.resetsAt, now)} with room to spare.`, lead }
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
