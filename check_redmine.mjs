/**
 * check_redmine.mjs — Redmine Agile Board Watcher (macOS)
 * --------------------------------------------------------
 * Watches the PaymentIQ Redmine Agile board for new issues.
 * Scrapes the board via Playwright (connects to your running Chrome session).
 * Sends a Slack message for every new issue found.
 * Runs in a loop every 15 minutes.
 *
 * Usage:
 *   node check_redmine.mjs             — run once then loop
 *   node check_redmine.mjs --once      — run once and exit
 *
 * First time: open the Redmine board in Chrome, then run this script.
 * It will save the board URL automatically for future headless runs.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SNAPSHOT_FILE  = path.join(__dirname, 'redmine_board_snapshot.json');
const NEW_ISSUES_LOG = path.join(__dirname, 'redmine_new_issues.json');
const BOARD_URL_FILE = path.join(__dirname, 'redmine_board_url.txt');
const CONFIG_FILE    = path.join(__dirname, 'config.json');

// All per-deployment settings (Slack token/channel, sales rep list) live in
// config.json — edit that file, not this one, to point this at a different
// Slack destination or sales team.
const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));

const SLACK_BOT_TOKEN  = config.slackBotToken;
const SLACK_RECIPIENTS = config.slackRecipients;

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — keeps the Redmine session alive (session idle-timeout is shorter than 15 min)
const RUN_ONCE = process.argv.includes('--once');

// ─── Columns that trigger a "moved" alert ────────────────────────────────────
// Any issue that lands in one of these columns (from any other column) will
// fire a Slack alert, even if the issue was already known.
const WATCHED_COLUMNS = [
  'Signed - Assign PM',
  'Merchant Change Request',
  'Documentation Access',
];

// ─── Columns that never trigger any alert ────────────────────────────────────
// A ticket that is (or becomes) Suspended is never something to alert on —
// whether it's first spotted there (e.g. created and suspended within one
// poll cycle) or moved there from another column. Matched case-insensitively
// as a substring, so it also covers "Suspended Merchant" and similar variants.
const SUPPRESSED_COLUMNS = [
  'suspended',
];
const isSuppressedColumn = (colName) =>
  SUPPRESSED_COLUMNS.some(s => (colName || '').toLowerCase().includes(s));

// ─── Sanity cap on "new issues" per cycle ─────────────────────────────────────
// The board URL encodes its status filter in the query string. After a Chrome
// reconnect, Redmine has occasionally ignored that filter and served a
// completely different view (e.g. showing Closed/Terminated/On hold tickets
// that are normally excluded) instead of erroring or returning 0 cards. Since
// none of those cards are in the snapshot, every one of them looks "new" —
// without this cap that means Slack gets blasted with dozens of false alerts
// for tickets that were never actually new. If a cycle sees more new issues
// than this, treat it as a suspicious view mismatch instead of trusting it.
const MAX_NEW_ISSUES_PER_CYCLE = 10;

// ─── Self-restart on repeated failure ─────────────────────────────────────────
// See the comment at registerResult() in main() for why this exists instead
// of relying on the external watchdog.sh timer.
const MAX_CONSECUTIVE_FAILURES = 2;

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
        text: `🆕 *New Redmine Issue*\n*<${record.url}|#${record.id}: ${record.clientName}>*`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status:*\n${record.boardStatus}` },
        { type: 'mrkdwn', text: `*Sales Rep:*\n${record.salesRep}` },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Issue' },
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
          text: `🆕 New Redmine issue — *<${record.url}|#${record.id}: ${record.clientName}>*`,
          blocks,
        }),
      });
      const result = await res.json();
      if (!result.ok) {
        console.error(`  [Slack] Failed to send to ${recipient}: ${result.error}`);
      } else {
        console.log(`  [Slack] Message sent to ${recipient} for #${record.id}`);
      }
    } catch (e) {
      console.error(`  [Slack] Network error sending to ${recipient}: ${e.message}`);
    }
  }
}

// ─── Slack: column-move alert ─────────────────────────────────────────────────

async function sendSlackMoveMessage(record) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📋 *Issue moved — action needed*\n*<${record.url}|#${record.id}: ${record.clientName}>*`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Moved to:*\n${record.boardStatus}` },
        { type: 'mrkdwn', text: `*Was in:*\n${record.previousColumn}` },
        { type: 'mrkdwn', text: `*Sales Rep:*\n${record.salesRep}` },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Issue' },
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
          text: `📋 Issue moved to ${record.boardStatus} — *<${record.url}|#${record.id}: ${record.clientName}>*`,
          blocks,
        }),
      });
      const result = await res.json();
      if (!result.ok) {
        console.error(`  [Slack] Failed to send move alert to ${recipient}: ${result.error}`);
      } else {
        console.log(`  [Slack] Move alert sent to ${recipient} for #${record.id}`);
      }
    } catch (e) {
      console.error(`  [Slack] Network error sending move alert to ${recipient}: ${e.message}`);
    }
  }
}

// ─── Chrome connect ───────────────────────────────────────────────────────────

// Playwright doesn't finish attaching to a Chrome instance's EXISTING tabs
// the instant connectOverCDP() resolves — context.pages() can briefly report
// an incomplete list right after connecting. Calling it too early is exactly
// what caused "Reusing existing board tab" to flip to "Board tab opened"
// (a genuine duplicate) across otherwise-identical restarts: the dedup check
// ran before Playwright had attached to the tab that was already there. A
// short settle delay after every connect gives it time to catch up.
async function connectAndSettle(url) {
  const browser = await chromium.connectOverCDP(url);
  await new Promise(r => setTimeout(r, 1500));
  return browser;
}

async function connectChrome() {
  // 1. Try existing Chrome debug session on port 9222
  try {
    const browser = await connectAndSettle('http://localhost:9222');
    console.log('  Connected to existing Chrome session.');
    return browser;
  } catch {
    // Not accepting CDP connections right now — don't assume it's not
    // running at all. Fall through to check before ever spawning anything.
  }

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  // Dedicated debug profile dir — fully isolated from your real Chrome profile.
  // Deliberately NOT copied/seeded from your real profile: that would clone your
  // Microsoft/Azure AD SSO session into a second browser instance, and the two
  // copies silently racing to refresh the same session can invalidate each
  // other's token and force your real browser back to a Microsoft login prompt.
  // Log into Redmine manually once in this debug window; the session persists here after that.
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

  // Remove stale lockfile if present
  try {
    execSync(`rm -f "${debugProfileDir}/Default/lockfile" "${debugProfileDir}/lockfile"`, { stdio: 'ignore' });
  } catch { /* ignore */ }

  // Launch Chrome detached
  spawn(chromePath, [
    '--remote-debugging-port=9222',
    '--profile-directory=Default',
    `--user-data-dir=${debugProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,800',
  ], { detached: true, stdio: 'ignore' }).unref();

  // Wait for Chrome to start accepting connections
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

// ─── Single board check (reuses existing browser + boardPage) ─────────────────

async function checkBoard(context, boardPageRef) {
   let boardPage = boardPageRef.page;
  const startTime = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', hour12: false }).replace(',', '');
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  Redmine Board Check — ${startTime} CET`);
  console.log(`${'═'.repeat(55)}`);

   const boardUrl = readFileSync(BOARD_URL_FILE, 'utf8').trim();

   console.log('  Loading board...');
   try {
     await boardPage.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
     await boardPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
     await boardPage.waitForSelector('.issue-card', { timeout: 20000 }).catch(() => {});
   } catch (e) {
     // Board tab failed — Redmine is likely down/slow.
     // Do NOT open a new tab — just reset the existing tab to about:blank and skip.
     // This means zero new tabs accumulate overnight, no matter how many failures occur.
     console.log(`  ⚠️  Board load failed (${e.message.split('\n')[0]}) — skipping cycle, will retry next check.`);
     await boardPage.goto('about:blank').catch(() => {});
     return false;
   }

  // ── Scrape all issue cards ─────────────────────────────────────────────────
  const issues = await boardPage.evaluate(() => {
    const allTh     = [...document.querySelectorAll('th')];
    const totalCols = Math.round(allTh.length / 2);
    const headers   = allTh.slice(0, totalCols).map(th =>
      th.textContent?.trim().replace(/\s*\(\d+\)\s*$/, '').trim()
    );
    const tds    = [...document.querySelectorAll('tr.issue td.issue-status-col')];
    const result = [];

    tds.forEach((td, colIdx) => {
      const colName = headers[colIdx] || `Column ${colIdx}`;
      [...td.querySelectorAll('.issue-card')].forEach(card => {
        const id     = card.getAttribute('data-id');
        const linkEl = card.querySelector('a[href*="/issues/"]');
        const subject = linkEl?.textContent?.trim()
          || card.textContent?.trim().split('\n')[0]?.trim();
        result.push({ id, subject: subject?.slice(0, 100), colName, href: `/issues/${id}` });
      });
    });

    return result.filter(i => i.id && i.subject);
  });

  const currentIssues = {};
  issues.forEach(i => { currentIssues[i.id] = i; });

  // ── Load previous snapshot ─────────────────────────────────────────────────
  let previousIssues = {};
  if (existsSync(SNAPSHOT_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
      previousIssues = saved.lastGoodSnapshot || saved;
    } catch { previousIssues = {}; }
  }

  // ── Guard: 0 cards = likely load failure ──────────────────────────────────
  if (issues.length === 0) {
    console.log('\n  ⚠️  Board returned 0 cards — possible load failure or Redmine down.');
    console.log('  Snapshot NOT updated. Will compare against last good snapshot on next run.\n');
    return false;
  }

  // ── Guard: true first run (no snapshot existed at all) — save everything
  // currently on the board as the baseline and stop here. NEVER alert on
  // any of it, no matter how many cards there are: with no prior snapshot,
  // every single card would otherwise look "new" and get Slack-blasted.
  // This must run BEFORE the newIssues/movedIssues diff below, not just
  // rely on the MAX_NEW_ISSUES_PER_CYCLE cap — that cap only guards cycles
  // that already had a previous snapshot to compare against.
  if (Object.keys(previousIssues).length === 0) {
    writeFileSync(SNAPSHOT_FILE, JSON.stringify({
      lastGoodSnapshot: currentIssues,
      lastUpdated:      new Date().toISOString(),
      cardCount:        issues.length,
    }, null, 2));
    console.log(`\n  First run — saved ${issues.length} existing card(s) as the baseline, no alerts sent.`);
    console.log('  Will only alert on genuinely new tickets or watched-column moves from the next check onward.\n');
    return true;
  }

  // ── Compare ────────────────────────────────────────────────────────────────
  // Suspended tickets never alert, whether first spotted there or moved there.
  const newIssues  = issues.filter(i => !previousIssues[i.id] && !isSuppressedColumn(i.colName));
  const removedIds = Object.keys(previousIssues).filter(id => !currentIssues[id]);

  // Issues that already existed but moved INTO a watched column
  const movedIssues = issues.filter(i =>
    previousIssues[i.id] &&                              // was known before
    previousIssues[i.id].colName !== i.colName &&        // column changed
    WATCHED_COLUMNS.includes(i.colName) &&               // new column is watched
    !WATCHED_COLUMNS.includes(previousIssues[i.id].colName) && // wasn't already in a watched col
    !isSuppressedColumn(i.colName)                       // never alert on a move INTO Suspended
  );

  // ── Guard: suspiciously many "new" issues at once = likely a filter/view
  // mismatch (see MAX_NEW_ISSUES_PER_CYCLE comment above), not real new
  // tickets. Skip alerting and DON'T overwrite the snapshot, so the next
  // cycle re-diffs against the last known-good view instead of adopting
  // this one as the new baseline.
  if (Object.keys(previousIssues).length > 0 && newIssues.length > MAX_NEW_ISSUES_PER_CYCLE) {
    console.log(`\n  ⚠️  ${newIssues.length} "new" issues at once (> ${MAX_NEW_ISSUES_PER_CYCLE}) — looks like a filter/view mismatch, not real new tickets.`);
    console.log('  Skipping Slack alerts and snapshot update this cycle; will re-check next run.\n');
    notify(
      'Redmine board: suspicious view mismatch',
      `${newIssues.length} tickets looked new at once — skipped alerting, check the board manually.`
    );
    return false;
  }

  // Save snapshot
  writeFileSync(SNAPSHOT_FILE, JSON.stringify({
    lastGoodSnapshot: currentIssues,
    lastUpdated:      new Date().toISOString(),
    cardCount:        issues.length,
  }, null, 2));

  // ── Column summary ─────────────────────────────────────────────────────────
  console.log('\n  Board columns:');
  const colCounts = {};
  issues.forEach(i => { colCounts[i.colName] = (colCounts[i.colName] || 0) + 1; });
  Object.entries(colCounts).forEach(([col, count]) =>
    console.log(`    ${col}: ${count}`)
  );
  console.log(`    ${'─'.repeat(30)}`);
  console.log(`    Total: ${issues.length} cards\n`);

  // ── Handle new issues + moved issues — one shared detail tab ────────────────
  const needsDetail = newIssues.length > 0 || movedIssues.length > 0;

  // Helper: navigate detail tab on demand, creating it if needed
  // detailPage is managed locally — opened when first needed, closed at end
  let detailPage = null;
  async function gotoDetail(url) {
    if (!detailPage || detailPage.isClosed()) {
      detailPage = await context.newPage();
    }
    await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await detailPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }

  // New issues (true first-run case is already handled and returned above,
  // so previousIssues is guaranteed non-empty here)
  if (newIssues.length === 0) {
    console.log('  ✅ No new issues since last check.');
  } else {
    console.log(`  🆕 ${newIssues.length} new issue(s) found — fetching details...\n`);
    const detailedNewIssues = [];

    for (const issue of newIssues) {
      const issueUrl = `https://support.paymentiq.io${issue.href}`;
      console.log(`  Opening #${issue.id}: ${issue.subject}`);

      // One bad detail-page fetch (timeout, aborted nav, etc.) must not crash
      // the whole process or skip the remaining issues in this batch.
      try {
        await gotoDetail(issueUrl);

        const details = await detailPage.evaluate(() => {
          const title = document.querySelector('.subject h3, h3.icon-issue')?.textContent?.trim()
            || document.title.split(' - ')[0].replace(/^.*#\d+:\s*/, '').trim();
          const salesRepLabel = [...document.querySelectorAll('div.label')]
            .find(d => d.textContent?.trim().replace(':', '') === 'Sales rep');
          const salesRep = salesRepLabel?.nextElementSibling
            ?.querySelector('a.user')?.textContent?.trim() || 'N/A';
          return { title, salesRep };
        });

        const record = {
          id:          issue.id,
          clientName:  details.title || issue.subject,
          boardStatus: issue.colName,
          salesRep:    details.salesRep,
          url:         issueUrl,
          detectedAt:  new Date().toISOString(),
        };

        detailedNewIssues.push(record);

        console.log(`\n  ┌─ #${record.id}`);
        console.log(`  │  Client:    ${record.clientName}`);
        console.log(`  │  Status:    ${record.boardStatus}`);
        console.log(`  │  Sales Rep: ${record.salesRep}`);
        console.log(`  │  URL:       ${issueUrl}`);
        console.log(`  └─ Detected:  ${record.detectedAt}\n`);

        await sendSlackMessage(record);
      } catch (e) {
        console.log(`  ⚠️  Could not fetch/alert for #${issue.id}: ${e.message.split('\n')[0]} — continuing with the rest of the batch.\n`);
      }
    }

    // Append to log file
    let existingLog = [];
    if (existsSync(NEW_ISSUES_LOG)) {
      try { existingLog = JSON.parse(readFileSync(NEW_ISSUES_LOG, 'utf8')); } catch { existingLog = []; }
    }
    existingLog.push(...detailedNewIssues);
    writeFileSync(NEW_ISSUES_LOG, JSON.stringify(existingLog, null, 2));
    console.log(`  💾 Log saved to redmine_new_issues.json`);

    const names = detailedNewIssues.map(i => i.clientName).join(', ');
    notify(
      `🆕 ${detailedNewIssues.length} new Redmine issue(s)`,
      names.length > 100 ? names.slice(0, 97) + '...' : names
    );
  }

  // Moved issues — reuse the same detail tab
  if (movedIssues.length > 0) {
    console.log(`\n  📋 ${movedIssues.length} issue(s) moved into watched column(s) — fetching details...\n`);

    for (const issue of movedIssues) {
      const issueUrl = `https://support.paymentiq.io${issue.href}`;
      console.log(`  Opening #${issue.id}: ${issue.subject}`);

      // Send a basic alert immediately — before detail fetch — so a tab crash can't swallow it
      const basicRecord = {
        id:             issue.id,
        clientName:     issue.subject,
        boardStatus:    issue.colName,
        previousColumn: previousIssues[issue.id].colName,
        salesRep:       'N/A',
        url:            issueUrl,
        detectedAt:     new Date().toISOString(),
      };
      await sendSlackMoveMessage(basicRecord);
      notify(
        `📋 Issue #${issue.id} needs attention`,
        `${issue.subject} → ${issue.colName}`
      );

      // Then try to enrich with details (salesRep etc.) and send an updated alert if successful
      try {
        await gotoDetail(issueUrl);

        const details = await detailPage.evaluate(() => {
          const title = document.querySelector('.subject h3, h3.icon-issue')?.textContent?.trim()
            || document.title.split(' - ')[0].replace(/^.*#\d+:\s*/, '').trim();
          const salesRepLabel = [...document.querySelectorAll('div.label')]
            .find(d => d.textContent?.trim().replace(':', '') === 'Sales rep');
          const salesRep = salesRepLabel?.nextElementSibling
            ?.querySelector('a.user')?.textContent?.trim() || 'N/A';
          return { title, salesRep };
        });

        if (details.salesRep !== 'N/A' || details.title !== issue.subject) {
          const enrichedRecord = {
            ...basicRecord,
            clientName: details.title || issue.subject,
            salesRep:   details.salesRep,
          };
          console.log(`\n  ┌─ #${enrichedRecord.id} MOVED`);
          console.log(`  │  Client:    ${enrichedRecord.clientName}`);
          console.log(`  │  From:      ${enrichedRecord.previousColumn}`);
          console.log(`  │  To:        ${enrichedRecord.boardStatus}`);
          console.log(`  │  Sales Rep: ${enrichedRecord.salesRep}`);
          console.log(`  └─ Detected:  ${enrichedRecord.detectedAt}\n`);
        }
      } catch (e) {
        console.log(`  ⚠️  Could not fetch details for #${issue.id}: ${e.message.split('\n')[0]}`);
        console.log(`  (Alert already sent with basic info)\n`);
      }
    }
  }

  // Close the single detail tab (only if it was opened)
  // Close the detail tab if it was opened this cycle
  if (detailPage && !detailPage.isClosed()) await detailPage.close().catch(() => {});

  // ── Removed issues ─────────────────────────────────────────────────────────
  if (removedIds.length > 0) {
    console.log(`\n  📤 Issues moved off board (${removedIds.length}):`);
    removedIds.forEach(id => {
      const prev = previousIssues[id];
      console.log(`    #${id} [was: ${prev?.colName}] ${prev?.subject}`);
    });
  }

  return true;
}

// ─── Main loop ─────────────────────────────────────────────────────────────────

let reconnecting = false;

// main() recurses on itself (reconnect-on-disconnect, soft-reconnect-on-
// stuck, retry-on-connect-failure) via setTimeout(() => main(), N). A bare
// setTimeout callback is fire-and-forget — if that recursive call throws
// (confirmed: it has, e.g. "Cannot read properties of undefined (reading
// 'pages')" when browser.contexts() came back empty), the rejection is
// unhandled and crashes the whole process. That's happened for real — the
// board watcher sat dead for over a day until manually restarted, because
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
  // the whole process once with "Cannot read properties of undefined (reading
  // 'pages')" when [0] was undefined). Fall back to creating one rather than
  // assuming Chrome always already has a default context.
  const context = browser.contexts()[0] || await browser.newContext();

  // One permanent board tab wrapped in a ref so checkBoard can replace it on timeout.
  // Also sweeps up any stray extra board tabs (or ones reset to about:blank by a
  // prior load failure) left behind by earlier restarts/reconnects, so leaked
  // tabs self-heal instead of accumulating indefinitely.
  const boardUrl = readFileSync(BOARD_URL_FILE, 'utf8').trim();
  const boardUrlPrefix = boardUrl.split('?')[0];
  const existingPages = context.pages();
  const matchingPages = existingPages.filter(p => p.url().startsWith(boardUrlPrefix));
  const blankPages = existingPages.filter(p => p.url() === 'about:blank');
  let boardPage;
  if (matchingPages.length > 0) {
    boardPage = matchingPages[0];
    console.log(`  Reusing existing board tab${matchingPages.length > 1 ? ` (closing ${matchingPages.length - 1} stray duplicate(s))` : ''}.`);
    for (const stray of matchingPages.slice(1)) {
      await stray.close().catch(() => {});
    }
  } else {
    boardPage = await context.newPage();
    console.log('  Board tab opened.');
  }
  // Close leftover about:blank tabs from previous failed cycles (but never the
  // one we're about to use, in case boardPage itself is currently blank).
  for (const blank of blankPages) {
    if (blank !== boardPage) await blank.close().catch(() => {});
  }
  // Also sweep up leftover per-ticket "detail" tabs (gotoDetail() opens
  // https://support.paymentiq.io/issues/<id> while fetching a new/moved
  // issue's info). These are meant to be closed at the end of every cycle,
  // but a restart/reconnect mid-cycle can leave one open indefinitely.
  const staleDetailPages = existingPages.filter(p => /\/issues\/\d+/.test(p.url()));
  for (const stale of staleDetailPages) {
    await stale.close().catch(() => {});
  }
  const boardPageRef = { page: boardPage };

  let pollInterval = null;

  browser.on('disconnected', () => {
    if (reconnecting) return;
    reconnecting = true;
    clearInterval(pollInterval);
    console.log('\n  ⚠️  Chrome disconnected — reconnecting in 10s...');
    safeMain(10000);
  });

  if (RUN_ONCE) {
    try {
      await checkBoard(context, boardPageRef, null);
    } catch (e) {
      console.error(`\n  ❌ Unexpected error during check: ${e.message}\n`);
    }
    return;
  }

  console.log(`\n  Redmine Board Watcher started.`);
  console.log(`  Checking every ${POLL_INTERVAL_MS / 60000} minutes.`);
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
    registerResult(await checkBoard(context, boardPageRef, null));
  } catch (e) {
    console.error(`\n  ❌ Unexpected error during check: ${e.message}\n`);
    registerResult(false);
  }

  pollInterval = setInterval(async () => {
    try {
      // Recover the board tab if it was closed externally
      if (boardPageRef.page.isClosed()) {
        console.log('  Board tab was closed — reopening...');
        boardPageRef.page = await context.newPage();
      }
      registerResult(await checkBoard(context, boardPageRef, null));
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
