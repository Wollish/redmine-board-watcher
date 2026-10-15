#!/bin/bash
# Health check for the PIQ Redmine watchers — alerts once per incident per
# watcher, resets when healthy again. Covers:
#   - com.piq.redmine-watcher        (check_redmine.mjs)
#   - com.piq.redmine-sales-watcher  (check_redmine_sales_comments.mjs)
#
# Also auto-recovers the common "Chrome network stuck after the Mac sleeps"
# failure mode: the process stays alive and the log keeps updating (so the
# checks below don't catch it), but every single poll cycle fails to load
# the page. If a watcher has failed N cycles in a row, this script
# restarts it automatically via launchctl kickstart — no more asking
# Claude to do it every morning. If a restart doesn't actually fix it
# (genuine Redmine outage, not just a stuck Chrome connection), it escalates
# to the normal Slack/notification alert instead of silently retrying
# forever.
set -uo pipefail

# Portable: resolves to wherever this script actually lives, not a hardcoded
# path, so the same package works unmodified on anyone's machine.
AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Slack token/channel come from config.json (same file the two watcher
# scripts read) — edit that file, not this one, to change where alerts go.
SLACK_BOT_TOKEN=$(python3 -c "import json; print(json.load(open('$AGENT_DIR/config.json'))['slackBotToken'])")
SLACK_RECIPIENTS=$(python3 -c "import json; print(' '.join(json.load(open('$AGENT_DIR/config.json'))['slackRecipients']))")

STALE_THRESHOLD_SECS=$((30 * 60))
STUCK_FAIL_THRESHOLD=2   # consecutive failed cycles before treating it as stuck

fire_alert() {
  local name="$1" log_file="$2" state_file="$3" reason="$4"
  local prev_state="ok"
  [ -f "$state_file" ] && prev_state=$(cat "$state_file")

  if [ "$prev_state" != "alerted" ]; then
    local msg="${name} looks unhealthy: ${reason}. Check ${log_file}"
    osascript -e "display notification \"$msg\" with title \"${name} Down\"" >/dev/null 2>&1
    for recipient in $SLACK_RECIPIENTS; do
      curl -s -X POST https://slack.com/api/chat.postMessage \
        -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"channel\":\"$recipient\",\"text\":\"⚠️ ${msg}\"}" >/dev/null 2>&1
    done
    echo "alerted" > "$state_file"
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$name] ALERTED: $reason"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$name] still unhealthy (already alerted): $reason"
  fi
}

clear_alert_if_needed() {
  local name="$1" state_file="$2"
  local prev_state="ok"
  [ -f "$state_file" ] && prev_state=$(cat "$state_file")
  if [ "$prev_state" = "alerted" ]; then
    local msg="${name} connected. Log has been updated."
    osascript -e "display notification \"$msg\" with title \"${name} OK\"" >/dev/null 2>&1
  fi
  echo "ok" > "$state_file"
}

# check_one <display name> <process grep pattern> <log file> <state file> \
#           <launchd label> <fail regex> <success regex> <stuck state file>
check_one() {
  local name="$1" proc_pattern="$2" log_file="$3" state_file="$4"
  local launchd_label="$5" fail_re="$6" success_re="$7" stuck_state_file="$8"

  local now log_mtime age proc_running
  now=$(date +%s)
  log_mtime=$(stat -f %m "$log_file" 2>/dev/null || echo 0)
  age=$(( now - log_mtime ))

  proc_running=false
  if pgrep -f "$proc_pattern" >/dev/null 2>&1; then
    proc_running=true
  fi

  if [ "$proc_running" = false ]; then
    fire_alert "$name" "$log_file" "$state_file" "watcher process is not running"
    return
  fi
  if [ "$age" -gt "$STALE_THRESHOLD_SECS" ]; then
    fire_alert "$name" "$log_file" "$state_file" "log hasn't updated in $(( age / 60 )) minutes"
    return
  fi

  # Process alive, log fresh — but is it actually succeeding, or stuck
  # failing every cycle (the post-sleep Chrome-network-hung pattern)?
  local stuck
  stuck=$(python3 "$AGENT_DIR/check_stuck.py" "$log_file" "$fail_re" "$success_re" "$STUCK_FAIL_THRESHOLD" 2>/dev/null || echo "OK")

  if [ "$stuck" = "STUCK" ]; then
    local prev_stuck="ok"
    [ -f "$stuck_state_file" ] && prev_stuck=$(cat "$stuck_state_file")

    if [ "$prev_stuck" != "auto-restarted" ]; then
      launchctl kickstart -k "gui/$(id -u)/$launchd_label" >/dev/null 2>&1
      echo "auto-restarted" > "$stuck_state_file"
      osascript -e "display notification \"${name} was stuck failing every cycle — restarted automatically.\" with title \"${name} auto-restarted\"" >/dev/null 2>&1
      echo "$(date '+%Y-%m-%d %H:%M:%S') [$name] STUCK ($STUCK_FAIL_THRESHOLD consecutive failures) — auto-restarted via launchctl kickstart"
    else
      # Already tried an auto-restart last check and it's STILL stuck —
      # this isn't the sleep/Chrome issue self-healing via restart, it's
      # a real problem. Escalate instead of restarting forever.
      fire_alert "$name" "$log_file" "$state_file" "still stuck failing every cycle after an automatic restart — needs a look"
    fi
    return
  fi

  # Healthy: clear both the stuck-tracking and the escalation-alert state.
  echo "ok" > "$stuck_state_file"
  clear_alert_if_needed "$name" "$state_file"
  echo "$(date '+%Y-%m-%d %H:%M:%S') [$name] healthy"
}

check_one "Redmine board watcher" "check_redmine.mjs" \
  "$AGENT_DIR/redmine-watcher.log" "$AGENT_DIR/.watchdog_state" \
  "com.redmine-watcher.board" \
  "Board load failed|Board returned 0 cards" \
  "Total: [0-9]+ cards" \
  "$AGENT_DIR/.watchdog_stuck_state_board"

check_one "Redmine sales-comment watcher" "check_redmine_sales_comments.mjs" \
  "$AGENT_DIR/redmine-sales-watcher.log" "$AGENT_DIR/.watchdog_state_sales" \
  "com.redmine-watcher.sales" \
  "Activity page load failed|Activity feed returned 0 entries" \
  "new activity entr|First run —" \
  "$AGENT_DIR/.watchdog_stuck_state_sales"
