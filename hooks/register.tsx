import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AutoCompact, Category, Hold, Limit, PaceOf, Snapshot, Spend } from '../types'
import { stepAlerts } from './alerts'
import type { Alerts } from './alerts'
import { bandTree, summary } from './band'
import type { BandActions } from './band'
import { sameWindow } from './forecast'
import { historyTree } from './history'
import { addHistory, AskError, isPlanDue, nextBackoff, parsePlan, pickLimits, retryAfterMs, spikeOf, stepPace, sumGroups } from './limits'
import type { Ask, Backoff, Group, PaceStore, Past, Saved } from './limits'
import { fmt, resolveLanguage, stringsOf } from './i18n'
import { readSettings } from './settings'
import { settingsTree } from './settings-pane'

// what the config menu set, read again on every load (a change there reloads)
let settings = readSettings()
const HISTORY_PANE = 'usage-history'
const SETTINGS_PANE = 'usage-settings'
// the band's words, in the language set or the one detected (applyLanguage)
let t = stringsOf('en')
// the desktop app's own language, from its settings (read beside its theme)
let appLocale: string | undefined

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
// the language the band draws in, as a code: a change redraws it
const language = atom({ plugin: 'usage-quota', key: 'language' } as const, 'en')

// the setting's language, else the app's, else the shell's (LC_ALL, LANG), else English
let shellLocale: string | undefined
async function applyLanguage($: EngineInterface): Promise<void> {
  const code = resolveLanguage(settings.language, appLocale, shellLocale)
  t = stringsOf(code)
  if (code !== (await read($, language))) await update($, language, () => code)
}

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
  if (isPlanDue(ask, now, askedAt, backoff)) {
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
      backoff = nextBackoff(backoff, error, now)
      await storeSet($, 'planBackoff', backoff)
    }
  }
  const { merged, limits } = pickLimits(saved, live, (await storeGet($, 'planLimits')) as Saved | undefined, now)
  // newer reply figures go to the store too, merged whole, so other chats get them
  // and no chat's partial reply takes a window away from the rest
  if (merged && live && (!saved || live.at > saved.at)) await storeSet($, 'limits', merged)
  return { limits, at: merged?.at, error: backoff?.error || undefined }
}

// A chat reopened with a long history re-reads it all on its first reply: that jump is
// left out of the pace. Only for a chat opened with this much in it (spikeOf).
const RESUME_MIN_TOKENS = 20_000
let isOpening = true
let openMessages = 0
let spikeFrom: Saved | undefined

async function trackPace($: EngineInterface, limits: Limit[], now: number): Promise<Record<string, PaceOf>> {
  const spike = spikeOf(spikeFrom, live)
  if (spike) spikeFrom = undefined
  const saved = ((await storeGet($, 'pace')) as PaceStore | undefined) ?? { finals: {}, windows: {} }
  const { store, isChanged, pace, closed } = stepPace(saved, limits, now, spike)
  if (isChanged) await storeSet($, 'pace', store)
  // the windows that ended join the history pane's list, shared by every chat
  if (closed.length > 0) {
    const past = ((await storeGet($, 'history')) as Past[] | undefined) ?? []
    const next = addHistory(past, closed)
    if (next !== past) await storeSet($, 'history', next)
  }
  return pace
}

// A notification through the person's own channel; the desktop app has none for
// plugins, so there (and wherever it is not sent) it is a toast in the app instead.
async function notify($: EngineInterface, text: string): Promise<void> {
  const sent = await $.ui.notify(text, { title: 'Claude usage' }).catch(() => undefined)
  if (!sent?.isSent) $.ui.toast(text, { timeoutMs: 10_000 })
}

// shortcut: two chats reading the store at once may both notify; lock across chats if seen
async function checkAlerts($: EngineInterface, limits: Limit[], now: number): Promise<void> {
  if (limits.length === 0) return
  const prev = ((await storeGet($, 'alerts')) as Alerts | undefined) ?? {}
  const { alerts, messages } = stepAlerts(prev, limits, now, settings.alertAt, t)
  if (alerts === prev) return
  await storeSet($, 'alerts', alerts)
  // turned off, the alerts still move on: turning them on never sends old news
  if (settings.notify) for (const text of messages) await notify($, text)
}

// a pane opened by the person's command, and the line the command answers with
async function openPane($: EngineInterface, id: string, title: string): Promise<string> {
  const opened = await $.ui.open({ id, title })
  return fmt(opened.isPlaced ? t.paneOpened : t.paneWaits, { title })
}

// a setting changed from the pane as the config menu would: the mod reloads with it
async function setSetting($: EngineInterface, field: string, value: string | number | boolean): Promise<void> {
  try {
    const result = await $.config.set({ key: `usage-quota.${field}`, value })
    if ('deny' in result && result.deny) $.ui.toast(fmt(t.settingFailed, { reason: result.deny }))
  } catch (error) {
    $.ui.toast(fmt(t.settingFailed, { reason: error instanceof Error ? error.message : String(error) }))
  }
}

// the status line: a refresh's error, or the usage while the band is off; set on change
let shownStatus: string | undefined
function showStatus($: EngineInterface, text: string | undefined): void {
  if (text === shownStatus) return
  shownStatus = text
  $.ui.status(text)
}

// The free local breakdown ('summary') reads tools ~1.3-1.6x heavy; the exact count
// ('full', as /context shows) costs no tokens but one token-count request per tool and
// memory file. So it runs every 2 minutes, and its exact/estimate ratio of Tools and
// Other scales the live 3s estimate; Messages is the API's real total less those two.
const CALIBRATE_EVERY_MS = 2 * 60_000
let calib: Partial<Record<Group, number>> = {}
let isCalibrating = false
// Right after /compact there is no API reply yet, so the window's real total is unknown
// and the local estimate is all there is. The exact count fills that gap until the next reply.
let exactCount: { at: number; sums: Record<Group, number> } | undefined
let noReplySince: number | undefined

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

// Auto compact fires when the chat is idle and the context (rounded) is at or past the
// %, held back only by `waits` (the band asks, or "after my next compact", cleared by a
// real compaction) and `stuck` (it compacted and is still past: cleared by dropping below).
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

// Auto compact compacts through the session (a /compact run from a turn's end is refused
// while it winds down), tried again a few times, 2 seconds apart, while a turn runs.
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
      if (result && 'skip' in result && result.skip) $.ui.toast(fmt(t.autoSkipped, { reason: result.skip }))
      lastSnapshot = ''
      const usage = await $.session.usage({ breakdown: 'summary' })
      const percent = usage.context.percent ?? 0
      // still past the % after compacting: say so once, and do not loop on it
      const auto = await read($, autoCompact)
      if (auto.at !== null && Math.round(percent) >= auto.at) {
        $.ui.toast(fmt(t.stillPast, { percent: Math.round(percent), at: auto.at }))
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
      $.ui.toast(fmt(t.autoFailed, { reason }))
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
  $.ui.toast(fmt(t.autoCompacting, { percent: Math.round(percent), at: auto.at }))
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

// auto compact is set per chat; a chat with none opens with the last setting chosen
// anywhere. Read again whenever the chat's id changes (a /clear goes on under a new one)
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
  await update($, autoCompact, () => (own ? { ...own, at: own.at ?? settings.autoCompactAt } : { isOn: false, at: settings.autoCompactAt }))
  if (!isNewChat) return
  await update($, hold, () => ({ chat: id, waits: false, stuck: false }))
  await update($, autoAsk, () => null)
  await update($, spend, () => ({ chat: id, total: 0, last: null, from: null }))
}

// the % field sets on Enter, or when the focus leaves it with a draft; 15 to 99, outside
// is pulled in. After a set the field is drawn afresh (fieldTick), dropping its focus
const AT_MIN = 15
const AT_MAX = 99
let draftAt: string | null = null

// no event says a click landed outside the band: a draft sets itself once typing rests
const AT_REST_MS = 2_000
let restTimer: { cancel(): void } | null = null

// the field takes 3 digits at most: anything else is dropped by redrawing it cleaned
const AT_DIGITS = 3
// a mark of no width, so a cleaned text equal to the one drawn still redraws (an
// unchanged value would leave the typing as it is) without a new field losing focus
const NO_WIDTH = '​'

function cleanAt(value: string): string {
  return value.replace(/\D/g, '').slice(0, AT_DIGITS)
}

// what the field shows comes from state: a press or typing runs apart from the draw
async function redrawField($: EngineInterface, value: string): Promise<void> {
  const at = (await read($, autoCompact)).at ?? settings.autoCompactAt
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
  const typed = text === '' ? settings.autoCompactAt : Number(text)
  const at = Math.min(AT_MAX, Math.max(AT_MIN, typed))
  if (typed !== at) $.ui.toast(fmt(typed < at ? t.atLeast : t.atMost, { at }))
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
  if (!isPast && at !== null) $.ui.toast(fmt(t.autoArmed, { at }))
}

async function answerAsk($: EngineInterface, choice: 'now' | 'next'): Promise<void> {
  await update($, autoAsk, () => null)
  // 'next': goes on waiting until a compaction is seen (the reply total goes blank)
  if (choice === 'now') {
    await setHold($, { waits: false })
    autoCompactNow($)
  }
}

// What a turn took of the 5 hour limit: how far it moved across the turn.
// shortcut: the limit is the whole account's, so another chat's use during the turn
// counts too, and between the service's answers the figures are whole percents; exact
// per-reply cost needs token counts priced per model
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

// collapsed or not is one setting for every chat, in the shared store, read twice a second
const COLLAPSE_EVERY_MS = 500
async function syncCollapsed($: EngineInterface): Promise<void> {
  const saved = ((await storeGet($, 'collapsed')) as boolean | undefined) === true
  if (saved !== (await read($, isCollapsed))) await update($, isCollapsed, () => saved)
}

// The desktop app's theme (and language) is read from its own settings every 2s, each
// look one file-time check; for a "system" theme the OS is asked at most every 15s
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
// (the app's language is read from the same file, so a switch there shows at once too)
let themeFile: { mtimeMs: number; mode: string | undefined } | undefined
async function syncTheme($: EngineInterface): Promise<void> {
  let mode: string | undefined
  try {
    const path = await desktopConfig($)
    if (!path) return
    const { mtimeMs } = await $.fs.stat(path)
    if (themeFile?.mtimeMs === mtimeMs) mode = themeFile.mode
    else {
      const config = JSON.parse(await $.fs.read(path)) as { userThemeMode?: string; locale?: string }
      mode = config.userThemeMode
      themeFile = { mtimeMs, mode }
      if (config.locale !== appLocale) {
        appLocale = config.locale
        await applyLanguage($)
      }
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
    await checkAlerts($, limits, now)
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
    showStatus($, settings.statusLine && !(await read($, isOn)) ? summary(next, t) : undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showStatus($, `usage-quota: ${message.replace(/^usage-quota: /, '')}`)
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
      const flipped = { isOn: !auto.isOn, at: auto.at ?? settings.autoCompactAt }
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

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    // the language first: the commands are described in it
    try {
      shellLocale = (await $.env.get('LC_ALL')) ?? (await $.env.get('LANG'))
    } catch {
      // no shell language: the app's, else English
    }
    await syncTheme($)
    await applyLanguage($)
    // each its own command, so typing /quota lists all three
    await $.command.register({ name: 'quota', description: t.cmdQuota, argumentHint: '[history | settings]' })
    await $.command.register({ name: 'quota-history', description: t.cmdHistory })
    await $.command.register({ name: 'quota-settings', description: t.cmdSettings })
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

  on('command.run', { command: 'quota' }, async ($, e) => {
    const sub = e.args.trim()
    if (sub === 'history') return { text: await openPane($, HISTORY_PANE, t.historyTitle) }
    if (sub === 'settings') return { text: await openPane($, SETTINGS_PANE, t.settingsTitle) }
    const now = !(await read($, isOn))
    await update($, isOn, () => now)
    // on: the limits at once; off: the status line takes over
    if (now) await refresh($, 'now')
    else await refreshAfter($)
    return { text: now ? t.bandOn : t.bandOff }
  })

  on('command.run', { command: 'quota-history' }, async $ => ({ text: await openPane($, HISTORY_PANE, t.historyTitle) }))
  on('command.run', { command: 'quota-settings' }, async $ => ({ text: await openPane($, SETTINGS_PANE, t.settingsTitle) }))

  on('ui.render', { component: 'Pane', requestId: HISTORY_PANE }, async ($, e) => {
    const snap = await read($, snapshot)
    return historyTree($.ui.resolve(e), e.surface, Math.max(30, e.props.bodyColumns), {
      past: ((await storeGet($, 'history')) as Past[] | undefined) ?? [],
      limits: snap?.limits ?? [],
      now: await $.clock.now(),
      isLight: (await read($, theme)) === 'light',
      ramp: settings.limitRamp,
      t: stringsOf(await read($, language)),
    })
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e, next) => {
    // its pickers and fields are the terminal's and the desktop's
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    return settingsTree($.ui.resolve(e), e.surface, {
      settings,
      t: stringsOf(await read($, language)),
      isLight: (await read($, theme)) === 'light',
    }, (field, value) => void setSetting($, field, value))
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
      drawnAt: (await read($, fieldText)) ?? `${auto.at ?? settings.autoCompactAt}`,
      limitRamp: settings.limitRamp,
      contextRamp: settings.contextRamp,
      chatCost: settings.chatCost,
      t: stringsOf(await read($, language)),
    }, bandActions($))
  })
}
