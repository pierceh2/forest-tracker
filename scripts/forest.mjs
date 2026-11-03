// Scrapes today's focus time from the Forest browser extension's options page,
// using a real (non-headless) Chromium under xvfb with the extension loaded.
// Writes forest.json (for your app) and data/history.json (per-day totals).

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const EXT_ID = process.env.FOREST_EXT_ID || 'kjacjjdnoddnpbbcjilcajfhhbdhkpgk';
const OPTIONS_PATH = process.env.FOREST_OPTIONS_PATH || 'src/options/index.html';
const TZ = process.env.TZ_NAME || 'America/Los_Angeles';
const EMAIL = process.env.FOREST_EMAIL;
const PASSWORD = process.env.FOREST_PASSWORD;
const BACKFILL_DAYS = parseInt(process.env.BACKFILL_DAYS || '0', 10) || 0;

const WORK = path.resolve('.work');
const PROFILE = path.join(WORK, 'profile');
const EXT_DIR = path.join(WORK, 'ext');
const DEBUG_DIR = path.resolve('debug');
const OUT_FILE = 'forest.json';
const HISTORY_FILE = 'data/history.json';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
// e.g. "November 2nd (Mon)" - the prev/next day links under the forest
const NAV_SEL = 'text=/^[A-Z][a-z]+ \\d{1,2}(st|nd|rd|th) \\(\\w{3}\\)$/';
const DAY_RE = /([A-Z][a-z]+) (\d{1,2})(?:st|nd|rd|th) \(\w{3}\)/;

if (!EMAIL || !PASSWORD) {
  console.error('Missing FOREST_EMAIL / FOREST_PASSWORD secrets.');
  process.exit(1);
}

fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(DEBUG_DIR, { recursive: true });

// ---------- helpers ----------

const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD

function keyToUTC(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(key, n) {
  return new Date(keyToUTC(key) + n * 86400000).toISOString().slice(0, 10);
}

// "November 1st" has no year: pick the year that puts it at or just before today.
function monthDayToKey(monthName, day) {
  const today = todayKey();
  const month = MONTHS.indexOf(monthName);
  if (month < 0) return null;
  let year = Number(today.slice(0, 4));
  const mk = (y) => `${y}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (keyToUTC(mk(year)) > keyToUTC(today) + 86400000) year -= 1;
  return mk(year);
}

async function fetchExtension() {
  if (fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) return;
  const url = 'https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0.0.0'
    + `&acceptformat=crx2,crx3&x=id%3D${EXT_ID}%26uc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Extension download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error('Downloaded file is not a CRX');
  const version = buf.readUInt32LE(4);
  const zipStart = version === 3
    ? 12 + buf.readUInt32LE(8)
    : 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  const zipPath = path.join(WORK, 'ext.zip');
  fs.writeFileSync(zipPath, buf.subarray(zipStart));
  fs.mkdirSync(EXT_DIR, { recursive: true });
  execSync(`unzip -q -o "${zipPath}" -d "${EXT_DIR}"`);
}

async function getExtensionId(ctx) {
  const existing = ctx.serviceWorkers()[0] ?? ctx.backgroundPages()[0];
  if (existing) return new URL(existing.url()).host;
  try {
    const found = await Promise.any([
      ctx.waitForEvent('serviceworker', { timeout: 15000 }),
      ctx.waitForEvent('backgroundpage', { timeout: 15000 }),
    ]);
    return new URL(found.url()).host;
  } catch {
    return EXT_ID; // fall back to the store ID
  }
}

function authSurfaces(page) {
  return page.context().pages().flatMap((openPage) => [openPage, ...openPage.frames()]);
}

async function findVisibleAuthLocator(page, factories, preferLast = false) {
  const surfaces = authSurfaces(page);
  if (preferLast) surfaces.reverse();
  for (const surface of surfaces) {
    for (const factory of factories) {
      const locator = factory(surface);
      let count;
      try {
        count = await locator.count();
      } catch {
        continue;
      }
      for (let offset = 0; offset < count; offset++) {
        const i = preferLast ? count - offset - 1 : offset;
        const candidate = locator.nth(i);
        try {
          if (await candidate.isVisible()) return { surface, locator: candidate };
        } catch {
          // A popup or frame may close while authentication is transitioning.
        }
      }
    }
  }
  return null;
}

async function waitForAuthLocator(page, factories, description, timeout = 15000, preferLast = false) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await findVisibleAuthLocator(page, factories, preferLast);
    if (found) return found;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function authText(regex) {
  return [
    (surface) => surface.getByRole('button', { name: regex }),
    (surface) => surface.getByText(regex, { exact: true }),
  ];
}

function authInput(selector) {
  return [(surface) => surface.locator(selector)];
}

async function ensureLoggedIn(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  const emailInput = authInput(
    'input[type="email"], input[name*="email" i], input[placeholder*="email" i]',
  );
  const passwordInput = authInput('input[type="password"]');
  const loginChoice = authText(/^continue with email$/i);
  const confirmLogin = authText(/^confirm login$/i);
  const email = await findVisibleAuthLocator(page, emailInput);
  const password = await findVisibleAuthLocator(page, passwordInput);
  const choice = await findVisibleAuthLocator(page, loginChoice);
  const confirm = await findVisibleAuthLocator(page, confirmLogin);

  if (!email && !password && !choice && !confirm) {
    const login = await findVisibleAuthLocator(page, authText(/^log ?in$/i));
    if (!login) return;
    await login.locator.click();
    console.log('Opened Forest sign-in');
  }

  const authStep = [
    ...loginChoice,
    ...confirmLogin,
    ...emailInput,
    ...passwordInput,
  ];
  await waitForAuthLocator(page, authStep, 'an email sign-in option or form');

  let confirmedRememberedAccount = false;
  let confirmButton = await findVisibleAuthLocator(page, confirmLogin);
  if (confirmButton) {
    const visibleText = await confirmButton.surface.locator('body').innerText();
    if (visibleText.toLowerCase().includes(EMAIL.toLowerCase())) {
      await confirmButton.locator.click();
      confirmedRememberedAccount = true;
      console.log('Confirmed the remembered Forest account');
    } else {
      const useAnother = await findVisibleAuthLocator(page, authText(/^use another account$/i));
      if (!useAnother) {
        throw new Error('Forest offered a remembered account that does not match FOREST_EMAIL');
      }
      await useAnother.locator.click();
      console.log('Selected another Forest account');
      await waitForAuthLocator(
        page,
        [...loginChoice, ...emailInput, ...passwordInput],
        'email sign-in after choosing another account',
      );
    }
  }

  if (confirmedRememberedAccount) {
    await page.waitForTimeout(1000);
    const emailStillVisible = await findVisibleAuthLocator(page, emailInput);
    const passwordStillVisible = await findVisibleAuthLocator(page, passwordInput);
    const choiceStillVisible = await findVisibleAuthLocator(page, loginChoice);
    const confirmStillVisible = await findVisibleAuthLocator(page, confirmLogin);
    if (!emailStillVisible && !passwordStillVisible && !choiceStillVisible && !confirmStillVisible) {
      await page.waitForLoadState('networkidle').catch(() => {});
      return;
    }
  }

  let emailButton = await findVisibleAuthLocator(page, loginChoice);
  if (emailButton) {
    await emailButton.locator.click();
    console.log('Selected email sign-in');
  }

  let emailField = await findVisibleAuthLocator(page, emailInput);
  if (!emailField && emailButton) {
    emailField = await waitForAuthLocator(page, emailInput, 'the Forest email field');
  }
  let emailStepSubmitted = false;
  if (emailField) {
    await emailField.locator.fill(EMAIL);
    const passwordNow = await findVisibleAuthLocator(page, passwordInput);
    if (!passwordNow) {
      const continueButton = await waitForAuthLocator(
        page,
        authText(/^continue$/i),
        'Continue after entering the Forest email',
        15000,
        true,
      );
      await continueButton.locator.click();
      emailStepSubmitted = true;
      console.log('Submitted Forest email');
    }
  }

  let passwordField = await findVisibleAuthLocator(page, passwordInput);
  if (!passwordField && emailStepSubmitted) {
    await waitForAuthLocator(
      page,
      [...passwordInput, ...confirmLogin],
      'the password form or remembered-account confirmation',
    );
    passwordField = await findVisibleAuthLocator(page, passwordInput);
  }
  if (!passwordField) {
    confirmButton = await findVisibleAuthLocator(page, confirmLogin);
    if (confirmButton) {
      const visibleText = await confirmButton.surface.locator('body').innerText();
      if (!visibleText.toLowerCase().includes(EMAIL.toLowerCase())) {
        throw new Error('Forest confirmation does not list the configured FOREST_EMAIL');
      }
      await confirmButton.locator.click();
      confirmedRememberedAccount = true;
      console.log('Confirmed the remembered Forest account');
    }
    passwordField = await findVisibleAuthLocator(page, passwordInput);
    if (!passwordField && confirmedRememberedAccount) {
      await page.waitForTimeout(1000);
      const emailStillVisible = await findVisibleAuthLocator(page, emailInput);
      const choiceStillVisible = await findVisibleAuthLocator(page, loginChoice);
      const confirmStillVisible = await findVisibleAuthLocator(page, confirmLogin);
      if (!emailStillVisible && !choiceStillVisible && !confirmStillVisible) {
        await page.waitForLoadState('networkidle').catch(() => {});
        return;
      }
    }
    if (!passwordField) {
      passwordField = await waitForAuthLocator(page, passwordInput, 'the Forest password field');
    }
  }

  await passwordField.locator.fill(PASSWORD);
  const submit = await waitForAuthLocator(
    page,
    authText(/^(continue|log ?in|sign ?in)$/i),
    'the Forest sign-in Continue button',
    15000,
    true,
  );
  await submit.locator.click();
  console.log('Submitted Forest password');

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const remainingPassword = await findVisibleAuthLocator(page, passwordInput);
    const remainingEmail = await findVisibleAuthLocator(page, emailInput);
    if (!remainingPassword && !remainingEmail) {
      await page.waitForLoadState('networkidle').catch(() => {});
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Forest sign-in did not complete; the login form is still visible');
}

async function syncWithForestApp(page) {
  const syncButton = page.getByText(/^sync with forest app$/i);
  await syncButton.first().waitFor({ state: 'visible', timeout: 15000 });
  await syncButton.first().click();
  console.log('Clicked "Sync with Forest app"');
  await page.waitForTimeout(1500);
}

async function bodyText(page) {
  return page.innerText('body');
}

async function currentDayKey(page) {
  const text = await bodyText(page);
  const m = text.match(/([A-Z][a-z]+) (\d{1,2})(?:st|nd|rd|th) \(\w{3}\) Forest/);
  return m ? monthDayToKey(m[1], Number(m[2])) : null;
}

async function navLinks(page) {
  const mid = (page.viewportSize()?.width ?? 1280) / 2;
  const links = {};
  for (const el of await page.locator(NAV_SEL).all()) {
    const box = await el.boundingBox();
    if (!box) continue;
    if (box.x + box.width / 2 < mid) links.prev = el; else links.next = el;
  }
  return links;
}

// Click prev/next until the page shows `target`. Returns the day we ended on.
async function goToDay(page, target) {
  for (let i = 0; i < 800; i++) {
    const cur = await currentDayKey(page);
    if (!cur) throw new Error('Could not read the current day heading from the page');
    if (cur === target) return cur;
    const links = await navLinks(page);
    const link = keyToUTC(cur) < keyToUTC(target) ? links.next : links.prev;
    if (!link) return cur; // no further day available in that direction
    const before = await bodyText(page);
    await link.click();
    await page.waitForFunction((old) => document.body.innerText !== old, before, { timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(250);
  }
  throw new Error('Gave up navigating to the target day');
}

// Rows look like "11:51 ~ 12:52" then "61  Study" (minutes + tag).
function parseSessions(text) {
  const re = /(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})[^\n]*\n+\s*(\d+)(?:[ \t]*\n?[ \t]*(?!\d{1,2}:\d{2}\s*~)([^\n]*))?/g;
  const sessions = [];
  for (const m of text.matchAll(re)) {
    let tag = (m[4] || '').trim();
    if (DAY_RE.test(tag)) tag = ''; // picked up the nav footer, not a tag
    sessions.push({ start: m[1], end: m[2], minutes: Number(m[3]), tag: tag || 'Untagged' });
  }
  return sessions;
}

function summarize(sessions) {
  const by_tag = {};
  let minutes = 0;
  for (const s of sessions) {
    minutes += s.minutes;
    by_tag[s.tag] = (by_tag[s.tag] || 0) + s.minutes;
  }
  return { minutes, sessions: sessions.length, by_tag };
}

async function saveDebug(page, name) {
  try {
    await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${name}.txt`), await bodyText(page));
  } catch { /* ignore */ }
}

// ---------- main ----------

await fetchExtension();

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, // extensions need a headed browser; xvfb provides the display
  viewport: { width: 1280, height: 900 },
  locale: 'en-US',
  timezoneId: TZ,
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
});

const page = await ctx.newPage();
try {
  const id = await getExtensionId(ctx);
  await page.goto(`chrome-extension://${id}/${OPTIONS_PATH}`);
  await ensureLoggedIn(page);
  await page.getByText('Planting Record').first().click();
  await page.waitForTimeout(1000);
  await syncWithForestApp(page);

  const today = todayKey();
  const history = fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) : {};

  // Today
  const reached = await goToDay(page, today);
  let todaySummary;
  let note;
  if (reached === today) {
    todaySummary = summarize(parseSessions(await bodyText(page)));
    if (todaySummary.sessions === 0) await saveDebug(page, 'today-empty'); // handy for tuning the parser
  } else {
    todaySummary = { minutes: 0, sessions: 0, by_tag: {} };
    note = `No page for ${today}; extension stopped at ${reached}`;
  }
  history[today] = todaySummary;

  // Optional backfill, walking backwards one day at a time
  for (let i = 1; i <= BACKFILL_DAYS; i++) {
    const key = addDays(today, -i);
    const got = await goToDay(page, key);
    if (got !== key) {
      note = `No page for ${key}; extension stopped at ${got}`;
      console.error(note);
      await saveDebug(page, `backfill-unavailable-${key}`);
      break;
    }

    const summary = summarize(parseSessions(await bodyText(page)));
    history[key] = summary;
    console.log(`Backfill ${key}: ${summary.minutes} min over ${summary.sessions} sessions`);
    if (summary.sessions === 0) await saveDebug(page, `backfill-empty-${key}`);
  }

  const days = Object.keys(history).sort();
  const trackedMinutes = days.reduce((sum, d) => sum + (history[d].minutes || 0), 0);

  const out = {
    updated_at: new Date().toISOString(),
    timezone: TZ,
    date: today,
    today_minutes: todaySummary.minutes,
    today_hours: Math.round((todaySummary.minutes / 60) * 100) / 100,
    today_sessions: todaySummary.sessions,
    today_by_tag: todaySummary.by_tag,
    tracked_total_minutes: trackedMinutes,
    tracked_total_hours: Math.round((trackedMinutes / 60) * 100) / 100,
    tracked_days: days.length,
    ...(note ? { note } : {}),
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(days.map((d) => [d, history[d]])), null, 2) + '\n');
  console.log(`Done: ${today} = ${out.today_minutes} min over ${out.today_sessions} sessions`);
} catch (err) {
  await saveDebug(page, 'failure');
  console.error('Scrape failed:', err.message);
  process.exitCode = 1;
} finally {
  await ctx.close();
}
