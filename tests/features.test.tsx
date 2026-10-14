import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit, SessionUsage } from 'claude-code'

import { chatColors, DARK } from '../hooks/colors'
import { LANGUAGES } from '../hooks/i18n'
import { en } from '../hooks/i18n/en'

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
// the /config rows of the manifest's fields, keyed as the menu keys them
const FIELDS = ['language', 'notify', 'alertAt', 'chatCost', 'statusLine', 'autoCompactAt', 'limitColors', 'contextColors']
const rowsOf = (...plugins: string[]) => plugins.flatMap(p => FIELDS.map(f => ({ key: `${p}.${f}`, label: f, kind: 'text', value: '', provider: { plugin: p, tier: 'plugin' }, isLocked: false })))

function world(on: On, state: { limits: SessionRateLimit[]; plugins?: string[] }, seed: Record<string, unknown> = {}, isSent = true) {
  const said = {
    notes: [] as string[], toasts: [] as string[], status: [] as (string | undefined)[], opened: [] as string[],
    commands: [] as { name: string; description: string }[], configs: [] as { key: string; value: unknown }[],
  }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, seed)
  on('session.usage', () => ({ value: usage(state.limits) }))
  on('session.authorize', () => ({ value: null }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    const command = e as unknown as { name: string; description: string }
    said.commands.push({ name: command.name, description: command.description })
    return { value: { command: command.name } } as never
  })
  on('config.list', () => ({ value: rowsOf(...(state.plugins ?? ['usage-quota'])) }) as never)
  on('config.set', (_$, e) => {
    said.configs.push({ key: e.key, value: e.value })
    return { value: e.value } as never
  })
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

test('/quota history opens the history pane: the running window, then the past ones under the day each began', async ($, on) => {
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
    // a blank row between groups: two of the desktop's half rows, one terminal row
    expect((await ui.drawn()) as unknown).toMatchObject({ props: { rowGap: surface === 'desktop' ? 2 : 1 } })
    expect(await ui.find({ type: 'Text', text: '5 HOUR' })).toBeDefined()
    expect(await ui.find({ key: 'open-five_hour-now' })).toBeDefined()
    // each past window by its span, under the day it began (the second began the day before)
    expect(await ui.find({ key: `open-five_hour-${NOW - HOUR}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Today · / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Yesterday · / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '100%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '40%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Average 70% · limit reached 1/2' })).toBeDefined()
    // no Weekly window has ended yet
    expect(await ui.find({ type: 'Text', text: 'Finished windows show here once they reset.' })).toBeDefined()
    await ui.unmount()
  }
})

test("each window's bar is split by the chats that used it, each in its own colour; a row unfolds them", async ($, on) => {
  const running = NOW + 4 * HOUR
  const state = { limits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: iso(4 * HOUR) }] as SessionRateLimit[] }
  const chatUse = [
    { kind: 'five_hour', resetsAt: running, chat: 'a', name: 'Fix the login bug', percent: 18 },
    { kind: 'five_hour', resetsAt: running + MIN, chat: 'b', name: 'Write the README', percent: 9 },
  ]
  const history = [{ kind: 'five_hour', resetsAt: NOW - HOUR, peak: 40 }]
  world(on, state, { history, chatUse })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const colors = chatColors(['a', 'b'], DARK)
  expect(colors.get('a')).not.toBe(colors.get('b'))
  const ui = await $.ui.mount({ plugin: 'usage-quota', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'usage-history' })
  const bar = await ui.find({ type: 'Svg', text: 'Now: 30%' }) ?? (await ui.findAll({ type: 'Svg' }))[0]
  const source = String(bar?.props.source)
  expect(source).toContain(colors.get('a')!)
  expect(source).toContain(colors.get('b')!)
  // folded: no names yet
  expect(await ui.find({ type: 'Text', text: 'Fix the login bug' })).toBeUndefined()
  await ui.press({ key: 'open-five_hour-now' })
  expect(await ui.find({ type: 'Text', text: 'Fix the login bug' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Write the README' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '18%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '9%' })).toBeDefined()
  // what no chat here recorded (claude.ai, another device) is grey, as Other
  expect(await ui.find({ type: 'Text', text: 'Other / not recorded' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '3%' })).toBeDefined()
  // a window from before any chat was recorded says so
  await ui.press({ key: `open-five_hour-${NOW - HOUR}` })
  expect(await ui.find({ type: 'Text', text: 'No per-chat record for this window.' })).toBeDefined()
  // pressed again, the running window folds
  await ui.press({ key: 'open-five_hour-now' })
  expect(await ui.find({ type: 'Text', text: 'Fix the login bug' })).toBeUndefined()
  await ui.unmount()
})

test('chats that ran at once (each move counting the other) are scaled to the window, in the bar and the list', async ($, on) => {
  const running = NOW + 4 * HOUR
  const state = { limits: [{ kind: 'five_hour', percentUsed: 4, resetsAt: iso(4 * HOUR) }] as SessionRateLimit[] }
  const chatUse = [
    { kind: 'five_hour', resetsAt: running, chat: 'a', name: 'First', percent: 4 },
    { kind: 'five_hour', resetsAt: running, chat: 'b', name: 'Second', percent: 4 },
  ]
  world(on, state, { chatUse })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-quota', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'usage-history' })
  await ui.press({ key: 'open-five_hour-now' })
  expect(await ui.findAll({ type: 'Text', text: '2%' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: 'Other / not recorded' })).toBeUndefined()
  await ui.unmount()
})

test("a turn's share of each limit is recorded for the history under the chat's first typed prompt", async ($, on) => {
  const state = { limits: [
    { kind: 'five_hour', percentUsed: 10, resetsAt: iso(4 * HOUR) },
    { kind: 'seven_day', percentUsed: 50, resetsAt: iso(3 * 24 * HOUR) },
  ] as SessionRateLimit[] }
  const { clock } = world(on, state)
  on('session.id', () => ({ value: 'chat-1' }) as never)
  on('session.messages', () => ({ value: [
    { role: 'user', text: '<command-name>/quota</command-name>', toolUses: [] },
    { role: 'user', text: 'Make   the history' + String.fromCharCode(10) + ' pane nicer', toolUses: [] },
  ] }) as never)
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  state.limits = [
    { kind: 'five_hour', percentUsed: 14, resetsAt: iso(4 * HOUR) },
    { kind: 'seven_day', percentUsed: 51, resetsAt: iso(3 * 24 * HOUR) },
  ]
  await clock.advance(1_000)
  await $.turn.complete({ answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  // the history pane shows it: this chat by its first typed prompt, 4% of the 5 hour, 1% of the week
  const ui = await $.ui.mount({ plugin: 'usage-quota', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'usage-history' })
  await ui.press({ key: 'open-five_hour-now' })
  await ui.press({ key: 'open-seven_day-now' })
  expect(await ui.findAll({ type: 'Text', text: 'Make the history pane nicer' })).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: '4%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1%' })).toBeDefined()
  await ui.unmount()
})

test('typing /quota lists all three commands: the band, its history and its settings', async ($, on) => {
  const { said } = world(on, { limits: [] })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(said.commands.map(c => c.name)).toEqual(['quota', 'quota-history', 'quota-settings'])
  await $.command.run({ command: 'quota-settings', args: '' } as never)
  await $.command.run({ command: 'quota-history', args: '' } as never)
  await $.command.run({ command: 'quota', args: 'settings' } as never)
  expect(said.opened).toEqual(['usage-settings', 'usage-history', 'usage-settings'])
})

test('the band speaks the language set: Turkish words, Turkish times', { options: { language: 'tr' } }, async ($, on) => {
  const state = { limits: [
    { kind: 'five_hour', percentUsed: 7, resetsAt: iso(4 * HOUR) },
    { kind: 'seven_day', percentUsed: 57, resetsAt: iso(5 * 24 * HOUR) },
  ] as SessionRateLimit[] }
  const { said } = world(on, state)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  expect(said.commands[0]?.description).toBe('Kullanım şeridini aç veya kapat')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'usage-quota', surface, component: 'AbovePrompt', props: PROPS })
    // NOW is a Sunday: Weekly, on course to run out, resets on Friday ("Cuma")
    expect(await ui.find({ type: 'Text', text: 'Bu hızla Cuma günkü sıfırlamadan önce limitin dolacak.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5 Saat' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Haftalık' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Bağlam' })).toBeDefined()
    expect(await ui.find({ type: 'Button', label: 'Sıkıştır' } as never)).toBeDefined()
    await ui.unmount()
  }
})

test("set to auto, the band follows the desktop app's language", async ($, on) => {
  const state = { limits: [{ kind: 'seven_day', percentUsed: 57, resetsAt: iso(5 * 24 * HOUR) }] as SessionRateLimit[] }
  world(on, state)
  on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'APPDATA' ? 'C:/AppData' : undefined }) as never)
  on('fs.stat', () => ({ value: { kind: 'file', size: 100, mtimeMs: 1, isLink: false } }) as never)
  on('fs.read', () => ({ value: JSON.stringify({ userThemeMode: 'dark', locale: 'de-DE' }) }) as never)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-quota', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: 'Wöchentlich' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Kontext' })).toBeDefined()
  await ui.unmount()
})

test('the settings pane changes a setting through the config, as the menu would', async ($, on) => {
  const { said } = world(on, { limits: [] })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'usage-quota', surface, component: 'Pane', props: { ...PANE_PROPS, title: 'Usage settings' }, requestId: 'usage-settings' })
    expect(await ui.find({ type: 'Text', text: 'Language' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Alert at' })).toBeDefined()
    await ui.select({ key: 'language', value: 'ja' })
    await ui.select({ key: 'alertAt', value: '80' })
    await ui.select({ key: 'notify', value: 'false' })
    await ui.input({ key: 'limitColors', text: '40 60 85' })
    await ui.unmount()
  }
  expect(said.configs.slice(0, 4)).toEqual([
    { key: 'usage-quota.language', value: 'ja' },
    { key: 'usage-quota.alertAt', value: 80 },
    { key: 'usage-quota.notify', value: false },
    { key: 'usage-quota.limitColors', value: '40 60 85' },
  ])
})

test("with the desktop app loading a second copy, a setting changes in every copy's row", async ($, on) => {
  // two enabled plugins share the name: the menu keys each row by the plugin's id
  const { said } = world(on, { limits: [], plugins: ['usage-quota@4anti-mods', 'usage-quota@inline'] })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'usage-quota', surface: 'desktop', component: 'Pane', props: { ...PANE_PROPS, title: 'Usage settings' }, requestId: 'usage-settings' })
  await ui.select({ key: 'autoCompactAt', value: '50' })
  await ui.unmount()
  expect(said.configs).toEqual([
    { key: 'usage-quota@4anti-mods.autoCompactAt', value: 50 },
    { key: 'usage-quota@inline.autoCompactAt', value: 50 },
  ])
  expect(said.toasts).toEqual([])
})

test('every language has every word, and its placeholders', async () => {
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',')
  for (const [code, strings] of Object.entries(LANGUAGES)) {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect({ code, key, value: typeof strings[key] }).toEqual({ code, key, value: 'string' })
      if (key !== 'locale' && key !== 'name') expect({ code, key, holes: holes(strings[key]) }).toEqual({ code, key, holes: holes(en[key]) })
    }
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
