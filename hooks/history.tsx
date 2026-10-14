// The history pane's tree, from plain values: each window's peak as a bar split by the
// chats that used it, each chat in its own colour, newest first with the running one on
// top, 5 hour windows under the day they began. A row's arrow unfolds the chats behind it.
// The hooks module reads the store and hands it here.
import type { ElementTable, RenderSurface } from 'claude-code'

import type { Limit } from '../types'
import { BAR_PX, barSvg, cellsOf, share } from './band'
import { chatColors, DARK, LIGHT, rampColor } from './colors'
import type { Palette, Ramp } from './colors'
import { dayOf, duration, SAME_WINDOW_MS, spanOf, windowName, WINDOWS } from './forecast'
import { fmt } from './i18n'
import type { Strings } from './i18n'
import type { ChatUse, Past } from './limits'

export type HistoryView = {
  past: Past[]; limits: Limit[]; chatUse: ChatUse[]; open: string[]
  now: number; isLight: boolean; ramp: Ramp; t: Strings
}

type Segment = { color: string; share: number }
type Row = { key: string; label: string; resetsAt: number; peak: number; uses: ChatUse[] }

// the label column at least this wide; the bar at least this, the label giving way first
const NAME_MIN = 8
const BAR_MIN = 4
const PERCENT_CELLS = 5
const OPEN = '▾'
const SHUT = '▸'
// a remainder under this is rounding, not a chat nobody recorded
const OTHER_MIN = 1

// The bar's parts: each chat's share in its colour (scaled down should they sum past the
// peak: whole-percent figures, another chat's use mid-turn), the rest grey, then the track.
// A window with no chat recorded keeps one fill, coloured by how close it came to the limit
const scaleOf = (row: Row) => {
  const recorded = row.uses.reduce((sum, u) => sum + u.percent, 0)
  const peak = Math.min(100, Math.max(0, row.peak))
  return recorded > peak ? peak / recorded : 1
}

function segmentsOf(row: Row, colors: Map<string, string>, fill: string, c: Palette): Segment[] {
  const peak = Math.min(100, Math.max(0, row.peak))
  const recorded = row.uses.reduce((sum, u) => sum + u.percent, 0)
  const scale = scaleOf(row)
  const chats = row.uses.map(u => ({ color: colors.get(u.chat) ?? c.muted, share: u.percent * scale }))
  const rest = { color: row.uses.length > 0 ? c.muted : fill, share: peak - recorded * scale }
  return [...chats, rest, { color: c.track, share: 100 - peak }].filter(s => s.share > 0)
}

// the terminal's bar: the parts as runs of cells, each end rounded from the running total
// so the runs always fill the bar exactly
function runsOf(segments: Segment[], cells: number): { color: string; width: number }[] {
  const ends = segments.map((_, i) => Math.round((segments.slice(0, i + 1).reduce((sum, s) => sum + s.share, 0) / 100) * cells))
  return segments.map((s, i) => ({ color: s.color, width: ends[i]! - (ends[i - 1] ?? 0) })).filter(r => r.width > 0)
}

export function historyTree(table: ElementTable<RenderSurface>, surface: RenderSurface, width: number, view: HistoryView, onToggle: (key: string) => void) {
  const { Box, Text, Button } = table
  const { t } = view
  const Svg = surface === 'desktop' && 'Svg' in table ? table.Svg : undefined
  const c = surface === 'desktop' && view.isLight ? LIGHT : DARK
  // one blank row between groups: the desktop counts vertical margins in half rows
  const blank = surface === 'desktop' ? 2 : 1
  const colors = chatColors([...new Set([...view.chatUse].sort((a, b) => b.resetsAt - a.resetsAt).map(u => u.chat))], c)

  const usesOf = (kind: string, resetsAt: number) =>
    view.chatUse.filter(u => u.kind === kind && Math.abs(u.resetsAt - resetsAt) <= SAME_WINDOW_MS).sort((a, b) => b.percent - a.percent)
  const rowsOf = (kind: string) => {
    const live = view.limits.find(l => l.kind === kind)
    const resetsAt = live?.resetsAt ? Date.parse(live.resetsAt) : NaN
    const running: Row | undefined = live !== undefined && Number.isFinite(resetsAt) && resetsAt > view.now
      ? { key: `${kind}-now`, label: t.now, resetsAt, peak: live.percentUsed, uses: usesOf(kind, resetsAt) }
      : undefined
    const past: Row[] = view.past.filter(p => p.kind === kind).map(p =>
      ({ key: `${kind}-${p.resetsAt}`, label: spanOf(p.resetsAt, kind, t), resetsAt: p.resetsAt, peak: p.peak, uses: usesOf(kind, p.resetsAt) }))
    return { kind, running, past }
  }
  const sections = Object.keys(WINDOWS).map(rowsOf)

  // one label column for every section, so the bars line up down the pane
  const labels = sections.flatMap(s => [...(s.running ? [s.running.label] : []), ...s.past.map(r => r.label)])
  // in cells: a wide (CJK) glyph takes two
  const nameCells = Math.min(width - PERCENT_CELLS - 1 - BAR_MIN, Math.max(NAME_MIN, ...labels.map(l => cellsOf(l) + 3)))
  const cells = Math.max(BAR_MIN, width - nameCells - PERCENT_CELLS - 1)

  const bar = (segments: Segment[], alt: string) =>
    Svg ? (
      <Box width={cells} height={1} alignItems="center">
        <Svg alt={alt} source={barSvg(segments, cells * 8)} height={BAR_PX} />
      </Box>
    ) : (
      <Box flexDirection="row" width={cells}>
        {runsOf(segments, cells).map((r, i) => <Box key={`run-${i}`} width={r.width} backgroundColor={r.color}><Text> </Text></Box>)}
      </Box>
    )

  const chatLine = (key: string, color: string, name: string, percent: number) => (
    <Box key={key} flexDirection="row" marginLeft={2}>
      <Text color={color}>● </Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{name}</Text>
      </Box>
      <Box marginLeft={1} width={PERCENT_CELLS} flexShrink={0} justifyContent="flex-end">
        <Text color={c.muted}>{share(percent)}</Text>
      </Box>
    </Box>
  )

  const chatList = (row: Row) => {
    if (row.uses.length === 0) {
      return <Box marginLeft={2}><Text color={c.muted} wrap="wrap">{t.noChatUse}</Text></Box>
    }
    // the same scale as the bar's, so the shares never add up past the window's %
    const scale = scaleOf(row)
    const other = row.peak - row.uses.reduce((sum, u) => sum + u.percent * scale, 0)
    return (
      <Box flexDirection="column">
        {row.uses.map(u => chatLine(`${row.key}-${u.chat}`, colors.get(u.chat) ?? c.muted, u.name, u.percent * scale))}
        {other >= OTHER_MIN ? chatLine(`${row.key}-other`, c.muted, t.otherUse, other) : null}
      </Box>
    )
  }

  const windowRow = (row: Row) => {
    const isOpen = view.open.includes(row.key)
    const fill = rampColor(row.peak, view.ramp, c)
    const percent = `${Math.round(row.peak)}%`
    return (
      <Box key={row.key} flexDirection="column">
        <Box flexDirection="row" alignItems="center">
          <Box width={nameCells} flexShrink={0}>
            <Button key={`open-${row.key}`} plain onPress={() => onToggle(row.key)}>{`${isOpen ? OPEN : SHUT} ${row.label}`}</Button>
          </Box>
          {bar(segmentsOf(row, colors, fill, c), `${row.label}: ${percent}`)}
          <Box marginLeft={1} width={PERCENT_CELLS} flexShrink={0} justifyContent="flex-end">
            <Text bold color={fill}>{percent}</Text>
          </Box>
        </Box>
        {isOpen ? chatList(row) : null}
      </Box>
    )
  }

  // 5 hour windows under the day each began, newest first; weeks need no heading
  const byDay = (rows: Row[]) =>
    rows.reduce<{ day: string; rows: Row[] }[]>((groups, r) => {
      const day = dayOf(r.resetsAt - WINDOWS.five_hour!.ms, view.now, t)
      const last = groups.at(-1)
      return last?.day === day ? [...groups.slice(0, -1), { day, rows: [...last.rows, r] }] : [...groups, { day, rows: [r] }]
    }, [])

  const section = ({ kind, running, past }: (typeof sections)[number]) => {
    const average = past.length === 0 ? 0 : past.reduce((sum, p) => sum + p.peak, 0) / past.length
    const hits = past.filter(p => p.peak >= 100).length
    const groups = kind === 'five_hour' ? byDay(past) : past.length > 0 ? [{ day: '', rows: past }] : []
    return (
      <Box key={kind} flexDirection="column">
        <Text bold>{windowName(kind, t).toLocaleUpperCase(t.locale)}</Text>
        {running ? windowRow(running) : null}
        {running ? (
          <Box marginLeft={2}>
            <Text color={c.muted} wrap="wrap">{fmt(t.resetsIn, { time: duration(running.resetsAt - view.now) })}</Text>
          </Box>
        ) : null}
        {groups.map(g => (
          <Box key={`${kind}-${g.day}`} flexDirection="column" marginTop={blank}>
            {g.day ? <Text bold>{g.day}</Text> : null}
            {g.rows.map(windowRow)}
          </Box>
        ))}
        <Box marginTop={blank}>
          <Text color={c.muted} wrap="wrap">
            {past.length === 0 ? t.noPast : fmt(t.average, { percent: Math.round(average), hits, count: past.length })}
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" rowGap={blank}>
      {sections.map(section)}
    </Box>
  )
}
