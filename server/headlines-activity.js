/**
 * In-class headline slips for /headlines.
 * Claims are file-backed on the Mac. Voice never goes to the student payload.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PATH = join(ROOT, "data", "headlines-assignments.json");
/** Friday Sep 11, 2026 1:50pm PDT. */
const DEFAULT_WIPE_AT_MS = Date.parse("2026-09-11T20:50:00.000Z");
const NAME_MAX = 40;

/** @type {string} */
let assignmentsPath = process.env.HEADLINES_ASSIGNMENTS_PATH || DEFAULT_PATH;
/** @type {number|null} */
let wipeAtOverride = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let wipeTimer = null;
let lock = Promise.resolve();

export const HEADLINES = [
  {
    id: 0,
    event: "Chauvin verdict",
    headline: "Derek Chauvin is found guilty of murdering George Floyd",
    date: "April 20, 2021",
    source: "New York Times",
    url: "https://www.nytimes.com/2021/04/20/us/chauvin-guilty-murder-george-floyd.html",
    voice: "Active",
  },
  {
    id: 1,
    event: "Chauvin verdict",
    headline:
      "Ex-Minneapolis police officer found guilty on all charges in George Floyd's death",
    date: "April 20, 2021",
    source: "Fox News",
    url: "https://www.foxnews.com/us/derek-chauvin-trial-verdict-jury-guilty",
    voice: "Passive",
  },
  {
    id: 2,
    event: "Jan. 6",
    headline: "Trump supporters storm U.S. Capitol, shots, tear gas fired",
    date: "January 6, 2021",
    source: "Washington Post",
    url: "https://www.washingtonpost.com/local/trump-supporters-storm-capitol-dc/2021/01/06/58afc0b8-504b-11eb-83e3-322644d82356_story.html",
    voice: "Active",
  },
  {
    id: 3,
    event: "Jan. 6",
    headline:
      "Nancy Pelosi's office stormed during Capitol chaos, Senate chamber also breached",
    date: "January 6, 2021",
    source: "Fox News",
    url: "https://www.foxnews.com/politics/nancy-pelosis-office-stormed-during-capitol-chaos-senate-chamber-also-breached",
    voice: "Passive",
  },
  {
    id: 4,
    event: "Sept. 11",
    headline:
      "U.S. Attacked; Hijacked Jets Destroy Twin Towers and Hit Pentagon in Day of Terror",
    date: "September 12, 2001",
    source: "New York Times",
    url: "https://www.nytimes.com/2001/09/12/us/us-attacked-hijacked-jets-destroy-twin-towers-and-hit-pentagon-in-day-of-terror.html",
    voice: "Passive",
  },
  {
    id: 5,
    event: "Sept. 11",
    headline:
      "Terrorists Hijack 4 Airliners, Destroy World Trade Center, Hit Pentagon",
    date: "September 12, 2001",
    source: "Washington Post",
    url: "https://www.washingtonpost.com/archive/politics/2001/09/12/terrorists-hijack-4-airliners-destroy-world-trade-center-hit-pentagon/38f92398-c747-456d-a86e-d4768548aa7c/",
    voice: "Active",
  },
  {
    id: 6,
    event: "Oct. 7",
    headline: "An Attack From Gaza and an Israeli Declaration of War. Now What?",
    date: "October 7, 2023",
    source: "New York Times",
    url: "https://www.nytimes.com/2023/10/07/world/middleeast/israel-gaza-war-hamas-palestinians.html",
    voice: "Passive",
  },
  {
    id: 7,
    event: "Oct. 7",
    headline: "At least 100 dead as Hamas launches unprecedented attack on Israel",
    date: "October 7, 2023",
    source: "Fox News",
    url: "https://www.foxnews.com/world/rocket-barrages-strike-southern-israel-operation-claimed-hamas",
    voice: "Active",
  },
  {
    id: 8,
    event: "Italy ChatGPT ban",
    headline: "Italy temporarily bans ChatGPT over privacy concerns",
    date: "March 31, 2023",
    source: "Washington Post",
    url: "https://www.washingtonpost.com/world/2023/03/31/italy-ban-chatgpt-artificial-intelligence-privacy/",
    voice: "Active",
  },
  {
    id: 9,
    event: "Italy ChatGPT ban",
    headline: "ChatGPT Is Banned in Italy Over Privacy Concerns",
    date: "March 31, 2023",
    source: "New York Times",
    url: "https://www.nytimes.com/2023/03/31/technology/chatgpt-italy-ban.html",
    voice: "Passive",
  },
  {
    id: 10,
    event: "COVID pandemic",
    headline: "WHO declares novel coronavirus outbreak a pandemic",
    date: "March 11, 2020",
    source: "CNN",
    url: "https://www.cnn.com/2020/03/11/health/coronavirus-pandemic-world-health-organization",
    voice: "Active",
  },
  {
    id: 11,
    event: "COVID pandemic",
    headline: "Coronavirus Has Become a Pandemic, W.H.O. Says",
    date: "March 11, 2020",
    source: "New York Times",
    url: "https://www.nytimes.com/2020/03/11/health/coronavirus-pandemic-who.html",
    voice: "Passive",
  },
  {
    id: 12,
    event: "Silicon Valley Bank",
    headline: "Silicon Valley Bank collapses after failing to raise capital",
    date: "March 10, 2023",
    source: "CNN",
    url: "https://www.cnn.com/2023/03/10/investing/svb-bank",
    voice: "Active",
  },
  {
    id: 13,
    event: "Silicon Valley Bank",
    headline: "Silicon Valley Bank shut down by regulators",
    date: "March 10, 2023",
    source: "Fox Business",
    url: "https://www.foxbusiness.com/markets/silicon-valley-bank-shut-down-regulators-fdic",
    voice: "Passive",
  },
  {
    id: 14,
    event: "CrowdStrike outage",
    headline:
      "CrowdStrike issue causes major outage affecting businesses around the world",
    date: "July 19, 2024",
    source: "CNBC",
    url: "https://www.cnbc.com/2024/07/19/crowdstrike-suffers-major-outage-affecting-businesses-around-the-world.html",
    voice: "Active",
  },
  {
    id: 15,
    event: "CrowdStrike outage",
    headline: "Microsoft users hit with 'blue screen of death' after massive outage",
    date: "July 19, 2024",
    source: "CNBC",
    url: "https://www.cnbc.com/2024/07/19/microsoft-says-it-restored-cloud-services-after-they-suffered-outage.html",
    voice: "Passive",
  },
  {
    id: 16,
    event: "Bin Laden",
    headline: "Bin Laden Is Dead, Obama Says",
    date: "May 2, 2011",
    source: "New York Times",
    url: "https://www.nytimes.com/2011/05/02/world/asia/osama-bin-laden-is-killed.html",
    voice: "Passive",
  },
  {
    id: 17,
    event: "Bin Laden",
    headline:
      "Bin Laden Killed by CIA-Led SEALs Team, Death Hailed as Blow to Al Qaeda",
    date: "May 1, 2011",
    source: "Fox News",
    url: "https://www.foxnews.com/us/bin-laden-killed-by-cia-led-seals-team-death-hailed-as-blow-to-al-qaeda",
    voice: "Passive",
  },
  {
    id: 18,
    event: "Haiti earthquake",
    headline: "Fierce Quake Devastates Haitian Capital",
    date: "January 13, 2010",
    source: "New York Times",
    url: "https://www.nytimes.com/2010/01/13/world/americas/13haiti.html",
    voice: "Active",
  },
  {
    id: 19,
    event: "Haiti earthquake",
    headline: "Haiti Lies in Ruins; Grim Search for Untold Dead",
    date: "January 14, 2010",
    source: "New York Times",
    url: "https://www.nytimes.com/2010/01/14/world/americas/14haiti.html",
    voice: "Passive",
  },
];

export function configureHeadlinesActivity(opts = {}) {
  if (opts.assignmentsPath) assignmentsPath = opts.assignmentsPath;
  if (Object.prototype.hasOwnProperty.call(opts, "wipeAtMs")) {
    wipeAtOverride = opts.wipeAtMs;
  }
}

export function wipeAtMs() {
  if (wipeAtOverride != null) return wipeAtOverride;
  const fromEnv = process.env.HEADLINES_WIPE_AT;
  if (fromEnv) {
    const parsed = Date.parse(fromEnv);
    if (Number.isFinite(parsed)) return parsed;
  }
  return DEFAULT_WIPE_AT_MS;
}

export function normalizeName(raw) {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  return name;
}

function nameKey(name) {
  return name.toLowerCase();
}

function studentPayload(item, name) {
  return {
    name,
    headline: item.headline,
    date: item.date,
    source: item.source,
    url: item.url,
  };
}

function dashboardRow(item, assignment) {
  return {
    name: assignment.name,
    headline: item.headline,
    date: item.date,
    source: item.source,
    url: item.url,
    event: item.event,
    voice: item.voice,
    claimedAt: assignment.claimedAt,
  };
}

function emptyState() {
  return { wipedAt: null, assignments: [] };
}

async function readState() {
  try {
    const raw = await readFile(assignmentsPath, "utf8");
    const parsed = JSON.parse(raw);
    const assignments = Array.isArray(parsed?.assignments)
      ? parsed.assignments.filter(
          (row) =>
            row &&
            Number.isInteger(row.headlineId) &&
            row.headlineId >= 0 &&
            row.headlineId < HEADLINES.length &&
            typeof row.name === "string"
        )
      : [];
    return {
      wipedAt: typeof parsed?.wipedAt === "string" ? parsed.wipedAt : null,
      assignments,
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return emptyState();
    throw err;
  }
}

async function writeState(state) {
  await mkdir(dirname(assignmentsPath), { recursive: true });
  await writeFile(
    assignmentsPath,
    `${JSON.stringify(
      {
        wipedAt: state.wipedAt,
        assignments: state.assignments,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function applyWipe(state, now) {
  const at = wipeAtMs();
  if (now >= at && !state.wipedAt) {
    state.assignments = [];
    state.wipedAt = new Date(now).toISOString();
    return true;
  }
  return false;
}

function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function mutate(now, fn) {
  const state = await readState();
  const wiped = applyWipe(state, now);
  try {
    const result = fn(state);
    if (wiped || result?.dirty) await writeState(state);
    return result?.value;
  } catch (err) {
    if (wiped) await writeState(state);
    throw err;
  }
}

export async function claimHeadline(rawName, now = Date.now()) {
  const name = normalizeName(rawName);
  if (!name) {
    const err = new Error("name required");
    err.status = 400;
    throw err;
  }
  if (name.length > NAME_MAX) {
    const err = new Error("name too long");
    err.status = 400;
    throw err;
  }
  const key = nameKey(name);
  return withLock(async () =>
    mutate(now, (state) => {
      const existing = state.assignments.find(
        (row) => nameKey(row.name) === key
      );
      if (existing) {
        return {
          dirty: false,
          value: studentPayload(HEADLINES[existing.headlineId], existing.name),
        };
      }
      const used = new Set(state.assignments.map((row) => row.headlineId));
      const nextId = HEADLINES.find((item) => !used.has(item.id))?.id;
      if (nextId == null) {
        const err = new Error("all headlines taken");
        err.status = 409;
        throw err;
      }
      const assignment = {
        name,
        headlineId: nextId,
        claimedAt: new Date(now).toISOString(),
      };
      state.assignments.push(assignment);
      return {
        dirty: true,
        value: studentPayload(HEADLINES[nextId], name),
      };
    })
  );
}

export async function getHeadlineAssignment(rawName, now = Date.now()) {
  const name = normalizeName(rawName);
  if (!name) return null;
  const key = nameKey(name);
  return withLock(async () =>
    mutate(now, (state) => {
      const existing = state.assignments.find(
        (row) => nameKey(row.name) === key
      );
      if (!existing) return { dirty: false, value: null };
      return {
        dirty: false,
        value: studentPayload(HEADLINES[existing.headlineId], existing.name),
      };
    })
  );
}

export async function listHeadlineAssignments(now = Date.now()) {
  return withLock(async () =>
    mutate(now, (state) => ({
      dirty: false,
      value: state.assignments.map((row) =>
        dashboardRow(HEADLINES[row.headlineId], row)
      ),
    }))
  );
}

export async function wipeHeadlinesIfDue(now = Date.now()) {
  return withLock(async () =>
    mutate(now, () => ({ dirty: false, value: true }))
  );
}

export function startHeadlinesWipeScheduler() {
  if (wipeTimer) {
    clearTimeout(wipeTimer);
    wipeTimer = null;
  }
  const delay = wipeAtMs() - Date.now();
  const run = () => {
    wipeHeadlinesIfDue().catch((err) => {
      console.error("[headlines] wipe failed", err);
    });
  };
  if (delay <= 0) {
    run();
    return;
  }
  wipeTimer = setTimeout(run, delay);
}
