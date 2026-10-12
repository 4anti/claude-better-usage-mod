import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit, SessionUsage } from 'claude-code'

const NOW = Date.parse('2026-10-04T06:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(NOW + ms).toISOString()
const GREY = '#9b9a96'

const PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} }
const PANE_PROPS = { title: 'Usage history', isFocused: false, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
const MEASURE = { context: { window: 1_000_000, tokens: 158_000, percent: 16 }, rateLimits: [] } as never
const SURFACES = ['terminal', 'desktop'] as const

function usage(rateLimits: SessionRateLimit[]): SessionUsage {
  return {
    startedAt: NOW - HOUR,
    context: { window: 1_000_000, tokens: 158_000, percent: 16, breakdown: { categories: [], totalTokens: 158_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, percentage: 16 } as never },
    rateLimits,
  }
}

// the engine beneath the plugin; what it was asked to say and pin is kept
function world(on: On, state: { limits: SessionRateLimit[] }, seed: Record<string, unknown> = {}, isSent = true) {
  const said = { notes: [] as string[], toasts: [] as string[], status: [] as (string | undefined)[], opened: [] as string[] }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, seed)
  on('session.usage', () => ({ value: usage(state.limits) }))
  on('session.authorize', () => ({ value: null }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }) as never)
  on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.notify', (_$, e) => {
    said.notes.push(e.text)
    return { value: isSent ? { isSent: true, channel: 'iterm2' } : { isSent: false, reason: 'no-surface' } } as never
  })
  on('ui.toast', (_$, e) => {
    said.toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    said.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    said.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  return { clock, said }
}

test('a limit reaching 90% notifies once, and the limit itself once more', async ($, on) => {
  const state = { limits: [{ kind: 'five_hour', percentUsed: 85, resetsAt: iso(2 * HOUR) }] as SessionRateLimit[] }
  const { clock, said } = world(on, state)
  await $.session.measure(MEASURE)
  expect(said.notes).toEqual([])
  state.limits = [{ kind: 'five_hour', percentUsed: 91, resetsAt: iso(2 * HOUR) }]
  await clock.advance(1_000)
  await $.session.measure(MEASURE)
  await $.session.measure(MEASURE)
  expect(said.notes).toEqual(['5 Hour limit at 91% – resets in 2h.'])
  state.limits = [{ kind: 'five_hour', percentUsed: 100, resetsAt: iso(2 * HOUR) }]
  await clock.advance(1_000)
  await $.session.measure(MEASURE)
  expect(said.notes).toHaveLength(2)
  expect(said.notes[1]).toMatch(/^5 Hour limit reached\. Usage resumes at /)
})

test('where no notification can be sent (the desktop app), the alert is a toast', async ($, on) => {
  const state = { limits: [{ kind: 'seven_day', percentUsed: 93, resetsAt: iso(2 * 24 * HOUR) }] as SessionRateLimit[] }
  const { said } = world(on, state, {}, false)
  await $.session.measure(MEASURE)
  expect(said.toasts).toEqual(['Weekly limit at 93% – resets in 2d.'])
})

test('alerts turned off in the settings say nothing', { options: { notify: false } }, async ($, on) => {
  const state = { limits: [{ kind: 'five_hour', percentUsed: 99, resetsAt: iso(2 * HOUR) }] as SessionRateLimit[] }
  const { said } = world(on, state)
  await $.session.measure(MEASURE)
  expect(said.notes).toEqual([])
})

test('with the band off, the status line carries the usage, and goes when it is back', async ($, on) => {
  const state = { limits: [
    { kind: 'five_hour', percentUsed: 7, resetsAt: iso(4 * HOUR) },
    { kind: 'seven_day', percentUsed: 57, resetsAt: iso(5 * 24 * HOUR) },
  ] as SessionRateLimit[] }
  const { said } = world(on, state)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'quota', args: '' } as never)
  expect(said.status.at(-1)).toBe('5H 7% · Weekly 57% · Context 16%')
  await $.command.run({ command: 'quota', args: '' } as never)
  expect(said.status.at(-1)).toBeUndefined()
})

test('/quota history opens the history pane: the running window, then the past ones', async ($, on) => {
  const state = { limits: [{ kind: 'five_hour', percentUsed: 7, resetsAt: iso(4 * HOUR) }] as SessionRateLimit[] }
  const history = [
    { kind: 'five_hour', resetsAt: NOW - HOUR, peak: 100 },
    { kind: 'five_hour', resetsAt: NOW - 6 * HOUR, peak: 40 },
  ]
  const { said } = world(on, state, { history })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'quota', args: 'history' } as never)
  expect(said.opened).toEqual(['usage-history'])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'usage-quota', surface, component: 'Pane', props: PANE_PROPS, requestId: 'usage-history' })
    expect(await ui.find({ type: 'Text', text: '5 Hour' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Now' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '100%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '40%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Average 70% · reached the limit 1 of 2 times' })).toBeDefined()
    // no Weekly window has ended yet
    expect(await ui.find({ type: 'Text', text: 'Finished windows show here once they reset.' })).toBeDefined()
    await ui.unmount()
  }
})

test('the settings move the colours and can hide what the chat used', { options: { limitColors: '10 20 30', chatCost: false } }, async ($, on) => {
  const state = { limits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: iso(3 * HOUR) }] as SessionRateLimit[] }
  const { clock } = world(on, state)
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  state.limits = [{ kind: 'five_hour', percentUsed: 30, resetsAt: iso(3 * HOUR) }]
  await clock.advance(1_000)
  await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  const ui = await $.ui.mount({ plugin: 'usage-quota', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  // red at 30% by these settings, not grey
  expect((await ui.find({ type: 'Text', text: '30%' }))?.props.color).not.toBe(GREY)
  expect((await ui.find({ type: 'Text', text: '30%' }))?.props.color).toBe('#e5534b')
  expect(await ui.find({ text: /^This chat used/ })).toBeUndefined()
  await ui.unmount()
})
