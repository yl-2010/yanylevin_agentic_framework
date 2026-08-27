// M2 fill runner: Composer 2.5 (not fast) batches that turn scaffolded person
// folders into finished cards (summary, structured fields, typed edges, typed
// context files), reading only the legacy card and the brain. Sequential
// batches so entity creation (groups/orgs/places) cannot race itself.
// Fable gates the result afterward with brain-graph --check plus the
// value-level zero-loss check before anything ships as done.
//
//   node --env-file=.env server/brain-migrate-fill.js [--start N] [--batch-size N] [--only a,b,c]

import fs from "node:fs";
import path from "node:path";
import { BRAIN_ROOT, REPO_ROOT } from "./brain-lib.js";
import {
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
} from "./cursor-sdk-auth.js";

const MODEL = { id: "composer-2.5", params: [{ id: "fast", value: "false" }] };
const BRAIN_REL = path.relative(REPO_ROOT, BRAIN_ROOT);

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

function listSlugs() {
  const only = arg("--only", "");
  if (only) return only.split(",").map((s) => s.trim()).filter(Boolean);
  return fs
    .readdirSync(path.join(BRAIN_ROOT, "people"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function buildPrompt({ slugs, batch, batchCount }) {
  return [
    `You are batch ${batch}/${batchCount} of a one-time brain migration for Yan (you@example.com).`,
    "Local only. Never spawn a Cursor cloud agent. ",
    "Do not run git. Do not run scripts. Do not edit generated files",
    `(${BRAIN_REL}/people/index.md, ${BRAIN_REL}/people/graph.md, ${BRAIN_REL}/education/**).`,
    "",
    `Read ${BRAIN_REL}/schema.md FIRST and follow its contract exactly, including the`,
    "frontmatter parsing rules (scalars bare, arrays/objects as one-line JSON, edges as a",
    "block list of one-line JSON objects) and the fixed edge enum.",
    "",
    `Paths (all under ${BRAIN_REL}/):`,
    "- NEW: people/<slug>/ (person.md required; relationship.md, beliefs.md, threads.md, schedule.md, notes.md optional)",
    "- LEGACY source of truth: people-legacy/<slug>.md, or people-legacy/<slug>/ (person.md, log.md)",
    "- Other entities: groups/<slug>.md, orgs/<slug>.md, places/<slug>.md (same schema contract)",
    "",
    `Your people for this batch: ${slugs.join(", ")}`,
    "",
    "For each person, in order:",
    "1. Read the legacy card(s) AND every file already in the new folder.",
    '2. In person.md, replace the "> TODO(m2)" line with a 1-3 sentence executive summary:',
    "   who they are and why they matter to Yan. Fill frontmatter fields when the card states",
    '   them: school ({"role": "student", "classOf": 2028} style), groups (["jype"]), birthday.',
    "   Only facts already in the card or elsewhere in the brain. Never invent. No web, no dumps.",
    "3. Add typed edges for relationships STATED in the card, enum only. person->person targets",
    "   must be existing slugs under people/ (verify before adding). For a group/org/place target,",
    "   check that directory (names AND aliases) for an existing entity first; create the file per",
    "   schema only if missing, minimal: frontmatter + one-line summary. No edges for vague mentions.",
    "4. Split prose into typed files per schema: how-we-know + Yan's assessment -> relationship.md;",
    "   beliefs, motivations, communication style, hobby horses -> beliefs.md; unresolved items",
    "   between Yan and them -> threads.md; recurring calendar (school blocks, sports cadence)",
    "   -> schedule.md (never a single date); remaining typed misc -> notes.md. Standing in person.md",
    "   keeps the current-standing facts. NEVER drop a fact: every fact in the legacy card must",
    "   remain readable somewhere in the new person folder. Rewording is fine; dropping is not.",
    "5. Timeline entries below <!-- timeline --> are immutable. Do not edit, delete, or reorder.",
    '6. If notes.md has an "Unsorted (migration)" section, sort those lines into the right files.',
    "   Delete notes.md if it ends up empty. Never create empty files or placeholder sections.",
    "7. Touch nothing outside this batch's person folders, except creating a missing group/org/place",
    "   entity file from step 3.",
    "",
    "Quality bar: person.md reads as a briefing. Keep uncertainty labels (unconfirmed, inferred,",
    "as of DATE). Prefer Yan's original wording for judgment calls.",
    "",
    "Reply with one line per person: slug, what changed, and any fact you could not place.",
  ].join("\n");
}

async function main() {
  await reloadCursorApiKeyFromEnv();
  const batchSize = Number(arg("--batch-size", "12"));
  const start = Number(arg("--start", "1"));
  const slugs = listSlugs();
  const batches = [];
  for (let i = 0; i < slugs.length; i += batchSize) batches.push(slugs.slice(i, i + batchSize));

  console.log(`[brain-fill] ${slugs.length} people, ${batches.length} batches of ${batchSize}, starting at batch ${start}`);

  for (let i = start - 1; i < batches.length; i++) {
    const prompt = buildPrompt({ slugs: batches[i], batch: i + 1, batchCount: batches.length });
    const t0 = Date.now();
    const { result, transientFailed, usedFallback } = await promptWithAuthRetry({
      prefix: "brain-fill",
      prompt,
      model: MODEL,
      cwd: REPO_ROOT,
    });
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    if (usedFallback) console.warn(`[brain-fill] batch ${i + 1} used auto fallback`);
    if (transientFailed) {
      console.error(`[brain-fill] batch ${i + 1}/${batches.length} FAILED after ${mins}m; resume with --start ${i + 1}`);
      process.exit(1);
    }
    console.log(`[brain-fill] batch ${i + 1}/${batches.length} status=${result?.status || "finished"} in ${mins}m`);
    const reply = result?.text || result?.output || "";
    if (reply) console.log(String(reply).trim().split("\n").map((l) => `  ${l}`).join("\n"));
  }
  console.log("[brain-fill] all batches done");
}

main().catch((err) => {
  console.error("[brain-fill] fatal:", err);
  process.exit(1);
});
