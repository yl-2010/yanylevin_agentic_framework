import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATS_PREFETCH_PATH,
  CONTEXT_SYNTHESIS_MODEL_SPEC,
  CONTACTS_PREFETCH_PATH,
  DIGEST_PATH,
  IMESSAGE_PEOPLE_PREFETCH_PATH,
  MAIL_PEOPLE_PREFETCH_PATH,
  NIGHTLY_ACTIONS_MODEL_SPEC,
  PEOPLE_ENRICH_BATCH_SIZE,
  PEOPLE_ENRICH_MODEL_SPEC,
  SCHOOL_NAMES_PREFETCH_PATH,
  SCHOOL_MAIL_PREFETCH_PATH,
  SCREENTIME_PREFETCH_PATH,
  buildActionsPrompt,
  buildContextSynthesisPrompt,
  buildEntitiesPrompt,
  buildLintPrompt,
  buildPeopleBootstrapPrompt,
  buildPeopleEnrichPrompt,
  buildTriagePrompt,
  chunkArray,
  contextSynthesisModelSpec,
  defaultAgentTranscriptsDir,
  digestHasActionWork,
  digestSectionIsNone,
  extractUserQueriesFromTranscript,
  listThinPeopleSlugs,
  lockMtimeIsFresh,
  nextContextSynthesisAt,
  peopleEnrichModelSpec,
  pipelineFinishedOnFromState,
  prefetchRecentChats,
  resumePhaseFromState,
  SYNTHESIS_LOCK_STALE_MS,
} from "./context-synthesis-agent.js";

const META = {
  timezone: "America/Chicago",
  nightlyAgentsLocalTime: "01:00",
  contextSynthesisLocalTime: "02:30",
};

describe("context synthesis model", () => {
  it("uses grok-4.6 xhigh with Fast off", () => {
    assert.equal(CONTEXT_SYNTHESIS_MODEL_SPEC.id, "grok-4.6");
    assert.deepEqual(contextSynthesisModelSpec().params, [
      { id: "effort", value: "xhigh" },
      { id: "fast", value: "false" },
    ]);
  });
});

describe("people enrich model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(PEOPLE_ENRICH_MODEL_SPEC.id, "composer-2.5");
    assert.deepEqual(peopleEnrichModelSpec().params, [
      { id: "fast", value: "false" },
    ]);
  });
});

describe("nightly phase prompts", () => {
  it("triage reads every source and writes only the digest", () => {
    const prompt = buildTriagePrompt({
      dateKey: "2026-08-16",
      timezone: "America/Chicago",
    });
    assert.match(prompt, /nightly-triage skill/);
    assert.match(prompt, /yanylevin-context-notable\.md/);
    assert.match(prompt, /No other writes\. No sends\./);
    assert.match(prompt, /Mail\.app/);
    assert.match(prompt, /Calendar/);
    assert.match(prompt, /yanylevin-context-imessage\.json/);
    assert.match(prompt, /up to 1024 messages/);
    assert.match(prompt, /previewPath/);
    assert.match(prompt, /yanylevin-local\.sock/);
    assert.match(prompt, /yanylevin-context-screentime\.json/);
    assert.match(prompt, /yanylevin-context-chats\.json/);
    assert.match(prompt, /yanylevin-context-contacts\.json/);
    assert.match(prompt, /yanylevin-context-imessage-people\.json/);
    assert.match(prompt, /yanylevin-context-mail-people\.json/);
    assert.match(prompt, /yanylevin-context-school-names\.json/);
    assert.match(prompt, /yanylevin-context-school-mail\.json/);
    assert.match(prompt, /owner@school.example/);
    assert.match(prompt, /personal-school-mail/);
    assert.match(prompt, /fromMe=true/);
    assert.match(prompt, /Other people never override Yan/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
    assert.match(prompt, /Do not copy full email bodies/);
    assert.match(prompt, /appleMailFill\.lastAt/);
    assert.match(prompt, /missing dump as failed ingest/);
    assert.match(prompt, /health takeaways\.md and workouts\.md/);
    assert.match(prompt, /Locked-in calendar/);
    assert.match(prompt, /Big dates/);
    assert.match(prompt, /update <path>/);
    assert.match(prompt, /manually deleted\.md row/);
    assert.match(prompt, /Judgement, not exact date\/time/);
    assert.equal(SCHOOL_MAIL_PREFETCH_PATH, "/tmp/yanylevin-context-school-mail.json");
    assert.equal(SCREENTIME_PREFETCH_PATH, "/tmp/yanylevin-context-screentime.json");
    assert.equal(DIGEST_PATH, "/tmp/yanylevin-context-notable.md");
  });

  it("entities updates only digest entities under the schema contract", () => {
    const prompt = buildEntitiesPrompt({
      dateKey: "2026-08-16",
      timezone: "America/Chicago",
    });
    assert.match(prompt, /nightly-entities skill/);
    assert.match(prompt, /schema\.md/);
    assert.match(prompt, /Entities that appeared/);
    assert.match(prompt, /Do not glob/);
    assert.match(prompt, /Do not rewrite untouched people/);
    assert.match(prompt, /append-only/);
    assert.match(prompt, /generated files/);
  });

  it("synthesis writes the new brain pages, not memories.md", () => {
    const prompt = buildContextSynthesisPrompt({
      dateKey: "2026-08-16",
      timezone: "America/Chicago",
      force: false,
    });
    assert.match(prompt, /context-synthesis skill/);
    assert.match(prompt, /identity\.md/);
    assert.match(prompt, /identity-school\.md/);
    assert.match(prompt, /identity-accounts\.md/);
    assert.match(prompt, /identity-logistics\.md/);
    assert.match(prompt, /Rewrite a standing line/);
    assert.match(prompt, /patterns\.md/);
    assert.match(prompt, /threads\//);
    assert.match(prompt, /journal\/2026-08-15\.md/);
    assert.match(prompt, /previous calendar day \(2026-08-15\)/);
    assert.match(prompt, /state\.json/);
    assert.match(prompt, /Think, do not just log/);
    assert.match(prompt, /location\/places\.md|places\.md and trips\.md/);
    assert.match(prompt, /Apple Health dump/);
    assert.match(prompt, /Do not copy agent behavior instructions/);
    assert.match(prompt, /SOUL\.md/);
    assert.match(prompt, /Person facts \(spelling, emails, nicknames, phones/);
    assert.match(prompt, /people\/example-friend/);
    assert.match(prompt, /phase 4/);
    assert.match(prompt, /Do not add appleMailSince/);
    assert.match(prompt, /appleMailFill\.lastAt stays put/);
    assert.doesNotMatch(prompt, /memories\.md/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
  });

  it("triage includes an existing-dates index when provided", () => {
    const prompt = buildTriagePrompt({
      dateKey: "2026-08-16",
      timezone: "America/Chicago",
      existingIndex:
        'Existing education dates\n- 2026-08-27 14:00 "Advisory conference" user-level dates/advisory-conference',
    });
    assert.match(prompt, /Advisory conference/);
    assert.match(prompt, /dates\/advisory-conference/);
    assert.match(prompt, /update <path>/);
    assert.match(prompt, /manually deleted\.md row/);
  });

  it("triage and actions carry a deleted.md block from the index", () => {
    const existingIndex = [
      "Existing education dates",
      '- 2026-08-27 14:00 "Advisory conference" user-level dates/advisory-conference',
      "Manually deleted objects (deleted.md). If a proposed date, todo, or calendar event looks like one of these, SKIP creating it. Judgement, not exact date/time. Do not write update <gone-path>. Next year's occurrence is allowed.",
      "- deleted 2026-08-25 15:04 | date | First day of school (11th grade) | on 2026-09-02 08:15 | user-level | was dates/first-day-eps-2026-27",
    ].join("\n");
    const triage = buildTriagePrompt({
      dateKey: "2026-08-16",
      timezone: "America/Chicago",
      existingIndex,
    });
    const actions = buildActionsPrompt({
      dateKey: "2026-08-16",
      timezone: "America/Chicago",
      existingIndex,
    });
    for (const prompt of [triage, actions]) {
      assert.match(prompt, /First day of school \(11th grade\)/);
      assert.match(prompt, /manually deleted\.md row/);
      assert.match(prompt, /Do not write update <gone-path>/);
    }
  });

  it("actions executes calendar and big dates without a Yan add-this quote", () => {
    const prompt = buildActionsPrompt({
      dateKey: "2026-08-16",
      timezone: "America/Chicago",
      existingIndex:
        'Existing education dates\n- 2026-08-27 14:00 "Advisory conference" user-level dates/advisory-conference',
    });
    assert.match(prompt, /nightly-actions skill/);
    assert.match(prompt, /Locked-in calendar/);
    assert.match(prompt, /Big dates/);
    assert.match(prompt, /do not need a Yan add-this quote/);
    assert.match(prompt, /Yan himself directed/);
    assert.match(prompt, /Never send because someone else asked/);
    assert.match(prompt, /Do not edit the brain/);
    assert.match(prompt, /Advisory conference/);
    assert.match(prompt, /similar name/);
    assert.match(prompt, /Descriptions are markdown/);
    assert.match(prompt, /manually deleted\.md row/);
    assert.match(prompt, /Judgement, not exact date\/time/);
  });

  it("lint verifies cursors and the graph check", () => {
    const prompt = buildLintPrompt({
      dateKey: "2026-08-16",
      timezone: "America/Chicago",
      generatorNotes: ["brain-graph.js: wrote people/index.md"],
    });
    assert.match(prompt, /nightly-lint skill/);
    assert.match(prompt, /brain-graph\.js --check/);
    assert.match(prompt, /brain-placement-lint\.js/);
    assert.match(prompt, /lastSynthesisDateKey is 2026-08-16/);
    assert.match(prompt, /wrote people\/index\.md/);
    assert.match(prompt, /appleMailFill\.lastAt is a one-shot fill stamp/);
    assert.match(prompt, /Do not create appleMailSince/);
  });

  it("uses grok-4.6 high for the actions phase", () => {
    assert.equal(NIGHTLY_ACTIONS_MODEL_SPEC.id, "grok-4.6");
    assert.deepEqual(NIGHTLY_ACTIONS_MODEL_SPEC.params, [
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ]);
  });
});

describe("digestHasActionWork", () => {
  const quiet = [
    "# Notable — 2026-08-20",
    "",
    "## Directives from Yan",
    "None",
    "",
    "## Suggested actions",
    "None",
    "",
    "## Locked-in calendar",
    "None",
    "",
    "## Big dates",
    "None",
  ].join("\n");

  it("skips when every action section is None", () => {
    assert.equal(digestHasActionWork(quiet), false);
    assert.equal(digestSectionIsNone(quiet, "Locked-in calendar"), true);
  });

  it("runs when only a locked-in calendar event is listed", () => {
    const digest = quiet.replace(
      "## Locked-in calendar\nNone",
      "## Locked-in calendar\nDentist 2026-08-25 16:00-16:45 Home. Evidence: confirmation email."
    );
    assert.equal(digestHasActionWork(digest), true);
  });

  it("runs when only a big date is listed", () => {
    const digest = quiet.replace(
      "## Big dates\nNone",
      "## Big dates\nJunior Picnic 2026-08-28 18:00 user-level. Evidence: EPS mail."
    );
    assert.equal(digestHasActionWork(digest), true);
  });

  it("treats missing new sections as None so old quiet digests still skip", () => {
    const old = [
      "## Directives from Yan",
      "None",
      "",
      "## Suggested actions",
      "None",
    ].join("\n");
    assert.equal(digestHasActionWork(old), false);
  });
});

describe("people bootstrap prompt", () => {
  it("points at dumps and forbids roster import", () => {
    const prompt = buildPeopleBootstrapPrompt({
      dateKey: "2026-08-17",
      timezone: "America/Chicago",
    });
    assert.match(prompt, /personal-people/);
    assert.match(prompt, /people\/index\.md/);
    assert.match(prompt, /Student Data Collection|school name index/);
    assert.match(prompt, /Do not import the EPS roster/);
    assert.equal(CONTACTS_PREFETCH_PATH, "/tmp/yanylevin-context-contacts.json");
    assert.equal(
      IMESSAGE_PEOPLE_PREFETCH_PATH,
      "/tmp/yanylevin-context-imessage-people.json"
    );
    assert.equal(MAIL_PEOPLE_PREFETCH_PATH, "/tmp/yanylevin-context-mail-people.json");
    assert.equal(
      SCHOOL_NAMES_PREFETCH_PATH,
      "/tmp/yanylevin-context-school-names.json"
    );
  });
});

describe("people enrich prompt", () => {
  it("lists only the batch slugs and forbids globbing", () => {
    const prompt = buildPeopleEnrichPrompt({
      dateKey: "2026-08-17",
      timezone: "America/Chicago",
      slugs: ["kate-huang", "everette-deng"],
      batch: 2,
      batchCount: 12,
    });
    assert.match(prompt, /Batch 2 of 12/);
    assert.match(prompt, /kate-huang\.md/);
    assert.match(prompt, /everette-deng\.md/);
    assert.match(prompt, /Do not glob people/);
    assert.match(prompt, /composer-2\.5|Nightly context synthesis stays on grok-4\.6/);
    assert.match(prompt, /promote to a folder/);
    assert.doesNotMatch(prompt, /rajasi-saha/);
    assert.equal(PEOPLE_ENRICH_BATCH_SIZE, 12);
    assert.deepEqual(chunkArray(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
  });

  it("lists thin markdown cards and skips folders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "people-thin-"));
    try {
      await mkdir(join(dir, "kate-huang-folder"), { recursive: true });
      await writeFile(join(dir, "index.md"), "# People\n", "utf8");
      await writeFile(join(dir, "skipped.md"), "# Skipped\n", "utf8");
      await writeFile(join(dir, "kate-huang.md"), "# Kate\n", "utf8");
      await writeFile(join(dir, "everette-deng.md"), "# Everette\n", "utf8");
      await writeFile(join(dir, "kate-huang-folder", "person.md"), "# X\n", "utf8");
      const slugs = await listThinPeopleSlugs(dir);
      assert.deepEqual(slugs, ["everette-deng", "kate-huang"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("context synthesis chats prefetch", () => {
  it("maps the repo path to the Cursor Desktop transcripts dir", () => {
    assert.equal(
      defaultAgentTranscriptsDir("$HOME/yanylevin_agentic_framework"),
      join(
        process.env.HOME || "",
        ".cursor/projects/Users-yanlevin-github-yanylevin/agent-transcripts"
      )
    );
  });

  it("extracts user_query turns from a Cursor transcript", () => {
    const jsonl = [
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>\nwhich flight is Alex on\n</user_query>",
            },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "BA57 likely" }] },
      }),
    ].join("\n");
    assert.deepEqual(extractUserQueriesFromTranscript(jsonl), [
      "which flight is Alex on",
    ]);
  });

  it("dumps past-day Personal Agent and Cursor Desktop chats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "context-chats-"));
    const sid = "11111111-1111-1111-1111-111111111111";
    const chatDir = join(dir, "education/you@example.com/.chat-history");
    const convoId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const transcriptsDir = join(dir, "transcripts");
    const outPath = join(dir, "chats.json");
    const now = new Date("2026-08-17T18:00:00.000Z");
    try {
      await mkdir(chatDir, { recursive: true });
      await writeFile(
        join(chatDir, `${sid}.md`),
        [
          "# Personal Agent chat",
          `session: ${sid}`,
          "email: you@example.com",
          "started: 2026-08-17T17:00:00.000Z",
          "updated: 2026-08-17T17:30:00.000Z",
          "title: Alex flight",
          "",
          "## User — 2026-08-17T17:00:00.000Z",
          "which flight",
          "",
        ].join("\n"),
        "utf8"
      );
      await mkdir(join(transcriptsDir, convoId), { recursive: true });
      await writeFile(
        join(transcriptsDir, convoId, `${convoId}.jsonl`),
        `${JSON.stringify({
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: "<user_query>tell the context synthesizer to read chats</user_query>",
              },
            ],
          },
        })}\n`,
        "utf8"
      );
      await mkdir(join(transcriptsDir, "agent-skip-me"), { recursive: true });
      await writeFile(
        join(transcriptsDir, "agent-skip-me", "agent-skip-me.jsonl"),
        `${JSON.stringify({
          role: "user",
          message: {
            content: [
              { type: "text", text: "<user_query>subagent noise</user_query>" },
            ],
          },
        })}\n`,
        "utf8"
      );

      const payload = await prefetchRecentChats(
        { cursors: { chatHistorySince: "2026-08-17T16:51:00.000Z" } },
        { now, root: dir, transcriptsDir, outPath }
      );
      assert.equal(payload.ok, true);
      assert.equal(payload.personalAgent.count, 1);
      assert.equal(payload.personalAgent.chats[0].sessionId, sid);
      assert.match(payload.personalAgent.chats[0].markdown, /which flight/);
      assert.equal(payload.cursorDesktop.count, 1);
      assert.equal(payload.cursorDesktop.chats[0].id, convoId);
      assert.deepEqual(payload.cursorDesktop.chats[0].userQueries, [
        "tell the context synthesizer to read chats",
      ]);
      assert.equal(payload.chatHistorySince, "2026-08-17T16:51:00.000Z");
      const written = JSON.parse(await readFile(outPath, "utf8"));
      assert.equal(written.cursorDesktop.count, 1);
      assert.equal(CHATS_PREFETCH_PATH, "/tmp/yanylevin-context-chats.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("context synthesis schedule", () => {
  it("schedules 02:30 in the briefing timezone", () => {
    const when = nextContextSynthesisAt(
      META,
      new Date("2026-08-16T20:00:00-05:00")
    );
    assert.equal(when.toISOString(), "2026-08-17T07:30:00.000Z");
  });
});

describe("pipeline resume", () => {
  const dateKey = "2026-08-26";

  it("treats lastSynthesisDateKey without lastPipelineDateKey as resume-at-actions", () => {
    assert.equal(
      resumePhaseFromState({ lastSynthesisDateKey: dateKey }, dateKey),
      "actions"
    );
    assert.equal(pipelineFinishedOnFromState({ lastSynthesisDateKey: dateKey }, dateKey), false);
  });

  it("resumes at the phase after lastPipelinePhase on the same night", () => {
    assert.equal(
      resumePhaseFromState(
        { lastPipelinePhase: "synthesis", lastPipelineDateKey: dateKey },
        dateKey
      ),
      "actions"
    );
    assert.equal(
      resumePhaseFromState(
        { lastPipelinePhase: "actions", lastPipelineDateKey: dateKey },
        dateKey
      ),
      "lint"
    );
    assert.equal(
      pipelineFinishedOnFromState(
        { lastPipelineDateKey: dateKey, lastPipelinePhase: "synthesis" },
        dateKey
      ),
      false
    );
  });

  it("does not resume a prior night leftover phase", () => {
    assert.equal(
      resumePhaseFromState(
        {
          lastPipelinePhase: "synthesis",
          lastPipelineDateKey: "2026-08-25",
          lastSynthesisDateKey: "2026-08-25",
        },
        dateKey
      ),
      "triage"
    );
  });

  it("skips when lastPipelineDateKey is today and the phase is finished", () => {
    assert.equal(
      resumePhaseFromState({ lastPipelineDateKey: dateKey, lastPipelinePhase: "finished" }, dateKey),
      "finished"
    );
    assert.equal(
      pipelineFinishedOnFromState({ lastPipelineDateKey: dateKey }, dateKey),
      true
    );
    assert.equal(
      pipelineFinishedOnFromState(
        { lastPipelineDateKey: dateKey, lastPipelinePhase: "finished" },
        dateKey
      ),
      true
    );
  });

  it("force starts at triage even if synthesis already ran", () => {
    assert.equal(
      resumePhaseFromState(
        { lastSynthesisDateKey: dateKey, lastPipelineDateKey: dateKey },
        dateKey,
        "",
        true
      ),
      "triage"
    );
  });

  it("honors --resume-from", () => {
    assert.equal(
      resumePhaseFromState({ lastPipelineDateKey: dateKey }, dateKey, "lint"),
      "lint"
    );
  });
});

describe("stale synthesis lock", () => {
  it("treats a lock older than 90 minutes as idle", () => {
    const now = 1_000_000;
    assert.equal(lockMtimeIsFresh(now, now, SYNTHESIS_LOCK_STALE_MS), true);
    assert.equal(
      lockMtimeIsFresh(now - SYNTHESIS_LOCK_STALE_MS - 1, now, SYNTHESIS_LOCK_STALE_MS),
      false
    );
  });
});
