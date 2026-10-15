#!/bin/bash
# One-time setup for the Redmine board + sales-comment watchers.
#
# What this does:
#   1. Installs the npm dependency (Playwright).
#   2. Generates LaunchAgent plists pointing at wherever THIS folder actually
#      lives and whichever user is running this — nothing hardcoded.
#   3. Loads them into launchd so both watchers (and the watchdog that
#      auto-recovers them) start now and on every login.
#
# Run this once: ./setup.sh
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
NODE_PATH="$(command -v node || true)"

echo "Redmine watcher setup"
echo "  Package directory: $PACKAGE_DIR"

if [ -z "$NODE_PATH" ]; then
  echo "❌ node not found on PATH. Install Node.js first (e.g. 'brew install node'), then re-run this script."
  exit 1
fi
echo "  Node.js:            $NODE_PATH"

if [ ! -f "$PACKAGE_DIR/config.json" ]; then
  if [ -f "$PACKAGE_DIR/config.json.example" ]; then
    echo "❌ config.json not found — this is a first-time setup."
    echo "   Copy config.json.example to config.json and fill in your own Slack bot token"
    echo "   and channel(s) first, e.g.:"
    echo "     cp config.json.example config.json"
    echo "     open config.json   # edit slackBotToken and slackRecipients"
    echo "   Then re-run ./setup.sh."
  else
    echo "❌ Neither config.json nor config.json.example is present — something's missing from this folder."
  fi
  exit 1
fi

echo
echo "Installing dependencies (npm install)..."
(cd "$PACKAGE_DIR" && npm install --no-fund --no-audit)

mkdir -p "$LAUNCH_AGENTS_DIR"

write_plist() {
  local label="$1" script="$2" log_name="$3"
  local plist_path="$LAUNCH_AGENTS_DIR/${label}.plist"
  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PACKAGE_DIR}/${script}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PACKAGE_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${PACKAGE_DIR}/${log_name}</string>

    <key>StandardErrorPath</key>
    <string>${PACKAGE_DIR}/${log_name}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST
  echo "  Wrote $plist_path"
}

write_watchdog_plist() {
  local plist_path="$LAUNCH_AGENTS_DIR/com.redmine-watcher.watchdog.plist"
  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.redmine-watcher.watchdog</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${PACKAGE_DIR}/watchdog.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PACKAGE_DIR}</string>

    <key>StartInterval</key>
    <integer>900</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${PACKAGE_DIR}/watchdog.log</string>

    <key>StandardErrorPath</key>
    <string>${PACKAGE_DIR}/watchdog.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST
  echo "  Wrote $plist_path"
}

echo
echo "Writing LaunchAgents..."
write_plist   "com.redmine-watcher.board" "check_redmine.mjs"                   "redmine-watcher.log"
write_plist   "com.redmine-watcher.sales" "check_redmine_sales_comments.mjs"    "redmine-sales-watcher.log"
write_watchdog_plist

echo
echo "Loading LaunchAgents..."
for label in com.redmine-watcher.board com.redmine-watcher.sales com.redmine-watcher.watchdog; do
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS_DIR/${label}.plist"
  echo "  Started $label"
done

echo
echo "✅ Setup complete."
echo
echo "IMPORTANT — one manual step left:"
echo "  The watchers log into Redmine through a dedicated, isolated Chrome"
echo "  profile (separate from your normal Chrome — never shares your real"
echo "  login). It just launched a Chrome window on port 9222."
echo "  Log into Redmine manually ONCE in that window — the session persists"
echo "  there after that, and the watcher keeps it alive automatically."
echo
echo "Check status any time with:"
echo "  tail -f \"$PACKAGE_DIR/redmine-watcher.log\""
echo "  tail -f \"$PACKAGE_DIR/redmine-sales-watcher.log\""
