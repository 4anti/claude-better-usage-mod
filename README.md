<div align="center">

# Usage Quota for Claude Code

**Know your Claude limits before they hit you.**

A live band above the Claude Code prompt: your 5 Hour and Weekly limits with a forecast to the next reset, alerts before you run out, what each chat costs, and how full your context window is. Compact in one click, or let it compact for you.

[![Tests](https://img.shields.io/github/actions/workflow/status/4anti/claude-usage-quota-mod/test.yml?branch=main&style=flat-square&labelColor=212121&label=tests)](https://github.com/4anti/claude-usage-quota-mod/actions/workflows/test.yml)
[![Version](https://img.shields.io/badge/version-0.4.0-9b9a96?style=flat-square&labelColor=212121)](https://github.com/4anti/claude-usage-quota-mod/releases)
[![Claude Code](https://img.shields.io/badge/Claude_Code-2.1.287%2B-9b9a96?style=flat-square&labelColor=212121)](https://claude.com/claude-code)
[![Works in](https://img.shields.io/badge/works_in-Desktop_%2B_Terminal-9b9a96?style=flat-square&labelColor=212121)](#install)
[![License: MIT](https://img.shields.io/badge/license-MIT-9b9a96?style=flat-square&labelColor=212121)](LICENSE)

<img src="docs/band-expanded.png" alt="The usage band above the prompt in the Claude desktop app, expanded: 5 Hour at 7%, Weekly at 57% with a red forecast tick, context at 38%" width="900">

</div>

## Overview

The band reads Anthropic's usage service the moment a session opens, so your limits are there before the first reply. It stays current while you work: every 3 seconds for the context, and every 2 minutes for your plan. It costs no tokens and doesn't count toward your limits.

The 5 Hour and Weekly limits are **your whole Claude account's**, including Claude chat and Cowork. The band itself shows in **Claude Code**, in the desktop app and the terminal.

## Features

### Plan limits with a forecast

- **% used** of the 5 Hour and Weekly limits, matching the app's own *Plan usage limits* panel.
- **A forecast to the reset**: *On pace for about 55% by reset*, or *Limit will hit in 3d 3h*. The tick on each bar marks where you'll be when the window resets.
- **A headline** for the window that needs attention: *On track*, *At this pace you'll run out before Sunday's reset*, or *Limit reached*.
- **A learned pace.** The forecast starts from how far your past windows usually got. For the first 15% of a window it uses only that, so an early burst doesn't raise a false alarm. Then it shifts smoothly to your actual pace.

### Color that means something

Everything is Claude's own grey until usage matters. It then shifts smoothly, never in sudden steps:

| | Grey | Yellow | Red |
| --- | --- | --- | --- |
| **5 Hour and Weekly** | up to 50% | 75% | 95% and over |
| **Context** | up to 25% | 50% | 80% and over |

Bars and their % follow what you've actually used. The **forecast tick** carries the warning on its own: light grey on track, **yellow** when you're heading past the limit, **red** when far past it. All of these %s can be changed in [Settings](#settings).

### Alerts

- A notification when a limit reaches **90%** (or your own %), and again when it's **reached**.
- When a 5 Hour window you were warned about **resets**: *5 Hour limit reset: your full allowance is back.*
- Each alert is sent once per window, however many chats are open.
- In a terminal it's a system notification. The desktop app doesn't pass notifications from mods to the system, so there it's a message in the app.

### Usage history

`/quota-history` opens a pane with how far each recent window got: the running one first, then the last 10 five-hour windows and 8 weeks, with your average and how often you hit the limit. Windows are recorded as they end, so the list fills up as you use Claude.

### What this chat costs

Under the 5 Hour bar: *This chat used 3% – last reply 0.5%*. It's measured from the start to the end of each reply, and starts over when the 5 Hour window resets.

### Context window

- The % used and the space free, as `/context` counts it.
- A breakdown into **Messages**, **Tools** and **Other**, calibrated against the exact count every 2 minutes.

### Compact and Auto compact

- **Compact** runs `/compact` in one click.
- **Auto compact** compacts at your % (30% by default, 15 to 99), only between replies, never during one.
- Each chat keeps its own setting. A new chat starts with the last setting you chose.
- If a chat is already past your % when Auto compact turns on, it asks first: **Now** or **After my next compact**.

### Collapsed

One row, with the time left until each limit resets. Collapsed or expanded is shared by every chat.

<img src="docs/band-collapsed.png" alt="The band collapsed to one row: 5H 4h 51m at 7%, W 5d 11h at 57%, Context 1M at 38%" width="900">

## Install

Needs **Claude Code 2.1.287 or later**, signed in with a **Pro or Max** plan. One install covers both the desktop app and the terminal.

**Desktop app:** in the **Code** tab, send this as a message, allow the `claude plugin` commands if asked, then quit and reopen the app:

```text
Install the usage-quota plugin from the GitHub marketplace 4anti/claude-usage-quota-mod
```

**Terminal:** inside `claude`, run these one at a time:

```text
/plugin marketplace add 4anti/claude-usage-quota-mod
```

```text
/plugin install usage-quota@4anti-mods
```

```text
/reload-plugins
```

> [!IMPORTANT]
> **Have the original version installed?** Remove it first, or two bands will draw:
>
> ```bash
> claude plugin marketplace remove claude-code-usage-quota-mod
> ```
>
> Saved settings are kept per marketplace, so Auto compact settings and the learned pace start fresh here.

<details>
<summary>Update, uninstall, or install from your own shell</summary>

Install:

```bash
claude plugin marketplace add 4anti/claude-usage-quota-mod
claude plugin install usage-quota@4anti-mods
```

Update, then restart Claude Code:

```bash
claude plugin marketplace update 4anti-mods
claude plugin update usage-quota@4anti-mods
```

Uninstall, then restart Claude Code:

```bash
claude plugin marketplace remove 4anti-mods
```

</details>

## Usage

| Action | How |
| --- | --- |
| Turn the band off or on | `/quota` (while it's off, the status line shows *5H 7% · Weekly 57% · Context 38%*) |
| See past windows | `/quota-history` |
| Change settings, language included | `/quota-settings` |
| Expand or collapse | the **▼ / ▲** button |
| Compact now | the **Compact** button |
| Auto compact | the switch, then type a % (it sets on Enter, a click elsewhere, or a 2-second pause) |
| Hide or show it in the terminal | Claude Code's own `[-]`, or **ctrl+x ctrl+a** |

In the desktop app, the band appears once a session has started. The *Welcome back* screen has no session yet, so no mod can draw there.

## Settings

`/quota-settings` opens a pane with every setting as a picker, in the desktop app and the terminal alike. A change applies at once. In a terminal, `/config` lists the same settings under the plugin's own rows. Values out of range fall back to the default.

| Setting | Default | What it does |
| --- | --- | --- |
| Language | Same as the app | The band's language (see [Languages](#languages)) |
| Alerts | on | Notify at the alert %, at the limit, and when a warned 5 Hour window resets |
| Alert at % | 90 | The % of a limit that raises the first alert (50 to 100) |
| Show what this chat used | on | The *This chat used* line under the 5 Hour bar |
| Usage in the status line | on | The one-line summary while the band is off |
| Auto compact default % | 30 | Where Auto compact starts when you turn it on (15 to 99) |
| Limit colours | `50 75 95` | Grey up to the first %, yellow at the second, red at the third |
| Context colours | `25 50 80` | The same, for the context |

## Languages

The band, its alerts, the history and settings panes, and its messages speak 16 languages, with times and days in each language's own form (*16:40*, *Pazar*, *日曜日*):

English · Türkçe · Deutsch · Français · Español · Português · Italiano · Nederlands · Polski · Русский · Українська · 日本語 · 한국어 · 简体中文 · 繁體中文 · Bahasa Indonesia

By default the band follows the desktop app's language, then your system's (`LC_ALL`, `LANG`), then English. Pick one in `/quota-settings` to override it. Right-to-left scripts are left out for now, because terminals draw them unreliably.

Adding a language is one file in `hooks/i18n/`. Copy `en.ts`, translate each line and keep every `{placeholder}`. The type checker lists any key you missed, and a test checks the placeholders. Corrections from native speakers are welcome.

## Privacy

Everything runs on your machine with the same access Claude Code has. The mod **never sees your credentials** and sends nothing anywhere except the one request below.

| | What it does |
| --- | --- |
| **Network** | About every 2 minutes, one request to `https://api.anthropic.com/api/oauth/usage` through your existing Claude login. Claude Code attaches the credential; the mod never sees it. This is the only host it contacts. |
| **Your session** | Reads the context size and the limits each reply carries. It never reads or sends what you or Claude write. |
| **Commands** | Runs `/compact` when you press **Compact** or Auto compact reaches your %. Adds `/quota`, `/quota-history` and `/quota-settings`. |
| **Notifications** | Your limits' alerts, through Claude Code's own notification channel (the one your `preferredNotifChannel` setting picks). |
| **Stored on your machine** | In Claude Code's plugin store: the last readings, your learned pace, which alerts were sent, and the history of past windows (peaks and reset times only). |
| **Programs** | Only to match a desktop app that follows the system theme: `reg query` for `AppsUseLightTheme` on Windows, `defaults read -g AppleInterfaceStyle` on macOS. |
| **Files** | Reads the desktop app's `config.json` for its theme and language settings, and nothing else. |
| **Settings** | `/quota-settings` changes the plugin's own settings, the ones `/config` lists, and no others. |

## Development

Clone the repo, then run its tests, or load it into a session from the folder:

```bash
claude plugin test ./claude-usage-quota-mod
```

```bash
claude --plugin-dir ./claude-usage-quota-mod
```

| File | Role |
| --- | --- |
| `hooks/register.tsx` | Every hook and engine call: refreshing, the usage service, alerts, Auto compact, state |
| `hooks/band.tsx` | The band's layout, from plain values |
| `hooks/history.tsx` | The history pane's layout |
| `hooks/forecast.ts` | The pace forecast and the headline |
| `hooks/limits.ts` | Reading the usage service's answer, learning your usual pace, the history list |
| `hooks/alerts.ts` | When to alert, once per window |
| `hooks/settings.ts` | Reading and checking the settings |
| `hooks/settings-pane.tsx` | The settings pane's layout |
| `hooks/i18n/` | The 16 languages, one file each, and how the band picks one |
| `hooks/colors.ts` | The palettes and the grey → yellow → red ramp |
| `tests/` | UI tests on both surfaces (`band.test.tsx`, `features.test.tsx`) and unit tests (`logic.test.ts`) |

The engine allows `$` and state atoms only in the hooks module, so everything else is plain, testable code. Every push runs the tests on GitHub Actions. Issues and pull requests are welcome.

## Credits

A fork of [claude-code-usage-quota-mod](https://github.com/anantraghunath/claude-code-usage-quota-mod) by Anant Raghunath. That project was inspired by [I'm liking the new mods feature](https://www.reddit.com/r/ClaudeCode/comments/1wwjman/im_liking_the_new_mods_feature/) on r/ClaudeCode, with thanks to [u/itsxzy](https://www.reddit.com/user/itsxzy/) for the original prompt.

## License

[MIT](LICENSE)
