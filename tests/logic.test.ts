import { expect, test } from 'claude-code/testing'

import { stepAlerts } from '../hooks/alerts'
import { CONTEXT_RAMP, DARK, LIGHT, LIMIT_RAMP, mix, rampColor } from '../hooks/colors'
import { forecast, headline } from '../hooks/forecast'
import { en } from '../hooks/i18n/en'
import { addHistory, pickLimits, stepPace } from '../hooks/limits'
import { parseRamp, readSettings } from '../hooks/settings'

const NOW = Date.parse('2026-10-04T06:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(NOW + ms).toISOString()

test('the ramp is grey up to its first stop, yellow at its second, red from its third', async () => {
  expect(rampColor(0, LIMIT_RAMP, DARK)).toBe(DARK.muted)
  expect(rampColor(50, LIMIT_RAMP, DARK)).toBe(DARK.muted)
  expect(rampColor(75, LIMIT_RAMP, DARK)).toBe(DARK.yellow)
  expect(rampColor(95, LIMIT_RAMP, DARK)).toBe(DARK.red)
  expect(rampColor(100, LIMIT_RAMP, DARK)).toBe(DARK.red)
  expect(rampColor(NaN, LIMIT_RAMP, DARK)).toBe(DARK.muted)
  expect(rampColor(25, CONTEXT_RAMP, LIGHT)).toBe(LIGHT.muted)
  expect(rampColor(80, CONTEXT_RAMP, LIGHT)).toBe(LIGHT.red)
})

test('the ramp blends between its stops, by the % as shown (rounded)', async () => {
  expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  // 62.5 shows as 63%: 13 of the 25 points from grey to yellow
  expect(rampColor(62.5, LIMIT_RAMP, DARK)).toBe(mix(DARK.muted, DARK.yellow, 13 / 25))
  // each step up moves further from grey
  const reds = [51, 60, 70, 80, 90].map(p => parseInt(rampColor(p, LIMIT_RAMP, DARK).slice(1, 3), 16))
  expect(reds).toEqual([...reds].sort((a, b) => a - b))
})

test('a burst in the first 15% of a window does not forecast a run-out', async () => {
  // 34% in 15 minutes: alone that pace runs to 680%
  const f = forecast({ kind: 'five_hour', percentUsed: 34, resetsAt: iso(5 * HOUR - 15 * MIN) }, NOW)
  expect(f?.status).toBe('ok')
  // on the usual pace (50% a window) for the rest: 34 + 47.5
  expect(Math.round(f!.projected)).toBe(82)
  expect(headline([f!], NOW, en)?.text).toMatch(/^On track\./)
})

test('past the first 15%, the window\'s own pace blends in without a jump', async () => {
  const at = (elapsedMin: number) =>
    forecast({ kind: 'five_hour', percentUsed: 20, resetsAt: iso(5 * HOUR - elapsedMin * MIN) }, NOW)!.projected
  // 45 minutes is 15% of 5 hours: a minute either side moves the forecast by little
  expect(Math.abs(at(46) - at(44))).toBeLessThan(2)
  // a heavy pace well into the window still runs out
  expect(forecast({ kind: 'five_hour', percentUsed: 60, resetsAt: iso(4 * HOUR) }, NOW)?.status).toBe('out')
})

test('the pace store learns a finished window\'s peak without changing the store it was given', async () => {
  const before = { finals: {}, windows: { five_hour: { resetsAt: NOW - HOUR, peak: 30, skip: 0 } } }
  const frozen = JSON.stringify(before)
  const { store, isChanged, pace } = stepPace(before, [{ kind: 'five_hour', percentUsed: 5, resetsAt: iso(4 * HOUR) }], NOW)
  expect(JSON.stringify(before)).toBe(frozen)
  expect(isChanged).toBe(true)
  expect(store.finals).toEqual({ five_hour: [30] })
  expect(pace.five_hour?.typical).toBe(30)
})

test('readings merge window by window: a later window wins, a partial reply takes nothing away', async () => {
  const week = (p: number, resetsIn: number) => ({ kind: 'seven_day', percentUsed: p, resetsAt: iso(resetsIn) })
  const saved = { at: NOW - MIN, limits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: iso(HOUR) }, week(58, 3 * 24 * HOUR)] }
  // newer, but the 5 hour window alone
  const partial = pickLimits(saved, { at: NOW, limits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: iso(HOUR) }] }, undefined, NOW)
  expect(partial.limits).toEqual([{ kind: 'five_hour', percentUsed: 12, resetsAt: iso(HOUR) }, week(58, 3 * 24 * HOUR)])
  expect(partial.merged?.at).toBe(NOW)
  // an older reading of a later window still beats a newer reading of the one before
  const later = pickLimits({ at: NOW - MIN, limits: [week(2, 7 * 24 * HOUR)] }, { at: NOW, limits: [week(90, 2 * MIN)] }, undefined, NOW)
  expect(later.limits).toEqual([week(2, 7 * 24 * HOUR)])
  // a reading without its reset time moves the known window up, never down
  const up = pickLimits(saved, { at: NOW, limits: [{ kind: 'seven_day', percentUsed: 60 }] }, undefined, NOW)
  expect(up.limits.find(l => l.kind === 'seven_day')).toEqual(week(60, 3 * 24 * HOUR))
  const down = pickLimits(saved, { at: NOW, limits: [{ kind: 'seven_day', percentUsed: 3 }] }, undefined, NOW)
  expect(down.limits.find(l => l.kind === 'seven_day')).toEqual(week(58, 3 * 24 * HOUR))
  // once it has reset: 0, not running
  expect(pickLimits(saved, undefined, undefined, NOW + 2 * HOUR).limits[0]).toEqual({ kind: 'five_hour', percentUsed: 0 })
})

test('a window that ends is reported once, for the history', async () => {
  const before = { finals: {}, windows: { five_hour: { resetsAt: NOW - HOUR, peak: 30, skip: 0 } } }
  const first = stepPace(before, [{ kind: 'five_hour', percentUsed: 5, resetsAt: iso(4 * HOUR) }], NOW)
  expect(first.closed).toEqual([{ kind: 'five_hour', resetsAt: NOW - HOUR, peak: 30 }])
  expect(stepPace(first.store, [{ kind: 'five_hour', percentUsed: 6, resetsAt: iso(4 * HOUR) }], NOW).closed).toEqual([])
})

test('the history keeps the newest windows of each kind, never one twice', async () => {
  const fives = Array.from({ length: 12 }, (_, i) => ({ kind: 'five_hour', resetsAt: NOW - i * 5 * HOUR, peak: i }))
  const kept = addHistory([], fives)
  expect(kept.filter(p => p.kind === 'five_hour')).toHaveLength(10)
  expect(kept[0]!.resetsAt).toBe(NOW)
  // the same window again, from another chat: unchanged, the same list
  expect(addHistory(kept, [fives[0]!])).toBe(kept)
  const week = { kind: 'seven_day', resetsAt: NOW, peak: 70 }
  expect(addHistory(kept, [week]).filter(p => p.kind === 'seven_day')).toEqual([week])
})

test('the alert % notifies once per window, and a jump to the limit says only that', async () => {
  const five = (p: number, resetsIn = 2 * HOUR) => [{ kind: 'five_hour', percentUsed: p, resetsAt: iso(resetsIn) }]
  const first = stepAlerts({}, five(80), NOW, 90, en)
  expect(first.messages).toEqual([])
  const at90 = stepAlerts(first.alerts, five(91), NOW, 90, en)
  expect(at90.messages).toEqual(['5 Hour limit at 91% – resets in 2h.'])
  expect(stepAlerts(at90.alerts, five(95), NOW, 90, en).messages).toEqual([])
  // straight past both in a new window: one message
  const jump = stepAlerts({}, five(100), NOW, 90, en)
  expect(jump.messages).toHaveLength(1)
  expect(jump.messages[0]).toMatch(/^5 Hour limit reached\. Usage resumes at /)
  // nothing new: the very same alerts back
  expect(stepAlerts(jump.alerts, five(100), NOW, 90, en).alerts).toBe(jump.alerts)
})

test('a 5 hour window resetting is said only when it had warned', async () => {
  const warned = stepAlerts({}, [{ kind: 'five_hour', percentUsed: 92, resetsAt: iso(MIN) }], NOW, 90, en).alerts
  const after = stepAlerts(warned, [{ kind: 'five_hour', percentUsed: 0 }], NOW + 2 * MIN, 90, en)
  expect(after.messages).toEqual(['5 Hour limit reset: your full allowance is back.'])
  expect(stepAlerts(after.alerts, [{ kind: 'five_hour', percentUsed: 0 }], NOW + 3 * MIN, 90, en).messages).toEqual([])
  const quiet = stepAlerts({}, [{ kind: 'five_hour', percentUsed: 40, resetsAt: iso(MIN) }], NOW, 90, en).alerts
  expect(stepAlerts(quiet, [], NOW + 2 * MIN, 90, en).messages).toEqual([])
})

test('settings fall back to the defaults when out of range or unreadable', async () => {
  expect(readSettings({})).toEqual({
    language: 'auto',
    notify: true, alertAt: 90, chatCost: true, statusLine: true, autoCompactAt: 30, limitRamp: LIMIT_RAMP, contextRamp: CONTEXT_RAMP,
  })
  expect(readSettings({ alertAt: 20, autoCompactAt: 150 })).toMatchObject({ alertAt: 50, autoCompactAt: 99 })
  expect(parseRamp('40, 60, 85', LIMIT_RAMP)).toEqual([40, 60, 85])
  expect(parseRamp('60 40 85', LIMIT_RAMP)).toBe(LIMIT_RAMP)
  expect(parseRamp('a b c', LIMIT_RAMP)).toBe(LIMIT_RAMP)
  expect(parseRamp('10 20', LIMIT_RAMP)).toBe(LIMIT_RAMP)
})
