# Redmine Board Watcher

A small, self-healing background tool that watches a PaymentIQ Redmine Agile board and its project activity feed, and posts Slack alerts for the things that actually need a human to notice:

- 🆕 **New tickets** appearing on the board
- 📋 **Tickets moved** into specific watched columns (e.g. "Signed - Assign PM")
- 💬 **New comments from sales reps** on any ticket — including the case the board view misses: a comment added without the ticket's status changing

It runs continuously in the background via macOS LaunchAgents — no browser tab to babysit, no terminal to keep open. It's self-healing: Chrome getting stuck (the most common real-world failure, usually after the Mac sleeps overnight) is detected and recovered from automatically, with no manual restarts needed.

## Why this exists

Redmine's board view only tells you about tickets *currently* in front of you. It doesn't tell you when something new lands, when a ticket quietly moves into a column that needs action, or when someone comments on an old ticket without changing its status. This watches for exactly those three events and pushes them to Slack so nothing sits unnoticed.

## Requirements

- macOS
- [Node.js](https://nodejs.org/) (`brew install node` if you don't have it)
- Google Chrome
- Access to `support.paymentiq.io` (your PaymentIQ Redmine instance)
- A Slack bot token with permission to post in the channel(s) you want alerts in

## Setup

1. Clone this repo (or download it) to wherever you want it to live permanently — don't move the folder after setup, since the background services point at this exact path.
2. Create your config from the template and fill in your own Slack token:
   ```
   cp config.json.example config.json
   open config.json   # fill in slackBotToken and slackRecipients
   ```
3. Run setup:
   ```
   ./setup.sh
   ```
   This installs the one dependency (Playwright) and registers three background services that start now and on every future login.
4. **The one manual step:** setup opens a dedicated Chrome window — completely separate from your normal Chrome, it never touches your real browser profile or login. **Log into Redmine in that window once.** The session persists there after that; the watcher keeps it alive automatically.

That's it. It runs in the background from here on.

## Configuration

Everything you'd want to change lives in `config.json` — you shouldn't need to touch any of the `.mjs` scripts.

```json
{
  "slackBotToken": "xoxb-...",
  "slackRecipients": ["#your-slack-channel"],
  "salesReps": ["Name One", "Name Two", "..."]
}
```

- **`slackRecipients`** — channels and/or user IDs (e.g. `"U0AKAD8KX8V"` for a DM) to post alerts to. Add as many as you like.
- **`salesReps`** — matched case-insensitively against the comment author shown in Redmine's activity feed. Add/remove names as your team changes.

Restart the watchers after editing `config.json` for changes to take effect:
```
launchctl kickstart -k gui/$(id -u)/com.redmine-watcher.board
launchctl kickstart -k gui/$(id -u)/com.redmine-watcher.sales
```

To watch a **different** board/filter, open the board view you want in Redmine, copy its URL, and paste it into `redmine_board_url.txt` (replacing the existing one).

> **`config.json` is gitignored on purpose** — it holds a live Slack token. Only `config.json.example` (a harmless placeholder) is tracked in this repo. Never commit your real `config.json`.

## Checking on it

```
tail -f redmine-watcher.log            # board watcher
tail -f redmine-sales-watcher.log      # sales-comment watcher
tail -f watchdog.log                   # health checks / auto-recovery
```

## How the self-healing works

- Each watcher polls every 5 minutes. If 2 checks in a row fail (the usual cause: Chrome's network got stuck after the Mac slept), it reconnects automatically in-process — no process restart needed, so it can't get stuck in a crash loop.
- A separate watchdog runs every 15 minutes as a backup: if a watcher process isn't running at all, or hasn't produced output in 30+ minutes, it restarts it — and only if that doesn't actually fix things does it post a Slack alert so a human knows to look.
- Routine recoveries are silent (at most a macOS notification). You should only hear about this in Slack if something is genuinely and persistently wrong.

## Stopping it

```
launchctl bootout gui/$(id -u)/com.redmine-watcher.board
launchctl bootout gui/$(id -u)/com.redmine-watcher.sales
launchctl bootout gui/$(id -u)/com.redmine-watcher.watchdog
```

## Uninstalling completely

Run the stop commands above, then:
```
rm ~/Library/LaunchAgents/com.redmine-watcher.*.plist
rm -rf /path/to/this/folder
```
(and optionally delete the dedicated Chrome debug profile at `~/Library/Application Support/Google/ChromeDebug` if you don't want it kept around.)
