// The settings pane's tree, from plain values: one row per setting, each a picker
// (or a field for the colour %s). A pick goes through the hooks module to the config,
// which reloads the mod with the new value, so the pane redraws already changed.
import type { ElementTable, RenderSurface } from 'claude-code'

import { DARK, LIGHT } from './colors'
import { LANGUAGES } from './i18n'
import type { Strings } from './i18n'
import type { Settings } from './settings'

export type SettingsView = { settings: Settings; t: Strings; isLight: boolean }
/** a userConfig field and the value it takes, as the manifest types it */
export type SetSetting = (field: string, value: string | number | boolean) => void

const ALERT_AT = [50, 60, 70, 75, 80, 85, 90, 95, 100]
const AUTO_AT = [15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90]
// the name column: as wide as the longest setting's name reads in most languages
const NAME_CELLS = 30

export function settingsTree(table: ElementTable<'terminal' | 'desktop'>, surface: RenderSurface, view: SettingsView, set: SetSetting) {
  const { Box, Text, Select, Input } = table
  const { settings: s, t } = view
  const c = surface === 'desktop' && view.isLight ? LIGHT : DARK
  const onOff = [{ value: 'true', label: t.on }, { value: 'false', label: t.off }]
  // a value set by hand outside the list still shows, as one more choice
  const percents = (list: number[], value: number) =>
    [...new Set([...list, value])].sort((a, b) => a - b).map(n => ({ value: String(n), label: `${n}%` }))

  const row = (name: string, control: unknown) => (
    <Box flexDirection="row" alignItems="center">
      <Box width={NAME_CELLS} flexShrink={0}>
        <Text>{name}</Text>
      </Box>
      {control}
    </Box>
  )
  const toggle = (field: 'notify' | 'chatCost' | 'statusLine') => (
    <Select key={field} options={onOff} value={String(s[field])} onSelect={value => set(field, value === 'true')} />
  )
  const colors = (field: 'limitColors' | 'contextColors', value: readonly number[]) => (
    <Box width={14}>
      <Input key={field} value={value.join(' ')} onSubmit={text => set(field, text.trim())} />
    </Box>
  )

  return (
    <Box flexDirection="column" rowGap={surface === 'desktop' ? 0.5 : 0}>
      {row(t.language, (
        <Select
          key="language"
          options={[{ value: 'auto', label: t.sameAsApp }, ...Object.entries(LANGUAGES).map(([code, l]) => ({ value: code, label: l.name }))]}
          value={s.language}
          onSelect={value => set('language', value)}
        />
      ))}
      {row(t.setAlerts, toggle('notify'))}
      {row(t.setAlertAt, <Select key="alertAt" options={percents(ALERT_AT, s.alertAt)} value={String(s.alertAt)} onSelect={value => set('alertAt', Number(value))} />)}
      {row(t.setChatCost, toggle('chatCost'))}
      {row(t.setStatusLine, toggle('statusLine'))}
      {row(t.setAutoCompact, <Select key="autoCompactAt" options={percents(AUTO_AT, s.autoCompactAt)} value={String(s.autoCompactAt)} onSelect={value => set('autoCompactAt', Number(value))} />)}
      {row(t.setLimitColors, colors('limitColors', s.limitRamp))}
      {row(t.setContextColors, colors('contextColors', s.contextRamp))}
      <Text color={c.muted} wrap="wrap">{t.colorsHint}</Text>
    </Box>
  )
}
