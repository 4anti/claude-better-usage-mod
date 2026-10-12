<div align="center">

# Usage Quota for Claude Code

**Know your Claude limits before they hit you.**

A live band above the Claude Code prompt: your 5 Hour and Weekly limits with a forecast to the next reset, what each chat costs, and how full your context window is. Compact in one click, or let it compact for you.

[![Version](https://img.shields.io/badge/version-0.2.0-9b9a96?style=flat-square&labelColor=212121)](https://github.com/4anti/claude-usage-quota-mod/releases)
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

Bars and their % follow what you've actually used. The **forecast tick** carries the warning on its own: light grey on track, **yellow** when you're heading past the limit, **red** when far past it.

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
| Turn the band off or on | `/quota` |
| Expand or collapse | the **▼ / ▲** button |
| Compact now | the **Compact** button |
| Auto compact | the switch, then type a % (it sets on Enter, a click elsewhere, or a 2-second pause) |
| Hide or show it in the terminal | Claude Code's own `[-]`, or **ctrl+x ctrl+a** |

In the desktop app, the band appears once a session has started. The *Welcome back* screen has no session yet, so no mod can draw there.

## Privacy

Everything runs on your machine with the same access Claude Code has. The mod **never sees your credentials** and sends nothing anywhere except the one request below.

| | What it does |
| --- | --- |
| **Network** | About every 2 minutes, one request to `https://api.anthropic.com/api/oauth/usage` through your existing Claude login. Claude Code attaches the credential; the mod never sees it. This is the only host it contacts. |
| **Your session** | Reads the context size and the limits each reply carries. It never reads or sends what you or Claude write. |
| **Commands** | Runs `/compact` when you press **Compact** or Auto compact reaches your %. Adds `/quota`. |
| **Programs** | Only to match a desktop app that follows the system theme: `reg query` for `AppsUseLightTheme` on Windows, `defaults read -g AppleInterfaceStyle` on macOS. |
| **Files** | Reads the desktop app's `config.json` for its theme setting, and nothing else. |

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
| `hooks/register.tsx` | Every hook and engine call: refreshing, the usage service, Auto compact, state |
| `hooks/band.tsx` | The band's layout, from plain values |
| `hooks/forecast.ts` | The pace forecast and the headline |
| `hooks/limits.ts` | Reading the usage service's answer and learning your usual pace |
| `hooks/colors.ts` | The palettes and the grey → yellow → red ramp |
| `tests/` | UI tests on both surfaces (`band.test.tsx`) and unit tests (`logic.test.ts`) |

The engine allows `$` and state atoms only in the hooks module, so everything else is plain, testable code. Issues and pull requests are welcome.

## Credits

A fork of [claude-code-usage-quota-mod](https://github.com/anantraghunath/claude-code-usage-quota-mod) by Anant Raghunath. That project was inspired by [I'm liking the new mods feature](https://www.reddit.com/r/ClaudeCode/comments/1wwjman/im_liking_the_new_mods_feature/) on r/ClaudeCode, with thanks to [u/itsxzy](https://www.reddit.com/user/itsxzy/) for the original prompt.

## License

[MIT](LICENSE)
