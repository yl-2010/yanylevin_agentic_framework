/**
 * Shared state for JYPE celebration pages (cross-device pledges).
 * Files live under OneDrive Projects/JYPE/celebration-state/.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { jypeGivenName, jypeRootAbs, isJypeMember } from "./jype.js";

/** Hex folder names on yanylevin.com that may use the sync API. */
export const JYPE_CELEBRATION_SITES = Object.freeze([
  "7b807d40061999a51d215110",
]);

const ALLOWED = new Set(JYPE_CELEBRATION_SITES);
const SUBDIR = "celebration-state";

function err(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function statePath(siteId) {
  return join(jypeRootAbs(), SUBDIR, `${siteId}.json`);
}

function normalizeState(raw) {
  const signed = Array.isArray(raw?.signed)
    ? raw.signed.filter((n) => typeof n === "string" && n.trim())
    : [];
  const order = ["Yan", "Alex", "Example Friend", "Example Neighbor"];
  const set = new Set(signed);
  return {
    signed: order.filter((n) => set.has(n)),
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : null,
  };
}

export async function readCelebrationState(siteId) {
  const id = String(siteId || "").trim();
  if (!ALLOWED.has(id)) throw err("unknown celebration site", 404);
  try {
    const raw = JSON.parse(await readFile(statePath(id), "utf8"));
    return normalizeState(raw);
  } catch {
    return { signed: [], updatedAt: null };
  }
}

export async function toggleCelebrationSign(siteId, email) {
  const id = String(siteId || "").trim();
  if (!ALLOWED.has(id)) throw err("unknown celebration site", 404);
  if (!isJypeMember(email)) throw err("forbidden", 403);
  const you = jypeGivenName(email);
  if (!you) throw err("forbidden", 403);

  const state = await readCelebrationState(id);
  const set = new Set(state.signed);
  if (set.has(you)) set.delete(you);
  else set.add(you);

  const next = {
    ...normalizeState({ signed: [...set] }),
    updatedAt: new Date().toISOString(),
  };

  await mkdir(join(jypeRootAbs(), SUBDIR), { recursive: true });
  await writeFile(statePath(id), `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return { ...next, you, signedSelf: set.has(you) };
}
