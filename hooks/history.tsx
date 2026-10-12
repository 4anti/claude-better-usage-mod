// The history pane's tree, from plain values: how far each window got, newest first,
// the running one on top. The hooks module reads the store and hands it here.
import type { ElementTable, RenderSurface } from 'claude-code'

import type { Limit } from '../types'
import { BAR_PX, barSvg } from './band'
import { DARK, LIGHT, rampColor } from './colors'
import type { Ramp } from './colors'
import { duration, endedAt, windowName, WINDOWS } from './forecast'
import { fmt } from './i18n'
import type { Strings } from './i18n'
import type { Past } from './limits'

export type HistoryView = { past: Past[]; limits: Limit[]; now: number; isLight: boolean; ramp: Ramp; t: Strings }

// the row's name column: "Sun 10:40 PM" at most
const NAME_CELLS = 13

export function historyTree(table: ElementTable<RenderSurface>, surface: RenderSurface, width: number, view: HistoryView) {
  const { Box, Text } = table
  const { t } = view
  const Svg = surface === 'desktop' && 'Svg' in table ? table.Svg : undefined
  const c = surface === 'desktop' && view.isLight ? LIGHT : DARK
  const cells = Math.max(10, width - NAME_CELLS - 6)

  const row = (name: string, percent: number, key: string) => {
    const color = rampColor(percent, view.ramp, c)
    const filled = Math.max(0, Math.min(cells, Math.round((Math.min(100, percent) / 100) * cells)))
    return (
      <Box key={key} flexDirection="row">
        <Box width={NAME_CELLS} flexShrink={0}>
          <Text color={c.muted}>{name}</Text>
        </Box>
        {Svg ? (
          <Box width={cells} height={1} alignItems="center">
            <Svg alt={`${name}: ${Math.round(percent)}%`} source={barSvg([{ color, share: Math.min(100, percent) }, { color: c.track, share: Math.max(0, 100 - percent) }], cells * 8)} height={BAR_PX} />
          </Box>
        ) : (
          <Box flexDirection="row" width={cells}>
            {filled > 0 ? <Box width={filled} backgroundColor={color}><Text> </Text></Box> : null}
            {filled < cells ? <Box width={cells - filled} backgroundColor={c.track}><Text> </Text></Box> : null}
          </Box>
        )}
        <Box marginLeft={1} width={5} flexShrink={0} justifyContent="flex-end">
          <Text bold color={color}>{`${Math.round(percent)}%`}</Text>
        </Box>
      </Box>
    )
  }

  const section = (kind: string, label: string) => {
    const past = view.past.filter(p => p.kind === kind)
    const live = view.limits.find(l => l.kind === kind)
    const resetsAt = live?.resetsAt ? Date.parse(live.resetsAt) : NaN
    const isRunning = live !== undefined && Number.isFinite(resetsAt) && resetsAt > view.now
    const average = past.length === 0 ? 0 : past.reduce((sum, p) => sum + p.peak, 0) / past.length
    const hits = past.filter(p => p.peak >= 100).length
    return (
      <Box key={kind} flexDirection="column">
        <Text bold>{label}</Text>
        {isRunning ? row(t.now, live.percentUsed, `${kind}-now`) : null}
        {isRunning ? <Text color={c.muted} wrap="wrap">{fmt(t.resetsIn, { time: duration(resetsAt - view.now) })}</Text> : null}
        {past.map(p => row(endedAt(p.resetsAt, kind, t), p.peak, `${kind}-${p.resetsAt}`))}
        <Text color={c.muted} wrap="wrap">
          {past.length === 0
            ? t.noPast
            : fmt(t.average, { percent: Math.round(average), hits, count: past.length })}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" rowGap={1}>
      {Object.keys(WINDOWS).map(kind => section(kind, windowName(kind, t)))}
    </Box>
  )
}
