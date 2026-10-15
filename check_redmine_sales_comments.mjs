/**
 * check_redmine_sales_comments.mjs — Redmine Sales-Comment Watcher (macOS)
 * --------------------------------------------------------------------------
 * Watches the PaymentIQ Redmine project Activity feed
 * (https://support.paymentiq.io/projects/paymentiq/activity) for new
 * comments left by sales reps on ANY ticket — regardless of whether the
 * ticket's status/column changes. This catches the case the board watcher
 * (check_redmine.mjs) misses: a sales rep replying on a ticket that stays
 * in the same column.
 *
 * Sends a Slack message for every new matching comment.
 * Runs in a loop every 15 minutes, same cadence as check_redmine.mjs.
 *
 * Usage:
 *   node check_redmine_sales_comments.mjs             — run once then loop
 *   node check_redmine_sales_comments.mjs --once      — run once and exit
 *
 * Reuses the same Chrome debug session (port 9222) as check_redmine.mjs —
 * log into Redmine once in that debug window and both watchers share it.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SNAPSHOT_FILE = path.join(__dirname, 'redmine_activity_snapshot.json');
const LOG_FILE       = path.join(__dirname, 'redmine_sales_comments_log.json');
const CONFIG_FILE    = path.join(__dirname, 'config.json');

const ACTIVITY_URL = 'https://support.paymentiq.io/projects/paymentiq/activity';

// All per-deployment settings (Slack token/channel, sales rep list) live in
// config.json — edit that file, not this one, to point this at a different
// Slack destination or sales team.
const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));

const SLACK_BOT_TOKEN  = config.slackBotToken;
const SLACK_RECIPIENTS = config.slackRecipients;

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — keeps the Redmine session alive (session idle-timeout is shorter than 15 min)
const RUN_ONCE = process.argv.includes('--once');

// ─── Self-restart on repeated failure ─────────────────────────────────────────
// See the comment at registerResult() in main() for why this exists instead
// of relying on the external watchdog.sh timer.
const MAX_CONSECUTIVE_FAILURES = 2;

// ─── Sales reps to watch for ──────────────────────────────────────────────────
// Matched case-insensitively against the comment's displayed author name.
// Edit config.json's "salesReps" list, not this file, to change who's watched.
const SALES_REPS = config.salesReps;
const SALES_REPS_LOWER = new Set(SALES_REPS.map(n => n.toLowerCase()));

// ─── macOS notification ───────────────────────────────────────────────────────

function notify(title, message) {
  try {
    const safe = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execSync(
      `osascript -e 'display notification "${safe(message)}" with title "${safe(title)}"'`,
      { stdio: 'ignore' }
    );
  } catch {
    // Notification failed silently — log still works
  }
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function sendSlackMessage(record) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `💬 *Sales comment — ${record.author}*\n*<${record.url}|${record.title}>*`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: record.snippet ? `>${record.snippet}` : '_(no text preview)_' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Comment' },
          url: record.url,
          style: 'primary',
        },
      ],
    },
  ];

  for (const recipient of SLACK_RECIPIENTS) {
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: recipient,
          text: `💬 Sales comment by ${record.author} — *<${record.url}|${record.title}>*`,
          blocks,
        }),
      });
      const result = await res.json();
      if (!result.ok) {
        console.error(`  [Slack] Failed to send to ${recipient}: ${result.error}`);
      } else {
        console.log(`  [Slack] Message sent to ${recipient} for ${record.href}`);
      }
    } catch (e) {
      console.error(`  [Slack] Network error sending to ${recipient}: ${e.message}`);
    }
  }
}

// ─── Chrome connect ───────────────────────────────────────────────────────────
// Same debug profile/port as check_redmine.mjs, so both watchers share one
// logged-in Redmine session instead of each spawning their own Chrome.

// Playwright doesn't finish attaching to a Chrome instance's EXISTING tabs
// the instant connectOverCDP() resolves — context.pages() can briefly report
// an incomplete list right after connecting. Calling it too early is exactly
// what caused "Reusing existing activity tab" to flip to "Activity tab opened"
// (a genuine duplicate) across otherwise-identical restarts: the dedup check
// ran before Playwright had attached to the tab that was already there. A
// short settle delay after every connect gives it time to catch up.
async function connectAndSettle(url) {
  const browser = await chromium.connectOverCDP(url);
  await new Promise(r => setTimeout(r, 1500));
  return browser;
}

async function connectChrome() {
  try {
    const browser = await connectAndSettle('http://localhost:9222');
    console.log('  Connected to existing Chrome session.');
    return browser;
  } catch {
    // Not accepting CDP connections right now — don't assume it's not
    // running at all. Fall through to check before ever spawning anything.
  }

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const debugProfileDir = `${process.env.HOME}/Library/Application Support/Google/ChromeDebug`;

  // IMPORTANT: Chrome treats a user-data-dir as single-instance. Spawning a
  // new process against a profile that's ALREADY running does NOT start a
  // second process — the OS silently forwards it to the existing instance,
  // which just opens another window (a fresh "New Tab" + its widgets). Doing
  // that on every failed/slow connection attempt is exactly what piled up
  // 70+ stray windows overnight. So: always check whether a Chrome process
  // for this exact profile is still alive before ever spawning — if it is,
  // wait longer for its CDP port instead of opening another window on top
  // of it, and only kill+relaunch if it's truly wedged, never spawn-on-top.
  const procPattern = `Google Chrome.*--user-data-dir=${debugProfileDir}`;
  const isAlreadyRunning = () => {
    try {
      execSync(`pgrep -f "${procPattern}"`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };

  if (isAlreadyRunning()) {
    console.log('  Chrome debug profile is already running but not responding yet — waiting longer instead of opening another window...');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const browser = await connectAndSettle('http://localhost:9222');
        console.log('  Connected to existing Chrome session (after waiting).');
        return browser;
      } catch { /* keep trying */ }
    }
    console.log('  Existing Chrome debug instance looks wedged — killing it before relaunching (never spawning on top of it).');
    try {
      execSync(`pkill -f "${procPattern}"`, { stdio: 'ignore' });
    } catch { /* already gone */ }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('  Launching a fresh debug Chrome instance...');

  execSync(`mkdir -p "${debugProfileDir}"`, { stdio: 'ignore' });

  try {
    execSync(`rm -f "${debugProfileDir}/Default/lockfile" "${debugProfileDir}/lockfile"`, { stdio: 'ignore' });
  } catch { /* ignore */ }

  spawn(chromePath, [
    '--remote-debugging-port=9222',
    '--profile-directory=Default',
    `--user-data-dir=${debugProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,800',
  ], { detached: true, stdio: 'ignore' }).unref();

  console.log('  Waiting for Chrome to start...');
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const browser = await connectAndSettle('http://localhost:9222');
      console.log('  Chrome launched and connected.');
      return browser;
    } catch { /* keep trying */ }
  }

  throw new Error(
    'Could not connect to Chrome after launching.\n' +
    '  Make sure /Applications/Google Chrome.app exists.\n' +
    '  You can also start Chrome manually with:\n' +
    `  open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="${debugProfileDir}"`
  );
}

// ─── Single activity-feed check ────────────────────────────────────────────────

async function checkActivity(context, pageRef) {
  let page = pageRef.page;
  const startTime = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', hour12: false }).replace(',', '');
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  Redmine Sales-Comment Check — ${startTime} CET`);
  console.log(`${'═'.repeat(55)}`);

  console.log('  Loading activity feed...');
  try {
    await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('#activity', { timeout: 20000 }).catch(() => {});
  } catch (e) {
    console.log(`  ⚠️  Activity page load failed (${e.message.split('\n')[0]}) — skipping cycle, will retry next check.`);
    await page.goto('about:blank').catch(() => {});
    return false;
  }

  // ── Scrape every dt/dd entry in the feed ───────────────────────────────────
  const entries = await page.evaluate(() => {
    const root = document.querySelector('#activity');
    if (!root) return [];
    const out = [];
    let dateLabel = null;
    for (const el of root.children) {
      if (el.tagName === 'H3') { dateLabel = el.textContent.trim(); continue; }
      if (el.tagName !== 'DL') continue;
      const kids = [...el.children];
      for (let i = 0; i < kids.length; i++) {
        const dt = kids[i];
        if (dt.tagName !== 'DT') continue;
        const dd = kids[i + 1] && kids[i + 1].tagName === 'DD' ? kids[i + 1] : null;
        const link = dt.querySelector('a');
        const timeMatch = dt.textContent.trim().match(/^(\d{2}:\d{2})/);
        const author = dd ? (dd.querySelector('.author')?.textContent.trim() || null) : null;
        const desc = dd ? (dd.querySelector('.description')?.textContent.trim() || '') : '';
        const href = link ? link.getAttribute('href') : null;
        if (!href) continue;
        out.push({
          key: href,
          date: dateLabel,
          time: timeMatch ? timeMatch[1] : null,
          type: dt.className.trim().split(/\s+/)[0] || 'unknown',
          title: link.textContent.trim(),
          author,
          desc,
        });
      }
    }
    return out;
  });

  const currentEntries = {};
  entries.forEach(e => { currentEntries[e.key] = e; });

  // ── Guard: 0 entries = likely load failure ─────────────────────────────────
  if (entries.length === 0) {
    console.log('\n  ⚠️  Activity feed returned 0 entries — possible load failure or Redmine down.');
    console.log('  Snapshot NOT updated. Will compare against last good snapshot on next run.\n');
    return false;
  }

  // ── Load previous snapshot ──────────────────────────────────────────────────
  let previousEntries = {};
  if (existsSync(SNAPSHOT_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
      previousEntries = saved.lastGoodSnapshot || {};
    } catch { previousEntries = {}; }
  }

  // ── Diff: entries not seen before ───────────────────────────────────────────
  const newEntries = entries.filter(e => !previousEntries[e.key]);

  // Save snapshot (everything currently visible on the feed — bounds growth
  // naturally to Redmine's own rolling ~30-day activity window)
  writeFileSync(SNAPSHOT_FILE, JSON.stringify({
    lastGoodSnapshot: currentEntries,
    lastUpdated:      new Date().toISOString(),
    entryCount:        entries.length,
  }, null, 2));

  if (Object.keys(previousEntries).length === 0) {
    console.log('  First run — snapshot saved. Will detect new comments from next check.');
    return true;
  }

  console.log(`  ${newEntries.length} new activity entr${newEntries.length === 1 ? 'y' : 'ies'} since last check.`);

  // ── Filter: actual comments (issue-note / issue-edit with text) by a sales rep ──
  const salesComments = newEntries.filter(e =>
    (e.type === 'issue-note' || e.type === 'issue-edit') &&
    e.desc && e.desc.trim().length > 0 &&
    e.author && SALES_REPS_LOWER.has(e.author.toLowerCase())
  );

  if (salesComments.length === 0) {
    console.log('  ✅ No new sales-rep comments.');
    return true;
  }

  console.log(`  💬 ${salesComments.length} new sales-rep comment(s) found:\n`);

  const detailedRecords = [];
  for (const e of salesComments) {
    const record = {
      href:       e.key,
      title:      e.title,
      author:     e.author,
      snippet:    e.desc.length > 300 ? e.desc.slice(0, 297) + '...' : e.desc,
      url:        `https://support.paymentiq.io${e.key}`,
      detectedAt: new Date().toISOString(),
    };
    detailedRecords.push(record);

    console.log(`  ┌─ ${record.title}`);
    console.log(`  │  Author: ${record.author}`);
    console.log(`  │  URL:    ${record.url}`);
    console.log(`  └─ Snippet: ${record.snippet.slice(0, 80)}\n`);

    await sendSlackMessage(record);
  }

  // Append to log file
  let existingLog = [];
  if (existsSync(LOG_FILE)) {
    try { existingLog = JSON.parse(readFileSync(LOG_FILE, 'utf8')); } catch { existingLog = []; }
  }
  existingLog.push(...detailedRecords);
  writeFileSync(LOG_FILE, JSON.stringify(existingLog, null, 2));
  console.log(`  💾 Log saved to redmine_sales_comments_log.json`);

  const names = detailedRecords.map(r => `${r.author} on ${r.title}`).join(', ');
  notify(
    `💬 ${detailedRecords.length} new sales comment(s)`,
    names.length > 100 ? names.slice(0, 97) + '...' : names
  );

  return true;
}

// ─── Main loop ─────────────────────────────────────────────────────────────────

let reconnecting = false;

// main() recurses on itself (reconnect-on-disconnect, soft-reconnect-on-
// stuck, retry-on-connect-failure) via setTimeout(() => main(), N). A bare
// setTimeout callback is fire-and-forget — if that recursive call throws
// (confirmed on the board watcher: "Cannot read properties of undefined
// (reading 'pages')" when browser.contexts() came back empty), the rejection
// is unhandled and crashes the whole process. That's happened for real — a
// watcher sat dead for over a day until manually restarted, because
// KeepAlive isn't a reliable enough safety net on its own (see the
// MAX_CONSECUTIVE_FAILURES comment below for the matching lesson on
// process.exit()). Always schedule main() through this wrapper instead of
// calling it directly in a setTimeout, so ANY future bug in main() gets
// caught, logged, and retried instead of silently killing the process.
function safeMain(delayMs) {
  setTimeout(() => {
    main().catch(e => {
      console.error(`\n  ❌ Unhandled error in main(): ${e.message}\n  Retrying in 30s...\n`);
      safeMain(30000);
    });
  }, delayMs);
}

async function main() {
  reconnecting = false;

  let browser;
  try {
    browser = await connectChrome();
  } catch (e) {
    console.error(`\n  ❌ ${e.message}\n`);
    console.log('  Retrying in 30s...');
    safeMain(30000);
    return;
  }

  // browser.contexts() has been observed empty right after connecting (crashed
  // the board watcher once with this exact pattern). Fall back to creating
  // one rather than assuming Chrome always already has a default context.
  const context = browser.contexts()[0] || await browser.newContext();

  // Reuse an existing activity tab if one is already open (e.g. left over
  // from a previous run of this script) instead of always opening a new
  // one — prevents tabs from accumulating across restarts/reconnects.
  // Any OTHER stray tabs already on the activity page get closed too, so
  // a prior leak self-heals on the next restart.
  const activityUrlPrefix = ACTIVITY_URL.split('?')[0];
  const existingPages = context.pages().filter(p => p.url().startsWith(activityUrlPrefix));
  let page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    console.log(`  Reusing existing activity tab${existingPages.length > 1 ? ` (closing ${existingPages.length - 1} stray duplicate(s))` : ''}.`);
    for (const stray of existingPages.slice(1)) {
      await stray.close().catch(() => {});
    }
  } else {
    page = await context.newPage();
    console.log('  Activity tab opened.');
  }
  const pageRef = { page };

  let pollInterval = null;

  browser.on('disconnected', () => {
    if (reconnecting) return;
    reconnecting = true;
    clearInterval(pollInterval);
    console.log('\n  ⚠️  Chrome disconnected — reconnecting in 10s...');
    safeMain(10000);
  });

  if (RUN_ONCE) {
    await checkActivity(context, pageRef);
    return;
  }

  console.log(`\n  Redmine Sales-Comment Watcher started.`);
  console.log(`  Checking every ${POLL_INTERVAL_MS / 60000} minutes.`);
  console.log(`  Watching for comments from: ${SALES_REPS.join(', ')}`);
  console.log(`  Press Ctrl+C to stop.\n`);

  // Consecutive-failure tracking: if the Chrome debug instance's network
  // gets stuck (the common post-sleep failure mode), every cycle fails but
  // the process itself stays alive and the log keeps updating — nothing
  // else here would catch that. Rather than depend on an external watchdog
  // timer to notice and restart us (macOS's StartInterval LaunchAgents are
  // NOT reliable about firing after the system sleeps — confirmed: ours
  // went 3 days without actually running despite being "scheduled" every
  // 15 min), soft-reconnect after MAX_CONSECUTIVE_FAILURES in a row:
  // clear this interval, detach from the current (stuck) Chrome connection,
  // and call main() again for a fresh connectChrome() — the same effective
  // fix as a manual restart, but entirely in-process.
  //
  // IMPORTANT: this must NEVER be process.exit() + rely on launchd's
  // KeepAlive. That was tried first and caused a full silent outage: when
  // the underlying issue didn't clear after one restart, repeated exits
  // tripped macOS's crash-loop/efficiency throttling (launchd marked the
  // job "inefficient" and simply stopped relaunching it — confirmed via
  // `launchctl print`, no further runs for 21+ hours until manually
  // kickstarted). Reconnecting without ever exiting the process sidesteps
  // that class of failure entirely — launchd has nothing to throttle.
  let consecutiveFailures = 0;
  const registerResult = (ok) => {
    if (ok) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !reconnecting) {
      reconnecting = true;
      clearInterval(pollInterval);
      console.log(`\n  ❌ ${consecutiveFailures} consecutive failed cycles — reconnecting with a fresh Chrome connection...\n`);
      browser.close().catch(() => {});
      safeMain(1000);
    }
  };

  try {
    registerResult(await checkActivity(context, pageRef));
  } catch (e) {
    console.error(`\n  ❌ Unexpected error during check: ${e.message}\n`);
    registerResult(false);
  }

  pollInterval = setInterval(async () => {
    try {
      if (pageRef.page.isClosed()) {
        console.log('  Activity tab was closed — reopening...');
        pageRef.page = await context.newPage();
      }
      registerResult(await checkActivity(context, pageRef));
    } catch (e) {
      console.error(`\n  ❌ Unexpected error during check: ${e.message}\n`);
      registerResult(false);
    }
  }, POLL_INTERVAL_MS);
}

main().catch(e => {
  console.error(`\n  ❌ Fatal: ${e.message}\n`);
  process.exit(1);
});
