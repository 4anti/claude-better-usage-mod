// The limits' arithmetic, apart from the engine: what the usage service's answer says,
// which of two readings to trust, and what the forecast learns from them. The hooks
// module does the asking and the storing (the engine lets `$` cross no import).
import type { Limit, PaceOf } from '../types'
import { median, sameWindow, SAME_WINDOW_MS, TYPICAL_DEFAULT, WINDOWS } from './forecast'

export type Saved = { at: number; limits: Limit[] }

// The usage service rate-limits per login, and the app's own Usage panel asks it on
// the same allowance, so ask it seldom: when a chat opens, then every 2 minutes with the
// exact context count, one ask for the whole app (when it was last asked, the answer and
// any back-off sit in the shared store). Between asks the figures every reply from
// Claude carries keep the band current.
const PLAN_EVERY_MS = 2 * 60_000
// timers drift: a 2-minute tick a moment early still counts as due
const PLAN_SLACK_MS = 10_000
// after a failed ask wait 2, then 5, then 15 minutes, or what the service says
const PLAN_BACKOFF_MS = [120_000, 300_000, 900_000]

export type Backoff = { until: number; failures: number; error: string }
/** 'no': the 3s tick, never asks; 'due': asks if 2 minutes have passed app-wide; 'now': asks unless backed off */
export type Ask = 'no' | 'due' | 'now'

/** a refused ask, with how long the service said to wait */
export class AskError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

export const isPlanDue = (ask: Ask, now: number, askedAt: number, backoff: Backoff | undefined) =>
  now >= (backoff?.until ?? 0) && (ask === 'now' || (ask === 'due' && now - askedAt >= PLAN_EVERY_MS - PLAN_SLACK_MS))

/** the back-off after one more failed ask */
export function nextBackoff(prev: Backoff | undefined, error: unknown, now: number): Backoff {
  const failures = (prev?.failures ?? 0) + 1
  const wait = error instanceof AskError && error.retryAfterMs !== undefined
    ? error.retryAfterMs
    : PLAN_BACKOFF_MS[Math.min(failures - 1, PLAN_BACKOFF_MS.length - 1)]!
  return { until: now + wait, failures, error: error instanceof Error ? error.message : String(error) }
}

/** the 5 Hour and Weekly limits in the usage service's answer; throws when it has neither */
export function parsePlan(text: string): Limit[] {
  const body = JSON.parse(text) as Record<string, { utilization?: number | null; resets_at?: string | null } | null>
  const limits: Limit[] = []
  for (const kind of ['five_hour', 'seven_day']) {
    const w = body[kind]
    if (!w || typeof w.utilization !== 'number') continue
    limits.push({ kind, percentUsed: Math.round(w.utilization * 10) / 10, resetsAt: w.resets_at ?? undefined })
  }
  if (limits.length === 0) throw new Error('answer had no limits')
  return limits
}

// The context is shown as three groups: Messages, Tools (System + MCP tools) and Other
// (the system prompt, skills, memory files, agents, MCP server instructions).
const TOOL_NAMES = new Set(['System tools', 'MCP tools'])
export type Group = 'Messages' | 'Tools' | 'Other'
const groupOf = (name: string): Group => (name === 'Messages' ? 'Messages' : TOOL_NAMES.has(name) ? 'Tools' : 'Other')

/** the tokens the context's used categories hold, by group */
export function sumGroups(categories: readonly { name: string; tokens: number; kind: string }[]): Record<Group, number> {
  const sums: Record<Group, number> = { Messages: 0, Tools: 0, Other: 0 }
  for (const c of categories) if (c.kind === 'used') sums[groupOf(c.name)] += c.tokens
  return sums
}

/** a Retry-After header, in ms, when it gives a usable number of seconds */
export function retryAfterMs(headers: Record<string, string | string[] | undefined> | undefined): number | undefined {
  const header = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]
  const seconds = Number(Array.isArray(header) ? header[0] : header)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

type Reading = Limit & { at: number }

// The better of two readings of one window. A later window beats an earlier one,
// whatever was read last; within one window the later reading wins. A reading with no
// reset time (a reply may leave it out) cannot say which window it is: it only moves
// the known window's % up, as use only climbs within a window.
function better(best: Reading | undefined, r: Reading): Reading {
  if (!best) return r
  if (!r.resetsAt) {
    if (!best.resetsAt) return r.at > best.at ? r : best
    return r.at > best.at && r.percentUsed >= best.percentUsed ? { ...best, percentUsed: r.percentUsed, at: r.at } : best
  }
  if (!best.resetsAt) return r
  const gap = Date.parse(r.resetsAt) - Date.parse(best.resetsAt)
  if (Math.abs(gap) > SAME_WINDOW_MS) return gap > 0 ? r : best
  return r.at > best.at ? r : best
}

// The two readings, the usage service's (saved, shared by every chat) and this chat's
// reply figures (live), merged window by window: a reply may carry one window alone,
// which must never wipe out the other's reading (a chat showed Weekly at 0 while the
// rest showed 58%). The reply figures also run behind the service, which the app's
// panel reads: whole percents, seen at 18 for an hour while the service said 19.0, so
// within a window the service's last answer (plan) is a floor. A window that has reset
// since stays, at 0: the forecast reads it as not running.
export function pickLimits(saved: Saved | undefined, live: Saved | undefined, plan: Saved | undefined, now: number): { merged?: Saved; limits: Limit[] } {
  const sources = [saved, live].filter((s): s is Saved => s !== undefined)
  if (sources.length === 0) return { limits: [] }
  const byKind = new Map<string, Reading>()
  for (const s of sources) for (const l of s.limits) byKind.set(l.kind, better(byKind.get(l.kind), { ...l, at: s.at }))
  const merged: Saved = {
    at: Math.max(...sources.map(s => s.at)),
    limits: [...byKind.values()].map(({ at: _at, ...l }) => l),
  }
  const finer = (l: Limit): Limit => {
    const p = plan?.limits.find(x => x.kind === l.kind)
    return p && sameWindow(p.resetsAt, l.resetsAt) && p.percentUsed > l.percentUsed ? { ...l, percentUsed: p.percentUsed } : l
  }
  const limits = merged.limits.map(l =>
    l.resetsAt !== undefined && Date.parse(l.resetsAt) <= now ? { kind: l.kind, percentUsed: 0 } : finer(l),
  )
  return { merged, limits }
}

// What the forecast learns, shared by every chat through the store: how far each past
// window got (its peak, the last few kept), and the running one's peak and skipped %.
type PaceWindow = { resetsAt: number; peak: number; skip: number }
export type PaceStore = { finals: Record<string, number[]>; windows: Record<string, PaceWindow> }
const FINALS_KEPT = 8

/** the jump a reopened chat's first reply made, once a reading after it has moved */
export function spikeOf(from: Saved | undefined, live: Saved | undefined): Record<string, number> | undefined {
  if (!from || !live || live.at <= from.at) return undefined
  const jump: Record<string, number> = {}
  for (const l of live.limits) {
    const before = from.limits.find(b => b.kind === l.kind)
    if (before && sameWindow(before.resetsAt, l.resetsAt) && l.percentUsed > before.percentUsed) {
      jump[l.kind] = l.percentUsed - before.percentUsed
    }
  }
  return Object.keys(jump).length === 0 ? undefined : jump
}

/** a window that has ended, by when it reset and how far it got */
export type Past = { kind: string; resetsAt: number; peak: number }

/** the pace store after these readings, whether it changed, each window's pace, and the windows that ended */
export function stepPace(saved: PaceStore, limits: Limit[], now: number, spike?: Record<string, number>): { store: PaceStore; isChanged: boolean; pace: Record<string, PaceOf>; closed: Past[] } {
  let store = saved
  let isChanged = false
  const pace: Record<string, PaceOf> = {}
  const closed: Past[] = []
  for (const l of limits) {
    const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!WINDOWS[l.kind] || !Number.isFinite(resetsAt) || resetsAt <= now) continue
    const old = store.windows[l.kind]
    let w = old
    let finals = store.finals[l.kind]
    if (!w || Math.abs(w.resetsAt - resetsAt) > SAME_WINDOW_MS) {
      // a new window: the last one's peak is how far it got
      if (w && w.peak > 0) {
        finals = [...(finals ?? []), w.peak].slice(-FINALS_KEPT)
        closed.push({ kind: l.kind, resetsAt: w.resetsAt, peak: w.peak })
      }
      w = { resetsAt, peak: l.percentUsed, skip: 0 }
    } else if (l.percentUsed > w.peak) w = { ...w, peak: l.percentUsed }
    const jump = spike?.[l.kind]
    if (jump) w = { ...w, skip: Math.min(w.peak, w.skip + jump) }
    if (w !== old) {
      store = { finals: { ...store.finals, ...(finals ? { [l.kind]: finals } : {}) }, windows: { ...store.windows, [l.kind]: w } }
      isChanged = true
    }
    pace[l.kind] = { typical: median(finals) ?? TYPICAL_DEFAULT, skip: w.skip }
  }
  return { store, isChanged, pace, closed }
}

// the past windows the history pane lists: two days of 5 hour ones, two months of weeks
const HISTORY_KEPT: Record<string, number> = { five_hour: 10, seven_day: 8 }

/** the history with these ended windows added, newest first; one already there is not added twice */
export function addHistory(history: Past[], closed: Past[]): Past[] {
  const fresh = closed.filter(c => !history.some(h => h.kind === c.kind && Math.abs(h.resetsAt - c.resetsAt) <= SAME_WINDOW_MS))
  if (fresh.length === 0) return history
  const all = [...fresh, ...history].sort((a, b) => b.resetsAt - a.resetsAt)
  return Object.keys(HISTORY_KEPT).flatMap(kind => all.filter(p => p.kind === kind).slice(0, HISTORY_KEPT[kind]))
}
