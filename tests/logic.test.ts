import { expect, test } from 'claude-code/testing'

import { CONTEXT_RAMP, DARK, LIGHT, LIMIT_RAMP, mix, rampColor } from '../hooks/colors'
import { forecast, headline } from '../hooks/forecast'
import { stepPace } from '../hooks/limits'

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
  expect(headline([f!], NOW)?.text).toMatch(/^On track\./)
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
