// The band's tree, from plain values: the hooks module reads the state and the
// surface's elements and hands them here (the engine lets `$` cross no import).
import type { ElementTable, RenderSurface } from 'claude-code'

import type { AutoCompact, Category, Snapshot, Spend } from '../types'
import { CONTEXT_RAMP, DARK, LIGHT, LIMIT_RAMP, rampColor } from './colors'
import type { Palette } from './colors'
import { duration, forecast, headline, markerOf, order, WINDOWS } from './forecast'
import type { Forecast } from './forecast'

/** what the band draws from */
export type BandView = {
  snap: Snapshot
  now: number
  isLight: boolean
  collapsed: boolean
  auto: AutoCompact
  ask: { at: number; percent: number } | null
  /** the % field's key suffix: a new one draws the field afresh */
  tick: number
  spent: Spend
  drawnAt: string
}

/** what the band's controls do, owned by the hooks module */
export type BandActions = {
  typeAt(value: string): void
  setAt(value: string): Promise<void>
  toggleAuto(auto: AutoCompact): void
  compact(): void
  answer(choice: 'now' | 'next'): void
  collapse(): Promise<void>
}

// the % the field shows when none is set
export const AT_DEFAULT = 30

function tokens(n: number): string {
  // 1M, not 1.0M; 1.5M keeps its decimal
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${Math.round(n)}`
}

// a share of a limit: a decimal under 10% (0.5%), whole above it; no movement is
// under what the figures show, never nothing (a reply always costs something)
const share = (n: number) => (n <= 0 ? '<1%' : `${n < 10 ? Math.round(n * 10) / 10 : Math.round(n)}%`)

function colorOf(category: Category, index: number, c: Palette): string {
  if (category.kind === 'free') return c.free
  if (category.kind === 'buffer') return c.buffer
  return c.named[category.name] ?? c.palette[index % c.palette.length]!
}

// the forecast tick carries the forecast: neutral on track, yellow heading past the
// limit, red when far past it; the bar itself is coloured by what is used alone
function tickColor(f: Forecast, c: Palette): string {
  return f.status !== 'out' ? c.tick : f.projected > 130 ? c.red : c.yellow
}

type Segment = { color: string; share: number }

const BAR_PX = 7.5

// an iOS-style switch: a pill, the knob right and green when on, left and grey when off
// three cells wide, so the click area laid over it covers all of it
const SWITCH_W = 30
const SWITCH_H = 20
const SWITCH_PAD = 3
// the cells the switch's box takes: the press under it is clipped to this, so the
// app's own button tint can't spill onto the text beside it
const SWITCH_CELLS = 4
// the box behind the switch measures a pixel off the drawing (19px tall, 31 wide):
// the pill is drawn half a pixel down and right so it sits in the light's centre
const SWITCH_NUDGE = 0.5
// fully see-through: the unlit border, and the press's own hover tint, which drew a
// square frame round the light (the word "transparent" draws white or nothing)
const CLEAR = '#00000000'
// a space a wrap never breaks at
const NB = ' '
// the switch's press: figure spaces, each a digit wide, where plain spaces collapsed
// to one on the desktop and left only the pill's left edge clickable
const SWITCH_PRESS = ' '.repeat(8)

function switchSvg(isOn: boolean, c: Palette): string {
  // the pill sits inset by PAD: the light under the pointer shows around it
  const w = SWITCH_W - 2 * SWITCH_PAD
  const tall = SWITCH_H - 2 * SWITCH_PAD
  const p = SWITCH_PAD
  const knob = p + (isOn ? w - tall / 2 : tall / 2)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SWITCH_W}" height="${SWITCH_H}" viewBox="${-SWITCH_NUDGE} ${-SWITCH_NUDGE} ${SWITCH_W} ${SWITCH_H}">` +
    `<rect x="${p}" y="${p}" width="${w}" height="${tall}" rx="${tall / 2}" fill="${isOn ? c.switchOn : c.switchOff}"/>` +
    `<circle cx="${knob}" cy="${p + tall / 2}" r="${tall / 2 - 2}" fill="#ffffff"/></svg>`
  )
}

// a thin rounded bar for surfaces that draw Svg: segments laid out over 0..1000,
// with an optional tick, the bar's own height, at `marker` percent (the forecast at reset)
function barSvg(segments: Segment[], width: number, marker?: { at: number; color: string }): string {
  const height = BAR_PX
  const y = 0
  const total = segments.reduce((sum, s) => sum + s.share, 0) || 1
  let x = 0
  const rects = segments
    .map(s => {
      const w = (s.share / total) * 1000
      const rect = `<rect x="${x.toFixed(2)}" y="${y}" width="${w.toFixed(2)}" height="${BAR_PX}" fill="${s.color}"/>`
      x += w
      return rect
    })
    .join('')
  // a plain upright block 3px wide whatever the drawn width: no rounded corners
  // (stretched sideways, those drew it as a "D"), inside the bar's rounded ends so
  // nothing pokes out past them. Placed on a whole pixel and left smooth-edged: snapped
  // edges on a scaled screen drew it 3 device pixels wide on one bar and 4 on another
  const TICK_PX = 3
  const tickW = (TICK_PX / width) * 1000
  const tick =
    marker === undefined
      ? ''
      : `<rect x="${((Math.min(width - TICK_PX, Math.max(0, Math.round((marker.at / 100) * width - TICK_PX / 2))) / width) * 1000).toFixed(3)}" y="${y}" width="${tickW.toFixed(3)}" height="${BAR_PX}" fill="${marker.color}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 ${height}" preserveAspectRatio="none">` +
    `<clipPath id="r"><rect y="${y}" width="1000" height="${BAR_PX}" rx="${BAR_PX / 2}" ry="${BAR_PX / 2}"/></clipPath>` +
    `<g clip-path="url(#r)">${rects}${tick}</g></svg>`
  )
}

// the terminal's bar: one colour per cell, runs of a colour merged into one Box
function cellRuns(f: Forecast, cells: number, fill: string, c: Palette): { color: string; width: number }[] {
  const filled = Math.max(0, Math.min(cells, Math.round((f.percent / 100) * cells)))
  const marker = markerOf(f)
  const tick = marker === undefined ? -1 : Math.max(filled, Math.min(cells - 1, Math.round((marker / 100) * cells) - 1))
  const runs: { color: string; width: number }[] = []
  for (let i = 0; i < cells; i++) {
    const color = i < filled ? fill : i === tick ? tickColor(f, c) : c.track
    const last = runs[runs.length - 1]
    if (last && last.color === color) last.width += 1
    else runs.push({ color, width: 1 })
  }
  return runs
}

export function bandTree(table: ElementTable<'terminal' | 'desktop'>, surface: RenderSurface, width: number, view: BandView, act: BandActions) {
  const { snap, now, collapsed, auto, ask, tick, spent, drawnAt } = view
  const { Box, Text, Button, Input } = table
  // thin Svg bars on the desktop alone: the terminal draws coloured cells
  const Svg = surface === 'desktop' && 'Svg' in table ? table.Svg : undefined
  // the light palette is the desktop's alone: the terminal keeps its own colours
  const c = surface === 'desktop' && view.isLight ? LIGHT : DARK
  const limitColor = (p: number) => rampColor(p, LIMIT_RAMP, c)
  // both windows always, once there is any reading: one the reading lacks is not running
  const known = snap.limits.length === 0 ? [] : Object.keys(WINDOWS).map(kind => snap.limits.find(l => l.kind === kind) ?? { kind, percentUsed: 0 })
  const list = known.map(l => forecast(l, now, snap.pace?.[l.kind])).filter((f): f is Forecast => f !== null)
  const head = headline(list, now)
  // free as /context has it: the window less what is used and the autocompact buffer
  const buffer = snap.categories.find(cat => cat.kind === 'buffer')?.tokens ?? 0
  const free = Math.max(0, snap.window - snap.tokens - buffer)
  // highest first, as /context lists them: used categories, then the buffer, then free space
  const rank = (cat: Category) => (cat.kind === 'used' ? 0 : cat.kind === 'buffer' ? 1 : 2)
  const shown = snap.categories
    .map((cat, i) => ({ ...cat, color: colorOf(cat, i, c) }))
    .sort((a, b) => rank(a) - rank(b) || b.tokens - a.tokens)

  const limits = [...list].sort((a, b) => order(a.kind) - order(b.kind))
  // say so when the figures are old: the service refused and no reply has come since
  const age = snap.limitsAt === undefined ? 0 : now - snap.limitsAt
  const stale =
    snap.limitsError && age >= 2 * 60_000 && limits.length > 0
      ? `usage check ${snap.limitsError} – figures from ${duration(age)} ago`
      : snap.limitsError && limits.length === 0
        ? `usage check ${snap.limitsError}`
        : undefined
  // Laid out to the width the chat gives the band, down to the desktop's narrowest
  // chat: what fits side by side stays side by side; past that it stacks, and text
  // wraps rather than cuts off.
  // The header: the headline beside the controls when both fit, else the controls
  // on a row of their own beneath it
  // (the desktop's letters are narrower than its cells: about 0.8 of one)
  const CONTROLS = 40
  // the terminal draws its own hide control ([-]) over the band's top-right
  // corner: the first row keeps clear of it
  const HOST_HIDE = Svg ? 0 : 4
  const isHeadBeside = width >= (head?.text.length ?? 0) * (Svg ? 0.8 : 1) + CONTROLS + HOST_HIDE
  // the windows and the context side by side, or one above the other
  const isSplit = width >= 84
  const column = isSplit ? Math.floor((width - 4) / 2) : width
  // the limit bars fill their column: less the label (8) and the % (2 + 4)
  const cells = Math.max(6, column - 14)
  // collapsed: the three bars in one row, or each on a row of its own
  const isOneRow = width >= 72
  // the context's two figures on one line, or the free count on the next
  const isContextLine = column >= 38
  // the question and its two answers on one line when they fit, else the answers
  // beneath: measured from the words themselves (the desktop draws text narrower than
  // a cell each, as the headline's check allows), each button's chrome and the gaps
  const ASK_LABELS = ['Now', 'After my next compact']
  const askWords = (ask ? `Context is already at ${ask.percent}%, past ${ask.at}%. Auto compact:`.length : 0) + ASK_LABELS.join('').length
  const isAskLine = width >= askWords * (Svg ? 0.8 : 1) + ASK_LABELS.length * (Svg ? 3 : 4) + 3

  const controls = (
    <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0} flexWrap="wrap">
      {/* auto compact: the switch (the press), its name, the % field beside it,
          then a wide gap so the field reads as the switch's, not Compact's */}
      {Svg ? (
        <Box key="autoSwitch" width={SWITCH_CELLS} height={1} overflow="hidden">
          {/* three layers, each the box's full size, so all share one centre: the
              rounded light (unlit: an invisible border), the pill, the press */}
          <Box position="absolute" top={0} left={0} width={SWITCH_CELLS} height={1} borderStyle="round" borderColor={CLEAR} hover={{ backgroundColor: c.switchLit, borderColor: c.switchLit }} />
          <Box position="absolute" top={0} left={0} width={SWITCH_CELLS} height={1} alignItems="center" justifyContent="center">
            <Svg alt={`Auto compact ${auto.isOn ? 'on' : 'off'}`} source={switchSvg(auto.isOn, c)} width={SWITCH_W} height={SWITCH_H} />
          </Box>
          {/* a chromeless button over all of it takes the click; wider than the box,
              which clips it to the switch */}
          <Box position="absolute" top={0} left={0}>
            <Button key="auto" label={SWITCH_PRESS} plain hover={{ backgroundColor: CLEAR }} onPress={() => act.toggleAuto(auto)} />
          </Box>
        </Box>
      ) : (
        <Button key="auto" label={auto.isOn ? '●' : '○'} plain onPress={() => act.toggleAuto(auto)} />
      )}
      <Text color={auto.isOn ? undefined : c.muted}>Auto compact</Text>
      {auto.isOn ? (
        // the field (3 digits) sets itself once typing pauses; a plain % right after it
        <Box flexDirection="row" alignItems="center">
          {/* the field's Enter chip can't be turned off: the field is drawn wider than
              its box and the box clips the chip away */}
          <Box width={4} overflow="hidden">
            <Box width={6} flexShrink={0}>
              <Input
                key={`autoAt${tick}`}
                value={drawnAt}
                submitLabel={'​'}
                onInput={value => act.typeAt(value)}
                onSubmit={value => act.setAt(value)}
              />
            </Box>
          </Box>
          <Text color={c.muted}>%</Text>
        </Box>
      ) : Svg ? (
        // off: the field's room is kept, unseen, so the switch sits at the very same
        // spot and draws pixel for pixel as when on
        <Box flexDirection="row" alignItems="center">
          <Box width={4} />
          <Text color={CLEAR}>%</Text>
        </Box>
      ) : null}
      <Box key="compactBox" marginLeft={isHeadBeside ? 2 : 0}>
        <Button key="compact" label="Compact" hover={{ backgroundColor: c.compactLit }} onPress={() => act.compact()} />
      </Box>
      <Button
        key="collapse"
        label={collapsed ? '▲' : '▼'}
        plain
        onPress={() => act.collapse()}
      />
    </Box>
  )
  const gap = Svg ? 0.5 : 1
  const headText = <Text bold color={head ? limitColor(head.lead.percent) : c.muted} wrap="wrap">{head?.text ?? ' '}</Text>

  // one bar: an Svg on the desktop, coloured cells on the terminal
  const bar = (alt: string, segments: Segment[], barCells: number, f?: Forecast) => {
    const marker = f && markerOf(f)
    return Svg ? (
      <Box width={barCells} height={1} alignItems="center">
        <Svg alt={alt} source={barSvg(segments, barCells * 8, f && marker !== undefined ? { at: marker, color: tickColor(f, c) } : undefined)} height={BAR_PX} />
      </Box>
    ) : f ? (
      <Box flexDirection="row" width={barCells}>
        {cellRuns(f, barCells, limitColor(f.percent), c).map(run => (
          <Box width={run.width} backgroundColor={run.color}>
            <Text> </Text>
          </Box>
        ))}
      </Box>
    ) : (
      <Box flexDirection="row" width={barCells} overflow="hidden">
        {segments.map(seg => {
          const total = segments.reduce((sum, s) => sum + s.share, 0) || 1
          return (
            <Box backgroundColor={seg.color} flexGrow={Math.min(10000, Math.max(seg.share > 0 ? 1 : 0, Math.round((seg.share / total) * 1000)))} flexShrink={1}>
              <Text> </Text>
            </Box>
          )
        })}
      </Box>
    )
  }
  const limitSegments = (f: Forecast) => [
    { color: limitColor(f.percent), share: Math.min(100, f.percent) },
    { color: c.track, share: Math.max(0, 100 - f.percent) },
  ]
  // the bar in three colours: Messages, Tools, and one light grey run for Other and
  // the autocompact buffer together (drawn as one, no seam between them); then free.
  // Always in that order, so Other sits against the buffer
  const BAR_ORDER = ['Messages', 'Tools', 'Other']
  const barRank = (cat: (typeof shown)[number]) => (cat.kind === 'used' ? Math.max(0, BAR_ORDER.indexOf(cat.name)) : cat.kind === 'buffer' ? 3 : 4)
  const contextSegments = [...shown]
    .sort((a, b) => barRank(a) - barRank(b))
    .map(cat => ({ color: cat.name === 'Other' && cat.kind === 'used' ? c.buffer : cat.color, share: cat.tokens }))
    .reduce<Segment[]>((runs, seg) => {
      const last = runs[runs.length - 1]
      return last && last.color === seg.color
        ? [...runs.slice(0, -1), { ...last, share: last.share + seg.share }]
        : [...runs, { ...seg }]
    }, [])

  // this chat's part of the 5 hour limit, once a reply has been counted
  const spendNote = spent.last === null ? null : `This chat used ${share(spent.total)} – last reply ${share(spent.last)}`

  const limitsBlock = (
    <Box flexDirection="column" width={isSplit ? '50%' : undefined}>
      {limits.length === 0 ? <Text color={c.muted} wrap="wrap">Usage limits show after the first reply.</Text> : null}
      {stale ? <Text color={c.yellow} wrap="wrap">{stale}</Text> : null}
      {limits.map((f, i) => {
        // held together when the note wraps: "resets in 2d 20h" moves down whole,
        // never leaving "20h" alone on the next line
        const left = `resets in ${duration(f.resetsAt - now)}`.replace(/ /g, NB)
        const note =
          f.status === 'idle'
            ? 'starts with your next message'
            : f.status === 'out'
              ? `Limit will hit in ${duration(f.runOutAt - now)} – ${left}`
              : f.status === 'hit'
                ? `Limit reached – ${left}`
                : `On pace for about ${Math.round(Math.min(100, f.projected))}% by reset – ${left}`
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Box width={8} flexShrink={0}>
                <Text bold wrap="truncate-end">{f.label}</Text>
              </Box>
              {bar(`${f.label} ${Math.round(f.percent)}% used`, limitSegments(f), cells, f)}
              <Box marginLeft={2} flexShrink={0}>
                <Text bold color={limitColor(f.percent)}>{`${Math.round(f.percent)}%`}</Text>
              </Box>
            </Box>
            <Text color={c.muted} wrap="wrap">{note}</Text>
            {f.kind === 'five_hour' && f.status !== 'idle' && spendNote ?<Text color={c.muted} wrap="wrap">{spendNote}</Text> : null}
            {/* a whole blank line, not a margin: the desktop draws margins shorter
                than a line, which put Weekly out of step with the right column */}
            {i < limits.length - 1 ? <Text> </Text> : null}
          </Box>
        )
      })}
    </Box>
  )

  const contextColor = rampColor(snap.percent, CONTEXT_RAMP, c)
  const usedText = <Text bold color={contextColor}>{`${Math.round(snap.percent)}% used`}</Text>
  const freeText = <Text color={c.muted}>{`${tokens(free)} free of ${tokens(snap.window)}`}</Text>
  const contextName = (
    <Box flexDirection="row">
      <Text bold>Context</Text>
      <Box marginLeft={2}>{usedText}</Box>
    </Box>
  )
  const contextBlock = (
    <Box flexDirection="column" width={isSplit ? '50%' : undefined}>
      {bar(`Context ${Math.round(snap.percent)}% used`, contextSegments, column)}
      {isContextLine ? (
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          {contextName}
          {freeText}
        </Box>
      ) : (
        <Box flexDirection="column">
          {contextName}
          {freeText}
        </Box>
      )}
      {(['Messages', 'Tools', 'Other'] as const)
        .map(name => shown.find(cat => cat.name === name))
        .filter((cat): cat is (typeof shown)[number] => cat !== undefined)
        .map(cat => (
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={cat.color}>{cat.name}</Text>
            <Text color={c.muted}>{tokens(cat.tokens)}</Text>
          </Box>
        ))}
    </Box>
  )

  // collapsed, the limits go by a short name and the time to their reset: "5H 1h 3m",
  // "W 2d 21h"; a window not running shows its whole length: "5H 5h", "W 7d"
  const compactItems = [
    ...limits.map(f => ({
      label: f.label,
      short: f.kind === 'five_hour' ? '5H' : f.kind === 'seven_day' ? 'W' : f.label,
      // not running yet: the whole window, the countdown it will start from (5h, 7d)
      until: f.status === 'idle' || !Number.isFinite(f.resetsAt) ? duration(WINDOWS[f.kind]?.ms ?? 0) : duration(f.resetsAt - now),
      percent: f.percent,
      color: limitColor(f.percent), segments: limitSegments(f), f: f as Forecast | undefined,
    })),
    // Context with the whole window, as the limits have their time: 1M, 200k
    { label: 'Context', short: 'Context', until: tokens(snap.window), percent: snap.percent, color: contextColor, segments: contextSegments, f: undefined as Forecast | undefined },
  ]
  const nameOf = (item: (typeof compactItems)[number]) => (
    <Box flexDirection="row" columnGap={1} flexShrink={0}>
      <Text bold>{item.short}</Text>
      {item.until ? <Text color={c.muted}>{item.until}</Text> : null}
    </Box>
  )
  const nameLength = (item: (typeof compactItems)[number]) => item.short.length + (item.until ? item.until.length + 1 : 0)
  const third = Math.floor((width - 2 * 3) / 3)
  // Collapsed, one row: each limit sits in a slot of fixed width, so W always starts at
  // the same place: its name, room for the longest time ("4h 59m", "6d 23h"), its bar
  // (one fixed width for both), room for "100%". A shorter time moves the bar left
  // inside the slot, never the slot. Context takes all that is left, its % held to
  // the right edge, its bar as wide as fits.
  const TIME_CELLS = 6
  const limitBar = Math.max(6, third - 'Weekly'.length - '100%'.length - 2)
  const slotOf = (item: (typeof compactItems)[number]) => item.short.length + 1 + TIME_CELLS + 1 + limitBar + 1 + '100%'.length
  // between the slots: enough that a 100% never runs into the next name
  const GAP = 2
  const slotsWidth = compactItems.filter(item => item.f).reduce((sum, item) => sum + slotOf(item) + GAP, 0)
  const contextItem = compactItems[compactItems.length - 1]!
  const contextBar = Math.max(6, width - slotsWidth - nameLength(contextItem) - 1 - 1 - `${Math.round(contextItem.percent)}%`.length)
  const collapsedBlock = isOneRow ? (
    <Box flexDirection="row" columnGap={GAP}>
      {compactItems.map(item => {
        const pct = `${Math.round(item.percent)}%`
        const isContext = item === contextItem
        return (
          <Box flexDirection="row" width={isContext ? undefined : slotOf(item)} flexGrow={isContext ? 1 : 0} flexShrink={isContext ? 1 : 0}>
            <Box marginRight={1} flexShrink={0}>
              {nameOf(item)}
            </Box>
            {isContext && Svg ? (
              // on the desktop the bar stretches to fill what the row leaves, so the
              // % lands at the right edge however wide the text draws
              <Box flexGrow={1} flexShrink={1} height={1} alignItems="center">
                <Svg alt={`Context ${pct} used`} source={barSvg(item.segments, 4000)} height={BAR_PX} />
              </Box>
            ) : (
              bar(`${item.label} ${Math.round(item.percent)}% used`, item.segments, isContext ? contextBar : limitBar, item.f)
            )}
            <Box marginLeft={1} flexShrink={0} flexGrow={isContext && !Svg ? 1 : 0} justifyContent={isContext ? 'flex-end' : undefined}>
              <Text bold color={item.color}>{pct}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  ) : (
    // each on a row of its own, the names in one column (as wide as the longest) and
    // the %s in another
    (() => {
      const nameCells = Math.max(8, ...compactItems.map(item => nameLength(item) + 1))
      return (
        <Box flexDirection="column">
          {compactItems.map(item => (
            <Box flexDirection="row">
              <Box width={nameCells} flexShrink={0}>
                {nameOf(item)}
              </Box>
              {bar(`${item.label} ${Math.round(item.percent)}% used`, item.segments, Math.max(6, width - nameCells - 6), item.f)}
              <Box marginLeft={2} flexShrink={0}>
                <Text bold color={item.color}>{`${Math.round(item.percent)}%`}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )
    })()
  )

  const askText = ask ? <Text color={c.yellow} wrap="wrap">{`Context is already at ${ask.percent}%, past ${ask.at}%. Auto compact:`}</Text> : null
  const askButtons = (
    <Box flexDirection="row" columnGap={1} flexWrap="wrap" flexShrink={0}>
      <Button key="askNow" label="Now" onPress={() => act.answer('now')} />
      <Button key="askNext" label="After my next compact" onPress={() => act.answer('next')} />
    </Box>
  )

  return (
    <Box flexDirection="column">
      {isHeadBeside ? (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginBottom={gap} paddingRight={HOST_HIDE}>
          <Box flexShrink={1}>{headText}</Box>
          {controls}
        </Box>
      ) : (
        <Box flexDirection="column" marginBottom={gap}>
          <Box paddingRight={HOST_HIDE}>{headText}</Box>
          <Box marginTop={gap}>{controls}</Box>
        </Box>
      )}

      {ask ? (
        isAskLine ? (
          <Box flexDirection="row" alignItems="center" columnGap={1} marginBottom={gap}>
            <Box flexShrink={1}>{askText}</Box>
            {askButtons}
          </Box>
        ) : (
          <Box flexDirection="column" marginBottom={gap}>
            {askText}
            <Box marginTop={gap}>{askButtons}</Box>
          </Box>
        )
      ) : null}

      {collapsed ? (
        collapsedBlock
      ) : isSplit ? (
        <Box flexDirection="row" columnGap={4}>
          {limitsBlock}
          {contextBlock}
        </Box>
      ) : (
        <Box flexDirection="column">
          {limitsBlock}
          <Text> </Text>
          {contextBlock}
        </Box>
      )}
    </Box>
  )
}
