/**
 * Tags billing rows from Cursor agent transcripts on this Mac.
 * The transcript folder name is the billing conversation id.
 * A row with no local transcript stays Other.
 */

import { open, readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { personFromEmail, USAGE_DIR, USAGE_ROWS_PATH } from "./usage-log.js";

const PROJECTS = join(homedir(), ".cursor", "projects");
const INDEX_PATH = join(USAGE_DIR, "local-index.json");
const PROMPT_MAX = 6000;
const READ_MAX = 80_000;
const TAG_VERSION = 4;

const AGENT_RULES = [
  [/life-state skill/i, "life-state"],
  [/short chat list title/i, "chat-title"],
  [/JYPE agent/i, "jype-agent"],
  [/Personal Agent for yanylevin/i, "personal-agent"],
  [/brain extraction/i, "brain-extract"],
  [/calendar-on-demand/i, "calendar-on-demand"],
  [/personal-canvas/i, "canvas-hourly"],
  [/location-history skill/i, "location-compose"],
  [/health-takeaways skill/i, "health-takeaways"],
  [/home-agent skill/i, "home-agent"],
  [/Daily Briefing/i, "daily-briefing"],
  [/agent-recap skill/i, "agent-recap"],
  [/daily-news skill/i, "daily-briefing"],
  [/chat-title-refresh/i, "chat-title-refresh"],
  [/nightly-fact-check|fact-check skill/i, "fact-check"],
  [/health-brain skill/i, "health-brain"],
  [/location-brain skill/i, "location-brain"],
  [/nightly-lint skill/i, "nightly-lint"],
  [/nightly-actions skill/i, "nightly-actions"],
  [/context-synthesis skill/i, "context-synthesis"],
  [/location-enrichment skill/i, "location-enrichment"],
  [/life-state-cleanup/i, "life-state-cleanup"],
  [/glossary-seed/i, "glossary-seed"],
  [/fitness-agent/i, "fitness-agent"],
  [/health-history/i, "health-history"],
];

/** @type {Promise<Map<string, object>|null>} */
let refreshing = null;
let refreshedAt = 0;

/**
 * @param {string} text
 * @param {string} repo
 * @param {string} [fallbackPerson]
 */
export function classifyLocalPrompt(text, repo, fallbackPerson = "Yan") {
  const raw = String(text || "");
  let kind = "cursor-desktop";
  let agent = false;
  for (const [pattern, name] of AGENT_RULES) {
    if (pattern.test(raw)) {
      kind = name;
      agent = true;
      break;
    }
  }
  const from = raw.match(/\bFrom (Yan|Alex|Example Friend|Example Neighbor)\b/);
  let person = from ? from[1] : "";
  if (!person) {
    const signed = raw.match(/Signed-in user(?: email)?:\s*([^\s(]+)/);
    if (signed) {
      const email = signed[1].replace(/[),]+$/g, "");
      if (email.includes("@")) person = personFromEmail(email);
    }
  }
  if (!person || person === "Other") person = fallbackPerson || "Yan";
  if (kind === "canvas-hourly" || kind === "canvas-nightly") person = "Yan";
  if (kind === "personal-agent") {
    if (/\bon Teams:/i.test(raw)) kind = "teams-agent";
    else if (/\bon iMessage:/i.test(raw)) kind = "imessage-agent";
    else if (/\bon WhatsApp:/i.test(raw)) kind = "whatsapp-agent";
  }
  return {
    person,
    repo: agent ? "yanylevin-agents" : repo || "Other",
    kind,
    prompt: clipPrompt(displayPrompt(raw)),
  };
}

/**
 * @param {string} text
 */
function displayPrompt(text) {
  const unwrapped = String(text || "")
    .replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, "")
    .replace(/<\/?user_query>/g, "")
    .trim();
  if (/short chat list title/i.test(unwrapped)) {
    const msg = unwrapped.match(/\nMessage:\n([\s\S]*)$/);
    if (msg) return msg[1].trim();
  }
  return unwrapped;
}

/**
 * @param {string} text
 */
function clipPrompt(text) {
  const clean = String(text || "").replace(/\s+\n/g, "\n").trim();
  if (clean.length <= PROMPT_MAX) return clean;
  return clean.slice(0, PROMPT_MAX);
}

/**
 * Cursor project folders are the workspace path with slashes turned into dashes.
 * @param {string} folderName
 * @param {string} [home]
 * @param {(path: string) => boolean} [exists]
 */
export function projectRepo(folderName, home = homedir(), exists = existsSync) {
  const name = String(folderName || "");
  if (!name || name === "empty-window" || /^\d+$/.test(name) || /^var-folders-/i.test(name)) return "temp";
  const prefix = `Users-${basename(home)}-`;
  if (!name.startsWith(prefix) && name !== `Users-${basename(home)}`) return "Other";
  let rest = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  rest = rest.replace(/-[0-9a-f]{16,}$/i, "");
  if (!rest) return "temp";
  const parts = rest.split("-");
  let current = home;
  let i = 0;
  while (i < parts.length) {
    let found = -1;
    for (let j = parts.length; j > i; j--) {
      const candidate = join(current, parts.slice(i, j).join("-"));
      if (exists(candidate)) {
        found = j;
        break;
      }
    }
    if (found < 0) break;
    current = join(current, parts.slice(i, found).join("-"));
    i = found;
  }
  if (current === home) return "Other";
  let dir = current;
  while (dir.startsWith(home)) {
    if (exists(join(dir, ".git"))) return basename(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return basename(current);
}

/**
 * @param {string} path
 */
async function readHead(path) {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(READ_MAX);
    const { bytesRead } = await fh.read(buf, 0, READ_MAX, 0);
    const chunk = buf.slice(0, bytesRead).toString("utf8");
    const line = chunk.includes("\n") ? chunk.slice(0, chunk.indexOf("\n")) : chunk;
    try {
      const obj = JSON.parse(line);
      const content = obj?.message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const part = content.find((item) => item && item.type === "text" && item.text);
        if (part) return String(part.text);
      }
    } catch {
      const match = chunk.match(/"text":"((?:\\.|[^"\\])*)/);
      if (match) {
        try {
          return JSON.parse(`"${match[1]}"`);
        } catch {
          return match[1];
        }
      }
    }
    return "";
  } finally {
    await fh.close();
  }
}

async function conversationIds() {
  /** @type {Set<string>} */
  const ids = new Set();
  let text = "";
  try {
    text = await readFile(USAGE_ROWS_PATH, "utf8");
  } catch {
    return ids;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row?.source === "billing" && row.conversationId) ids.add(String(row.conversationId));
    } catch {
      /* torn line */
    }
  }
  return ids;
}

async function readIndexFile() {
  try {
    const raw = JSON.parse(await readFile(INDEX_PATH, "utf8"));
    return raw && typeof raw.rows === "object" && raw.rows ? raw.rows : {};
  } catch {
    return {};
  }
}

export async function readLocalIndex() {
  const rows = await readIndexFile();
  return new Map(Object.entries(rows));
}

export async function refreshLocalIndex() {
  const wanted = await conversationIds();
  const prev = await readIndexFile();
  /** @type {Record<string, object>} */
  const next = { ...prev };
  let projects = [];
  try {
    projects = await readdir(PROJECTS);
  } catch {
    return new Map(Object.entries(next));
  }
  for (const project of projects) {
    let names = [];
    try {
      names = await readdir(join(PROJECTS, project, "agent-transcripts"));
    } catch {
      continue;
    }
    let repo = "";
    for (const id of names) {
      if (!wanted.has(id)) continue;
      const file = join(PROJECTS, project, "agent-transcripts", id, `${id}.jsonl`);
      let info;
      try {
        info = await stat(file);
      } catch {
        continue;
      }
      const prior = prev[id];
      if (prior && prior.mtimeMs === info.mtimeMs && prior.v === TAG_VERSION && prior.prompt != null) {
        next[id] = prior;
        continue;
      }
      let head = "";
      try {
        head = await readHead(file);
      } catch {
        continue;
      }
      if (!repo) repo = projectRepo(project);
      const tagged = classifyLocalPrompt(head, repo, "Yan");
      next[id] = { ...tagged, mtimeMs: info.mtimeMs, project, v: TAG_VERSION };
    }
  }
  await mkdir(USAGE_DIR, { recursive: true });
  await writeFile(INDEX_PATH, JSON.stringify({ rows: next }));
  return new Map(Object.entries(next));
}

export async function localIndexForReport() {
  if (Date.now() - refreshedAt > 120_000) {
    if (!refreshing) {
      refreshing = refreshLocalIndex()
        .catch((err) => {
          console.error("[usage-local]", err instanceof Error ? err.message : err);
          return readLocalIndex();
        })
        .finally(() => {
          refreshing = null;
          refreshedAt = Date.now();
        });
    }
    return refreshing;
  }
  return readLocalIndex();
}
