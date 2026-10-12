// Two palettes, the desktop's dark and light themes, in Claude's own neutral greys.
// Usage is grey until it matters, then turns smoothly to yellow and on to red.
export type Palette = {
  /** the base grey: muted text, a bar at low usage, the forecast tick on track */
  muted: string; yellow: string; red: string; free: string; buffer: string; track: string
  /** the forecast tick on track: apart from the grey fill it may sit right beside */
  tick: string
  palette: string[]; named: Record<string, string>; switchOff: string; switchOn: string; switchLit: string; compactLit: string
}

export const DARK: Palette = {
  muted: '#9b9a96', yellow: '#e5b54a', red: '#e5534b',
  free: '#333332', buffer: '#4d4d4a', track: '#333332', tick: '#dcdbd6',
  palette: ['#a78bfa', '#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#fb923c', '#22d3ee', '#c084fc'],
  named: {
    Tools: '#a78bfa', Other: '#9b9a96', 'System prompt': '#a78bfa', 'System tools': '#60a5fa', 'MCP tools': '#f472b6',
    'Custom agents': '#34d399', 'Memory files': '#fbbf24', Skills: '#fb923c', Messages: '#22d3ee',
  },
  switchOff: '#4d4d4a', switchOn: '#4ade80', switchLit: '#8a8a86', compactLit: '#555553',
}

// light: the same hues, deep enough to read as text on the pale band; the tracks pale
export const LIGHT: Palette = {
  muted: '#73726c', yellow: '#c98a04', red: '#dc3c34',
  free: '#ffffff', buffer: '#c4c3be', track: '#ffffff', tick: '#3d3c38',
  palette: ['#8b5cf6', '#3b82f6', '#ec4899', '#10b981', '#f59e0b', '#f97316', '#0ea5e9', '#a855f7'],
  named: {
    Tools: '#8b5cf6', Other: '#73726c', 'System prompt': '#8b5cf6', 'System tools': '#3b82f6', 'MCP tools': '#ec4899',
    'Custom agents': '#10b981', 'Memory files': '#f59e0b', Skills: '#f97316', Messages: '#0ea5e9',
  },
  switchOff: '#c4c3be', switchOn: '#22c55e', switchLit: '#d0cfca', compactLit: '#dddcd7',
}

/** grey up to the first %, fully yellow at the second, fully red at the third */
export type Ramp = readonly [number, number, number]
export const LIMIT_RAMP: Ramp = [50, 75, 95]
export const CONTEXT_RAMP: Ramp = [25, 50, 80]

const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

export function mix(a: string, b: string, t: number): string {
  const [x, y] = [channels(a), channels(b)]
  return '#' + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')
}

// by the % as the band shows it (rounded), so a "75%" is always the same colour
export function rampColor(percent: number, [from, mid, to]: Ramp, c: Palette): string {
  const p = Math.round(percent)
  // written as "not above" so an unreadable % (NaN) stays grey
  if (!(p > from)) return c.muted
  if (p <= mid) return mix(c.muted, c.yellow, (p - from) / (mid - from))
  return mix(c.yellow, c.red, Math.min(1, (p - mid) / (to - mid)))
}
