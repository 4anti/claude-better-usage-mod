import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AutoCompact, Category, Hold, Limit, PaceOf, Snapshot, Spend } from '../types'
import { AT_DEFAULT, bandTree } from './band'
import type { BandActions } from './band'
import { sameWindow } from './forecast'
import { parsePlan, pickLimits, retryAfterMs, spikeOf, stepPace } from './limits'
import type { PaceStore, Saved } from './limits'

// the engine reads these where they are made: the state they name stays in this file
const snapshot = atom({ plugin: 'usage-quota', key: 'snapshot' } as const, null as Snapshot | null)
const isOn = atom({ plugin: 'usage-quota', key: 'isOn' } as const, true)
const isCollapsed = atom({ plugin: 'usage-quota', key: 'isCollapsed' } as const, false)
const autoCompact = atom({ plugin: 'usage-quota', key: 'autoCompact' } as const, { isOn: false, at: null } as AutoCompact)
const fieldTick = atom({ plugin: 'usage-quota', key: 'fieldTick' } as const, 0)
// the % field's text while typing is cleaned (digits only, 3 at most); null: the set %
const fieldText = atom({ plugin: 'usage-quota', key: 'fieldText' } as const, null as string | null)
const theme = atom({ plugin: 'usage-quota', key: 'theme' } as const, 'dark' as 'dark' | 'light')
const autoAsk = atom({ plugin: 'usage-quota', key: 'autoAsk' } as const, null as { at: number; percent: number } | null)
// what holds auto compact back, and in which chat: kept in state so a reload (an
// update, /reload-plugins) keeps it, where a module variable would start over
const hold = atom({ plugin: 'usage-quota', key: 'hold' } as const, { chat: '', waits: false, stuck: false } as Hold)
// how much of the 5 hour limit this chat's replies took, kept in state for the same reason
const spend = atom({ plugin: 'usage-quota', key: 'spend' } as const, { chat: '', total: 0, last: null, from: null } as Spend)

const LOCAL_EVERY_MS = 3_000

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function storeSet($: EngineInterface, key: string, value: unknown): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch {
    // this chat still has it
  }
}

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

type Backoff = { until: number; failures: number; error: string }
/** 'no': the 3s tick, never asks; 'due': asks if 2 minutes have passed app-wide; 'now': asks unless backed off */
type Ask = 'no' | 'due' | 'now'

class AskError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

// The plan's limits, as the app's "Plan usage limits" panel reads them: the account's
// usage endpoint, through the session's own credential (the plugin never sees it).
async function fetchPlan($: EngineInterface): Promise<Limit[] | null> {
  const auth = await $.session.authorize()
  // no Claude login (an API key, a gateway): there is no plan to ask about
  if (!auth || auth.kind !== 'bearer') return null
  const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
    auth: auth.handle,
    headers: { 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
  })
  if (!res.ok) throw new AskError(res.status === 429 ? 'refused (429)' : `failed (${res.status})`, retryAfterMs(res.headers))
  return parsePlan(res.text)
}

// this chat's own reading from its replies, and when it last changed
let live: Saved | undefined

// Two sources, and the newest wins (pickLimits): the usage service (asked seldom,
// shared by every chat through the store) and the figures each reply from Claude
// carries (this chat's, stamped when they last changed).
async function limitsOf(
  $: EngineInterface,
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[],
  now: number,
  ask: Ask,
): Promise<{ limits: Limit[]; at?: number; error?: string }> {
  if (rateLimits.length > 0) {
    const limits = rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
    if (!live || JSON.stringify(live.limits) !== JSON.stringify(limits)) live = { at: now, limits }
  }
  let saved = (await storeGet($, 'limits')) as Saved | undefined
  let backoff = (await storeGet($, 'planBackoff')) as Backoff | undefined
  const askedAt = ((await storeGet($, 'planAskedAt')) as number | undefined) ?? 0
  const isFree = now >= (backoff?.until ?? 0)
  const isDue = ask === 'now' || (ask === 'due' && now - askedAt >= PLAN_EVERY_MS - PLAN_SLACK_MS)
  if (isDue && isFree) {
    // claim the ask first, so the other chats see it taken and skip theirs
    await storeSet($, 'planAskedAt', now)
    try {
      const plan = await fetchPlan($)
      if (plan) {
        saved = { at: now, limits: plan }
        await storeSet($, 'limits', saved)
        await storeSet($, 'planLimits', saved)
      }
      if (backoff) await storeSet($, 'planBackoff', { until: 0, failures: 0, error: '' })
      backoff = undefined
    } catch (error) {
      const failures = (backoff?.failures ?? 0) + 1
      const wait =
        error instanceof AskError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : PLAN_BACKOFF_MS[Math.min(failures - 1, PLAN_BACKOFF_MS.length - 1)]!
      backoff = { until: now + wait, failures, error: error instanceof Error ? error.message : String(error) }
      await storeSet($, 'planBackoff', backoff)
    }
  }
  const { pick, limits } = pickLimits(saved, live, (await storeGet($, 'planLimits')) as Saved | undefined, now)
  // newer reply figures go to the store too, so other chats get them
  if (pick && pick === live && (!saved || live.at > saved.at)) await storeSet($, 'limits', live)
  return { limits, at: pick?.at, error: backoff?.error || undefined }
}

// A chat reopened with a long history re-reads it all on its first reply: one big jump
// in usage. Its first turn notes the limits it started from; the first new reading
// that moved is that jump, and is left out of the pace. Only for a chat that opened
// with this much already in it (a new chat's first reply is real work).
const RESUME_MIN_TOKENS = 20_000
let isOpening = true
let openMessages = 0
let spikeFrom: Saved | undefined

async function trackPace($: EngineInterface, limits: Limit[], now: number): Promise<Record<string, PaceOf>> {
  const spike = spikeOf(spikeFrom, live)
  if (spike) spikeFrom = undefined
  const saved = ((await storeGet($, 'pace')) as PaceStore | undefined) ?? { finals: {}, windows: {} }
  const { store, isChanged, pace } = stepPace(saved, limits, now, spike)
  if (isChanged) await storeSet($, 'pace', store)
  return pace
}

// The window is shown as three groups: Messages, Tools (System + MCP tools) and Other
// (the system prompt, skills, memory files, agents, MCP server instructions).
const TOOL_NAMES = new Set(['System tools', 'MCP tools'])
type Group = 'Messages' | 'Tools' | 'Other'
const groupOf = (name: string): Group => (name === 'Messages' ? 'Messages' : TOOL_NAMES.has(name) ? 'Tools' : 'Other')

// The free local breakdown ('summary') estimates each category from its text, which
// reads tools ~1.3-1.6x heavy. The exact count ('full', what /context and the app's
// Context window panel show) costs no tokens but sends one token-count request per tool
// and memory file (~320 here). So run it every 2 minutes, keep the exact/estimate ratio
// of Tools and Other (in the store, for every session), and scale the live 3s estimate
// by it; Messages is then the API's real input total less those two.
const CALIBRATE_EVERY_MS = 2 * 60_000
let calib: Partial<Record<Group, number>> = {}
let isCalibrating = false
// Right after /compact there is no API reply yet, so the window's real total is unknown
// and the local estimate is all there is. The exact count fills that gap until the next reply.
let exactCount: { at: number; sums: Record<Group, number> } | undefined
let noReplySince: number | undefined

function sumGroups(categories: readonly { name: string; tokens: number; kind: string }[]): Record<Group, number> {
  const sums: Record<Group, number> = { Messages: 0, Tools: 0, Other: 0 }
  for (const c of categories) if (c.kind === 'used') sums[groupOf(c.name)] += c.tokens
  return sums
}

async function calibrate($: EngineInterface): Promise<void> {
  if (isCalibrating) return
  isCalibrating = true
  try {
    const exact = await $.session.usage({ breakdown: 'full' })
    const rough = await $.session.usage({ breakdown: 'summary' })
    const real = sumGroups(exact.context.breakdown?.categories ?? [])
    const guess = sumGroups(rough.context.breakdown?.categories ?? [])
    const next = { ...calib }
    for (const g of ['Tools', 'Other'] as const) if (guess[g] > 0 && real[g] > 0) next[g] = real[g] / guess[g]
    calib = next
    exactCount = { at: await $.clock.now(), sums: real }
    await $.store.set('calib', next)
    lastSnapshot = ''
  } catch (error) {
    $.ui.log(`usage-quota: exact count failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } finally {
    isCalibrating = false
  }
  // the usage service is asked alongside, on the same 2 minutes
  await refresh($, 'due')
}

// Auto compact fires whenever the chat is idle (no turn running) and the context
// is at or past the %: at the end of a turn, on opening a chat, on any refresh between
// turns. Held back only by: `waits` (the band is asking, or the person chose
// "after my next compact", which is also what an unanswered ask means: cleared only by
// a real compaction, never by the % flickering below), `stuck` (a compaction already ran and
// the context is still past the %: it would only repeat; dropping below clears it).
// The % is compared as the band shows it, rounded.
// a reply has been seen since the chat opened or was last compacted
let hadReply = false
async function setHold($: EngineInterface, patch: Partial<Hold>): Promise<void> {
  await update($, hold, held => ({ ...held, ...patch }))
}
let isBusy = false
let isCompacting = false
let lastPercent = 0
// on by the default alone (no setting of this chat's own): the first reading past the
// % asks rather than compacts, so an old chat reopened is never compacted unasked
let isAskFirst = false

function compactNow($: EngineInterface): void {
  if (isCompacting) return
  isCompacting = true
  // compacting takes longer than a press or a hook may run, so a timer starts it
  $.clock.after(0, async () => {
    try {
      await $.command.run({ command: 'compact' })
    } finally {
      isCompacting = false
    }
  })
}

// Auto compact compacts through the session itself, not by typing /compact: a
// command run from the end of a turn is refused while the turn winds down, which
// is why it toasted and then did nothing. The compaction also rejects while a turn
// runs, so it is tried again a few times, a couple of seconds apart.
const AUTO_TRIES = 6
let canCompactDirectly = true
const AUTO_RETRY_MS = 2_000

function autoCompactNow($: EngineInterface, attempt = 1): void {
  if (attempt === 1) {
    if (isCompacting) return
    isCompacting = true
  }
  $.clock.after(attempt === 1 ? 1_000 : AUTO_RETRY_MS, async () => {
    try {
      // the desktop app (an SDK session) has no direct compaction: there /compact runs
      // as a turn of its own, so it is typed, as the Compact button does
      const result = canCompactDirectly
        ? await $.session.compact()
        : (await $.command.run({ command: 'compact' }), undefined)
      // held as stuck while the figures are read again, so no tick fires a second one
      await setHold($, { stuck: true })
      isCompacting = false
      if (result && 'skip' in result && result.skip) $.ui.toast(`Auto compact was skipped: ${result.skip}`)
      lastSnapshot = ''
      const usage = await $.session.usage({ breakdown: 'summary' })
      const percent = usage.context.percent ?? 0
      // still past the % after compacting: say so once, and do not loop on it
      const auto = await read($, autoCompact)
      if (auto.at !== null && Math.round(percent) >= auto.at) {
        $.ui.toast(`Context is still at ${Math.round(percent)}% after compacting, past your ${auto.at}%: auto compact waits until it drops below`)
      } else await setHold($, { stuck: false })
      await refresh($)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // any refusal of the direct way: type /compact from then on, as the button does
      if (canCompactDirectly) {
        canCompactDirectly = false
        return autoCompactNow($, attempt + 1)
      }
      if (attempt < AUTO_TRIES) return autoCompactNow($, attempt + 1)
      isCompacting = false
      $.ui.toast(`Auto compact could not start: ${reason}`)
      $.ui.log(`usage-quota: auto compact failed: ${reason}`, { to: 'debug' })
    }
  })
}

// called with the context % whenever it is read
async function watchAuto($: EngineInterface, percent: number): Promise<void> {
  lastPercent = percent
  const auto = await read($, autoCompact)
  if (!auto.isOn || auto.at === null) return
  const held = await read($, hold)
  if (Math.round(percent) < auto.at) {
    if (held.stuck) await setHold($, { stuck: false })
    return
  }
  if (isAskFirst) {
    isAskFirst = false
    return askIfPast($, auto.at)
  }
  if (held.waits || held.stuck || isBusy || isCompacting) return
  $.ui.toast(`Context at ${Math.round(percent)}%: auto compacting (set at ${auto.at}%)`)
  autoCompactNow($)
}

async function saveAuto($: EngineInterface, next: AutoCompact): Promise<void> {
  // chosen here: no longer on by the default alone
  isAskFirst = false
  await update($, autoCompact, () => next)
  await storeSet($, `autoCompact:${autoChat ?? (await chatId($))}`, next)
  // the last setting chosen in any chat is what a chat with none of its own starts with
  await storeSet($, 'autoCompactDefault', next)
}

// auto compact is set per chat: a chat that never had it opens with the last setting
// chosen anywhere (off at the default % before any); a chat reopened, or the app
// restarted, gets back its own. Read again whenever the chat's id changes (a /clear
// goes on under a new one, unannounced)
let autoChat: string | undefined
async function chatId($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return 'chat'
  }
}
async function loadAuto($: EngineInterface): Promise<void> {
  const id = await chatId($)
  if (id === autoChat) return
  autoChat = id
  const saved = (await storeGet($, `autoCompact:${id}`)) as AutoCompact | undefined
  const fallback = (await storeGet($, 'autoCompactDefault')) as AutoCompact | undefined
  // the same chat after a reload keeps its ask, what holds it back and what it spent
  const isNewChat = (await read($, hold)).chat !== id
  // set before the setting below lands: a tick running meanwhile must already see it
  if (isNewChat) isAskFirst = !saved && fallback?.isOn === true
  const own = saved ?? fallback
  await update($, autoCompact, () => (own ? { ...own, at: own.at ?? AT_DEFAULT } : { isOn: false, at: AT_DEFAULT }))
  if (!isNewChat) return
  await update($, hold, () => ({ chat: id, waits: false, stuck: false }))
  await update($, autoAsk, () => null)
  await update($, spend, () => ({ chat: id, total: 0, last: null, from: null }))
}

// the % field sets on Enter, or when the focus leaves it with an unset draft (a
// click elsewhere in the band, or the next prompt sent); 15 to 99, outside is pulled
// in. After a set the field is drawn afresh (fieldTick), which also drops its focus
const AT_MIN = 15
const AT_MAX = 99
let draftAt: string | null = null

// no event says a click landed outside the band, so a draft also sets itself once
// typing has rested a while, as if the person had clicked away
const AT_REST_MS = 2_000
let restTimer: { cancel(): void } | null = null

// the field takes digits only, 3 at most: anything else typed or pasted is dropped
// as it arrives, by drawing the field's text again cleaned
const AT_DIGITS = 3
// a mark of no width, so a cleaned text equal to the one drawn still redraws (an
// unchanged value would leave the typing as it is) without a new field losing focus
const NO_WIDTH = '​'

function cleanAt(value: string): string {
  return value.replace(/\D/g, '').slice(0, AT_DIGITS)
}

// what the field shows comes from state, not a module variable: a press or a typing
// runs apart from the draw, so a value the draw kept would not be seen here
async function redrawField($: EngineInterface, value: string): Promise<void> {
  const at = (await read($, autoCompact)).at ?? AT_DEFAULT
  await update($, fieldText, drawn => (value === (drawn ?? `${at}`) ? value + NO_WIDTH : value))
}

function typedAt($: EngineInterface, raw: string): void {
  const value = cleanAt(raw)
  if (value !== raw) void redrawField($, value)
  draftAt = value
  restTimer?.cancel()
  restTimer = $.clock.after(AT_REST_MS, () => {
    restTimer = null
    void commitDraft($)
  })
}

async function commitDraft($: EngineInterface): Promise<void> {
  if (draftAt === null) return
  await commitAt($, draftAt)
}

async function commitAt($: EngineInterface, value: string): Promise<void> {
  draftAt = null
  restTimer?.cancel()
  restTimer = null
  const text = cleanAt(value)
  // only digits reach here: blank is the default, out of range is pulled in, every time
  const typed = text === '' ? AT_DEFAULT : Number(text)
  const at = Math.min(AT_MAX, Math.max(AT_MIN, typed))
  if (typed !== at) $.ui.toast(`Auto compact: ${typed < at ? 'the least' : 'the most'} is ${at}% – set to ${at}%`)
  await setThreshold($, at)
  // a new field every time (its key changes), so it shows the set value whatever was typed
  await update($, fieldText, () => null)
  await update($, fieldTick, n => n + 1)
}

// a new threshold: armed when the context is below it, else the band asks, in its
// own buttons (never the chat's question dialog, which runs through the chat)
async function setThreshold($: EngineInterface, at: number): Promise<void> {
  await saveAuto($, { isOn: true, at })
  await askIfPast($, at)
}

// turning it on, or a new %, while the context is already past it: ask first
async function askIfPast($: EngineInterface, at: number | null): Promise<void> {
  const isPast = at !== null && Math.round(lastPercent) >= at
  await setHold($, { waits: isPast, stuck: false })
  await update($, autoAsk, () => (isPast ? { at: at!, percent: Math.round(lastPercent) } : null))
  if (!isPast && at !== null) $.ui.toast(`Auto compact at ${at}% context`)
}

async function answerAsk($: EngineInterface, choice: 'now' | 'next'): Promise<void> {
  await update($, autoAsk, () => null)
  // 'next': goes on waiting until a compaction is seen (the reply total goes blank)
  if (choice === 'now') {
    await setHold($, { waits: false })
    autoCompactNow($)
  }
}

// What a turn took of the 5 hour limit: how far it moved from the turn's start to the
// reading after its end, added to the chat's total for the window.
// shortcut: the limit is the whole account's, so another chat's use while this turn
// runs counts here too, and between the usage service's 2-minute answers the figures
// are whole percents; exact per-reply cost needs token counts priced per model
async function countSpend($: EngineInterface): Promise<void> {
  const { from } = await read($, spend)
  const after = (await read($, snapshot))?.limits.find(l => l.kind === 'five_hour')
  if (!from || !after) return
  // a window that reset mid-turn: all of the new one's use is this turn's, and the
  // chat's total starts over with the window
  const isSame = sameWindow(from.resetsAt, after.resetsAt)
  const cost = isSame ? Math.max(0, after.percentUsed - from.percentUsed) : after.percentUsed
  await update($, spend, s => ({ ...s, total: (isSame ? s.total : 0) + cost, last: cost, from: null }))
}

let isRefreshing = false
// the refresh running now, for a caller that needs a reading taken after its call
let inFlight: Promise<void> = Promise.resolve()
// an ask that arrived while a 3s tick was running: done right after it, not dropped
let pendingAsk: Ask = 'no'
let lastSnapshot = ''
let hadError = false

// collapsed or not is one setting for every chat, kept in the shared store: each chat
// reads it twice a second (one small read, nothing else) and follows
const COLLAPSE_EVERY_MS = 500
async function syncCollapsed($: EngineInterface): Promise<void> {
  const saved = ((await storeGet($, 'collapsed')) as boolean | undefined) === true
  if (saved !== (await read($, isCollapsed))) await update($, isCollapsed, () => saved)
}

// The desktop app's theme is not told to plugins: it is read from the app's own
// settings (userThemeMode), and for "system" from the OS. Looked at every 2s so a
// switch shows at once, each look a single file-time check (the file is read only
// once it changed); the OS, for "system" alone, is asked at most every 15s
const THEME_EVERY_MS = 2_000
const SYSTEM_EVERY_MS = 15_000
let didLogTheme = false
let systemTheme: { at: number; value: 'dark' | 'light' } | undefined
async function desktopConfig($: EngineInterface): Promise<string | undefined> {
  const appData = await $.env.get('APPDATA')
  if (appData) return `${appData}/Claude/config.json`
  const home = await $.env.get('HOME')
  return home ? `${home}/Library/Application Support/Claude/config.json` : undefined
}
async function osTheme($: EngineInterface): Promise<'dark' | 'light'> {
  const now = await $.clock.now()
  if (systemTheme && now - systemTheme.at < SYSTEM_EVERY_MS) return systemTheme.value
  let value: 'dark' | 'light' = 'dark'
  try {
    if (await $.env.get('APPDATA')) {
      const { stdout } = await $.process.run(['reg', 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { timeoutMs: 5_000 })
      if (/AppsUseLightTheme\s+REG_DWORD\s+0x1\b/.test(stdout)) value = 'light'
    } else {
      const { stdout } = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 5_000 })
      if (!/dark/i.test(stdout)) value = 'light'
    }
  } catch {
    // unknown: dark, as the band was built
  }
  systemTheme = { at: now, value }
  return value
}
// the settings file is read again only when it has changed since the last look: a
// look is otherwise one file-time check, no read, no parse
let themeFile: { mtimeMs: number; mode: string | undefined } | undefined
async function syncTheme($: EngineInterface): Promise<void> {
  let mode: string | undefined
  try {
    const path = await desktopConfig($)
    if (!path) return
    const { mtimeMs } = await $.fs.stat(path)
    if (themeFile?.mtimeMs === mtimeMs) mode = themeFile.mode
    else {
      mode = (JSON.parse(await $.fs.read(path)) as { userThemeMode?: string }).userThemeMode
      themeFile = { mtimeMs, mode }
    }
  } catch (error) {
    if (!didLogTheme) $.ui.log(`usage-quota: the app's theme could not be read: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    didLogTheme = true
    return
  }
  const next = mode === 'light' ? 'light' : mode === 'dark' ? 'dark' : await osTheme($)
  if (next !== (await read($, theme))) await update($, theme, () => next)
}

/** false when another refresh was already running, so this one read nothing */
async function refresh($: EngineInterface, ask: Ask = 'no'): Promise<boolean> {
  await loadAuto($)
  if (isRefreshing) {
    if (ask === 'now' || (ask === 'due' && pendingAsk === 'no')) pendingAsk = ask
    return false
  }
  isRefreshing = true
  let done = () => {}
  inFlight = new Promise<void>(resolve => (done = resolve))
  try {
    const now = await $.clock.now()
    const usage = await $.session.usage({ breakdown: 'summary' })
    const { context } = usage
    const breakdown = context.breakdown
    const all = (breakdown?.categories ?? []).filter(c => c.kind !== 'deferred' && c.tokens > 0)
    const rough = sumGroups(all)
    if (context.tokens === undefined) {
      // no reply since the chat opened or was compacted: get the exact count once
      if (noReplySince === undefined) {
        noReplySince = now
        $.clock.after(0, () => void calibrate($))
      }
    } else noReplySince = undefined
    // what the chat opened with, before its first turn here (a reopened chat may
    // already carry its last reply's total, so not only while that is blank)
    if (isOpening) openMessages = Math.max(rough.Messages, context.tokens ?? 0)
    // the reply total going blank after a reply: the chat was compacted (or cleared)
    if (context.tokens !== undefined) hadReply = true
    else if (hadReply) {
      hadReply = false
      // an ask left unanswered meant "after my next compact": done with now
      if ((await read($, hold)).waits) {
        await update($, autoAsk, () => null)
        await setHold($, { waits: false })
      }
    }
    const useExact = context.tokens === undefined && exactCount !== undefined && noReplySince !== undefined && exactCount.at >= noReplySince
    let tools = Math.round(rough.Tools * (calib.Tools ?? 1))
    let other = Math.round(rough.Other * (calib.Other ?? 1))
    // Messages is what the window holds beyond everything else, as /context counts it:
    // the API's real input total less the other groups, not the local estimate
    let messages = context.tokens !== undefined && context.tokens - tools - other > 0
      ? context.tokens - tools - other
      : rough.Messages
    if (useExact) ({ Messages: messages, Tools: tools, Other: other } = exactCount!.sums)
    const used = context.tokens ?? (useExact ? messages + tools + other : breakdown?.totalTokens ?? 0)
    const categories: Category[] = [
      { name: 'Messages', tokens: messages, kind: 'used' as const },
      { name: 'Tools', tokens: tools, kind: 'used' as const },
      { name: 'Other', tokens: other, kind: 'used' as const },
      ...all
        .filter(c => c.kind === 'buffer' || c.kind === 'free')
        .map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind as Category['kind'] })),
    ].filter(c => c.tokens > 0)
    const { limits, at: limitsAt, error: limitsError } = await limitsOf($, usage.rateLimits, now, ask)
    const pace = await trackPace($, limits, now)
    const next: Snapshot = {
      window: context.window,
      tokens: used,
      percent: useExact ? Math.round((used / context.window) * 100) : context.percent ?? breakdown?.percentage ?? Math.round((used / context.window) * 100),
      total: categories.reduce((sum, c) => sum + c.tokens, 0) || context.window,
      categories,
      limits,
      ...(limitsAt !== undefined ? { limitsAt } : {}),
      ...(limitsError ? { limitsError } : {}),
      ...(Object.keys(pace).length > 0 ? { pace } : {}),
      // the minute, so countdowns and ages redraw even when nothing else moves
      minute: Math.floor(now / 60_000),
    }
    await watchAuto($, next.percent)
    // redraw only when something moved, not on every tick
    const json = JSON.stringify(next)
    if (json !== lastSnapshot) {
      lastSnapshot = json
      await update($, snapshot, () => next)
    }
    if (hadError) $.ui.status(undefined)
    hadError = false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $.ui.status(`usage-quota: ${message.replace(/^usage-quota: /, '')}`)
    hadError = true
  } finally {
    isRefreshing = false
    done()
  }
  if (pendingAsk !== 'no') {
    const queued = pendingAsk
    pendingAsk = 'no'
    await refresh($, queued)
  }
  return true
}

// a reading taken after this call: a 3s tick already running may have read the
// figures before the turn this caller is about started or ended
async function refreshAfter($: EngineInterface): Promise<void> {
  while (!(await refresh($))) await inFlight
}

function bandActions($: EngineInterface): BandActions {
  return {
    typeAt: value => typedAt($, value),
    setAt: value => commitAt($, value),
    toggleAuto: auto => {
      const flipped = { isOn: !auto.isOn, at: auto.at ?? AT_DEFAULT }
      void saveAuto($, flipped).then(async () => {
        if (flipped.isOn) await askIfPast($, flipped.at)
        else await update($, autoAsk, () => null)
      })
    },
    compact: () => compactNow($),
    answer: choice => void answerAsk($, choice),
    collapse: async () => {
      // from the state, not a draw's value (an older draw's); saved for the other
      // chats first, so the half-second read never undoes the press
      const next = !(await read($, isCollapsed))
      await storeSet($, 'collapsed', next)
      await update($, isCollapsed, () => next)
    },
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quota', description: 'Toggle the Claude Code Usage Quota band above the prompt' })
    const result = await next(e)
    try {
      calib = ((await $.store.get('calib')) as typeof calib | undefined) ?? {}
    } catch {
      calib = {}
    }
    await loadAuto($)
    await syncCollapsed($)
    // a chat just opened: its limits now, unless another chat asked a moment ago
    await refresh($, 'due')
    // the exact count on a timer, never from the hook itself: work a hook starts and
    // leaves running ends with its dispatch, which is why it never ran before
    $.clock.after(2_000, () => void calibrate($))
    $.clock.every(CALIBRATE_EVERY_MS, () => void calibrate($))
    // keep it live, mid-turn included: what Claude Code already holds (the context and
    // the limits each reply carries), every 3s; timers stop when the module reloads
    $.clock.every(LOCAL_EVERY_MS, () => void refresh($))
    $.clock.every(COLLAPSE_EVERY_MS, () => void syncCollapsed($))
    // whatever surface the session started on (a desktop chat may say none)
    await syncTheme($)
    $.clock.every(THEME_EVERY_MS, () => void syncTheme($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  // the focus leaving the % field sets what was typed in it
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.element?.startsWith('autoAt')) await commitDraft($)
    return next(e)
  }).catch(($, e, next) => next(e)) // a draft that fails to set never holds the focus back

  on('ui.press', { component: 'AbovePrompt' }, async ($, e, next) => {
    await commitDraft($)
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    void commitDraft($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isBusy = true
    // the latest reading, so use since the last turn (another chat's) is not this one's
    await refreshAfter($)
    // the person is working in this chat now: auto compact runs as set from here on
    isAskFirst = false
    const snap = await read($, snapshot)
    if (isOpening) {
      isOpening = false
      if (snap && snap.limits.length > 0 && openMessages >= RESUME_MIN_TOKENS) spikeFrom = { at: await $.clock.now(), limits: snap.limits }
    }
    // where the 5 hour limit stood as this turn began, to count what it takes
    const five = snap?.limits.find(l => l.kind === 'five_hour') ?? null
    await update($, spend, s => ({ ...s, from: five }))
    await commitDraft($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refreshAfter($)
    await countSpend($)
    // the first reply is done: whatever it used, the jump is behind it
    spikeFrom = undefined
    // the turn is over: auto compact may fire now, never mid-reply
    isBusy = false
    const snap = await read($, snapshot)
    if (snap) await watchAuto($, snap.percent)
    return result
  })

  on('command.run', { command: 'quota' }, async $ => {
    const now = !(await read($, isOn))
    await update($, isOn, () => now)
    if (now) await refresh($, 'now')
    return { text: now ? 'Claude Code Usage Quota on.' : 'Claude Code Usage Quota off.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // the band is raised on these two alone; the check narrows the elements' table
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    if (e.props.hasSurvey || !(await read($, isOn))) return next(e)
    const snap = await read($, snapshot)
    if (!snap) return next(e)
    const auto = await read($, autoCompact)
    return bandTree($.ui.resolve(e), e.surface, Math.max(20, e.props.bodyColumns), {
      snap,
      now: await $.clock.now(),
      isLight: (await read($, theme)) === 'light',
      collapsed: await read($, isCollapsed),
      auto,
      ask: await read($, autoAsk),
      tick: await read($, fieldTick),
      spent: await read($, spend),
      drawnAt: (await read($, fieldText)) ?? `${auto.at ?? AT_DEFAULT}`,
    }, bandActions($))
  })
}
