/**
 * Personal and school OneDrive project folders.
 * Main folders are visible. Hidden and backend folders use a leading dot.
 * `project.json` `tier` is how the app tells hidden from backend.
 * `id` stays the old kebab id when the Finder name has spaces.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalizeEmail, OWNER_EMAIL as YAN_EMAIL } from "./identity.js";

export const PERSONAL_PROJECTS =
  "/Users/you/Library/CloudStorage/OneDrive-Personal/Projects";
export const SCHOOL_PROJECTS =
  "$HOME/Documents/Projects";

export const PRASHAM_EMAIL = "you@example.com";

export const YAN_BACKEND_DIR = join(PERSONAL_PROJECTS, ".backend");
export const YAN_EDUCATION_DIR = join(PERSONAL_PROJECTS, ".education");
export const PRASHAM_EDUCATION_DIR = join(PERSONAL_PROJECTS, ".prasham-education");
export const FITNESS_DIR = join(PERSONAL_PROJECTS, ".fitness");
export const TESTS_DIR = join(PERSONAL_PROJECTS, ".tests");
export const JYPE_DIR = join(PERSONAL_PROJECTS, "JYPE");
export const BRAIN_DIR = join(YAN_BACKEND_DIR, "brain");
export const USAGE_DIR = join(YAN_BACKEND_DIR, "usage");
export const FUTURE_AGENTS_DIR = join(YAN_BACKEND_DIR, "future-agents");
export const STUDY_DIR = join(YAN_BACKEND_DIR, "study");
export const CHAT_LOG_PATH = join(YAN_BACKEND_DIR, "chat-log.md");
export const LOGIN_LOG_PATH = join(YAN_BACKEND_DIR, "login-log.md");
export const YAN_MD_PATH = join(YAN_BACKEND_DIR, "yan.md");

export const PROJECT_ROOTS = [PERSONAL_PROJECTS, SCHOOL_PROJECTS];

const TIERS = new Set(["main", "hidden", "backend"]);

/** Yan's personal dashboard lists the two Projects directories. JYPE and Alex keep a projects/ folder inside their own root. */
export function usesTopLevelProjects(email, workspace) {
  if (String(workspace || "").trim().toLowerCase() === "jype") return false;
  return canonicalizeEmail(email) === YAN_EMAIL;
}

/**
 * Live data root for an education login.
 * @param {string} email
 * @param {string} [workspace]
 * @returns {string|null}
 */
export function educationDataDir(email, workspace) {
  if (String(workspace || "").trim().toLowerCase() === "jype") return JYPE_DIR;
  const normalized = canonicalizeEmail(email);
  if (normalized === YAN_EMAIL) return YAN_EDUCATION_DIR;
  if (normalized === PRASHAM_EMAIL) return PRASHAM_EDUCATION_DIR;
  return null;
}

export function chatHistoryAbsDir(email, workspace) {
  const root = educationDataDir(email, workspace);
  if (!root) return "";
  return join(root, ".chat-history");
}

/**
 * @param {unknown} raw
 * @param {string} folderName
 */
export function normalizeTier(raw, folderName) {
  const tier = String(raw || "").trim().toLowerCase();
  if (TIERS.has(tier)) return tier;
  return String(folderName || "").startsWith(".") ? "hidden" : "main";
}

/**
 * @param {object|null|undefined} props
 * @param {string} folderName
 */
export function stableProjectId(props, folderName) {
  const fromJson = String(props?.id || "").trim();
  if (
    fromJson &&
    !fromJson.includes("..") &&
    !fromJson.includes("/") &&
    !fromJson.includes("\\")
  ) {
    return fromJson;
  }
  return String(folderName || "").replace(/^\.+/, "");
}

/**
 * One level of both Projects folders. Backend is omitted unless asked.
 * @param {{ includeBackend?: boolean, roots?: string[] }} [opts]
 */
export async function listTopLevelProjects(opts = {}) {
  const includeBackend = opts.includeBackend === true;
  const roots = Array.isArray(opts.roots) && opts.roots.length ? opts.roots : PROJECT_ROOTS;
  /** @type {{ id: string, dir: string, folderName: string, tier: string, props: object, drive: "personal"|"school" }[]} */
  const out = [];
  for (const root of roots) {
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const drive = resolve(root) === resolve(SCHOOL_PROJECTS) ? "school" : "personal";
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderName = String(entry.name || "");
      if (!folderName || folderName === ".Trash" || folderName.startsWith("._")) continue;
      const dir = join(root, folderName);
      /** @type {object|null} */
      let props = null;
      try {
        props = JSON.parse(await readFile(join(dir, "project.json"), "utf8"));
      } catch {
        continue;
      }
      if (!props || typeof props !== "object" || Array.isArray(props)) continue;
      const tier = normalizeTier(props.tier, folderName);
      if (!includeBackend && tier === "backend") continue;
      out.push({
        id: stableProjectId(props, folderName),
        dir,
        folderName,
        tier,
        props,
        drive,
      });
    }
  }
  return out;
}

/**
 * @param {string} id
 * @param {{ roots?: string[] }} [opts]
 */
export async function findTopLevelProject(id, opts = {}) {
  const want = String(id || "").trim().toLowerCase();
  if (!want) return null;
  const rows = await listTopLevelProjects({ includeBackend: true, roots: opts.roots });
  return (
    rows.find((row) => {
      if (row.id.toLowerCase() === want) return true;
      return row.folderName.replace(/^\.+/, "").toLowerCase() === want;
    }) || null
  );
}
