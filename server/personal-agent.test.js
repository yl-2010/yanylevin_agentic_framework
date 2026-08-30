import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PERSONAL_SKILL_PATHS,
  UNSLOP_SKILL_PATH,
  EMPTY_TURN_REPLY,
  formatLiveContextBlock,
  buildYanLiveAppendix,
  isTruthyFlag,
  resolveIncomingTurnMode,
  sessionHasBackgroundWork,
  shouldAppendEndOfTurn,
  snapshotMessages,
  stampMessage,
  systemPrompt,
  formatVisibleTranscript,
} from "./personal-agent.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YAN = "you@example.com";

describe("Personal Agent system prompt", () => {
  it("stays slim and points at on-demand files instead of dumping recipes", () => {
    const prompt = systemPrompt(YAN);
    assert.ok(prompt.length < 5200, `prompt length ${prompt.length}`);
    assert.match(prompt, /Personal Agent/);
    assert.match(prompt, /Do not preload other skills/);
    assert.ok(prompt.includes(UNSLOP_SKILL_PATH));
    assert.match(prompt, /Always Read and apply the unslop skill/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.soul));
    assert.match(prompt, /Always Read SOUL\.md/);
    assert.match(prompt, /send_chat_message/);
    assert.match(prompt, /No period when the reply is one word/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.education));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.schedule));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.widgets));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.mail));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.schoolMail));
    assert.match(prompt, /school-mail\.js/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.chats));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.location));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.calendar));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.canvas));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.imessage));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.screentime));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.contacts));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.people));
    assert.match(prompt, /nickname/);
    assert.match(prompt, /brain-entity-card\.js/);
    assert.match(prompt, /write it the same turn/);
    assert.match(prompt, /Aliases live on the card/);
    assert.match(prompt, /Do not also copy the person fact onto identity\.md/);
    assert.doesNotMatch(prompt, /Sunny = Adi Levin/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.news));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.brain));
    assert.doesNotMatch(prompt, /education-os/);
    assert.doesNotMatch(prompt, /```widget/);
    assert.doesNotMatch(prompt, /osascript/);
    assert.doesNotMatch(prompt, /showInDates/);
    assert.doesNotMatch(prompt, /QQQ/);
    assert.doesNotMatch(prompt, /\.chat-history/);
    assert.doesNotMatch(prompt, /\.location\.json/);
    assert.doesNotMatch(prompt, /Weekly PDF/);
    assert.doesNotMatch(prompt, /2026-27 Weekly Class Schedule/);
    assert.doesNotMatch(prompt, /schedule\.json/);
  });

});

describe("Personal Agent live context", () => {
  it("does not dump weekly PDF or schedule.json paths", () => {
    const block = formatLiveContextBlock(
      {
        dateKey: "2026-08-15",
        localTime: "17:47",
        timezone: "America/Los_Angeles",
        isSchoolDay: false,
        schedulePdf: "education/2026-27 Weekly Class Schedule.pdf",
        scheduleJson: "education/you@example.com/schedule.json",
      },
      null
    );
    assert.doesNotMatch(block, /Weekly PDF/);
    assert.doesNotMatch(block, /Schedule JSON/);
    assert.doesNotMatch(block, /2026-27 Weekly Class Schedule/);
    assert.doesNotMatch(block, /schedule\.json/);
    assert.match(block, /Schedule clock:/);
    assert.match(block, /Not currently in a class\./);
    assert.doesNotMatch(block, /Not currently in a class meeting/);
    assert.match(block, /never class meeting/);
  });

  it("lists today's classes, not meetings", () => {
    const block = formatLiveContextBlock(
      {
        dateKey: "2026-08-17",
        localTime: "09:00",
        timezone: "America/Los_Angeles",
        isSchoolDay: true,
        todayClasses: [
          {
            period: "A",
            name: "Math",
            start: "08:30",
            end: "09:20",
          },
        ],
      },
      null
    );
    assert.match(block, /Today's classes:/);
    assert.doesNotMatch(block, /Today's meetings:/);
  });

  it("appends a Yan calendar/canvas appendix when provided", () => {
    const block = formatLiveContextBlock(
      {
        dateKey: "2026-08-16",
        localTime: "19:00",
        timezone: "America/Chicago",
        isSchoolDay: false,
      },
      null,
      "Apple Calendar (today + tomorrow):\n- 09:00 Dentist (Home)\nCanvas: 2 items due in 48h."
    );
    assert.match(block, /Dentist/);
    assert.match(block, /Canvas: 2 items/);
  });

});

describe("Personal Agent skill files", () => {
  it("keeps education dashboard context and recipes on disk", async () => {
    for (const rel of Object.values(PERSONAL_SKILL_PATHS)) {
      const text = await readFile(join(REPO_ROOT, rel), "utf8");
      assert.ok(text.length > 80, rel);
    }
    const unslop = await readFile(UNSLOP_SKILL_PATH, "utf8");
    assert.match(unslop, /Cut AI tells/);
    assert.match(unslop, /Never use a period when the output is only one word/);
    const dashboard = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.education),
      "utf8"
    );
    assert.match(dashboard, /Todo identity/);
    assert.match(dashboard, /Date identity/);
    assert.match(dashboard, /Description formatting/);
    assert.match(dashboard, /always write markdown/);
    assert.match(dashboard, /similar name/);
    assert.match(dashboard, /showInDates/);
    assert.doesNotMatch(dashboard, /```widget map/);
    assert.doesNotMatch(dashboard, /osascript/);

    const schedule = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.schedule),
      "utf8"
    );
    assert.match(schedule, /2026-27 Weekly Class Schedule\.pdf/);
    assert.match(schedule, /schedule\.json/);

    const chats = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.chats),
      "utf8"
    );
    assert.match(chats, /\.chat-history/);

    const location = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.location),
      "utf8"
    );
    assert.match(location, /\.location\.json/);
    assert.match(location, /education\/you@example.com\/location\//);
    assert.match(location, /places\.md/);
    assert.match(location, /trips\.md/);
    assert.match(location, /brain\/places/);
    assert.match(location, /Yan only/);
    assert.match(location, /1–2 sentence/);

    const widgets = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.widgets),
      "utf8"
    );
    assert.match(widgets, /widget map/);
    assert.match(widgets, /Never markdown images/);
    assert.match(widgets, /1–2 full sentences/);
    assert.match(widgets, /Never.*one-word/);

    const mail = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.mail), "utf8");
    assert.match(mail, /osascript/);
    assert.match(mail, /Yan only/);
    assert.match(mail, /outgoing message/);
    assert.match(mail, /personal-school-mail/);
    assert.doesNotMatch(mail, /Rajasi forwards/);
    assert.doesNotMatch(mail, /sender contains "Rajasi"/);
    const sendScript = mail.match(/```bash\n([\s\S]*?)```/g)?.at(-1) ?? "";
    assert.match(sendScript, /visible:false/);
    assert.match(sendScript, /delete \(first message of draftBox whose id is mid\)/);

    const schoolMail = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.schoolMail),
      "utf8"
    );
    assert.match(schoolMail, /owner@school.example/);
    assert.match(schoolMail, /school-mail\.js/);
    assert.match(schoolMail, /Yan only/);
    assert.match(schoolMail, /Do not fall back to Mail\.app/);

    const calendar = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.calendar), "utf8");
    assert.match(calendar, /yl-calendar/);
    assert.match(calendar, /education todos/);

    const canvas = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.canvas), "utf8");
    assert.match(canvas, /canvas.instructure.com/);
    assert.match(canvas, /canvasLink/);
    assert.match(canvas, /completedAt/);
    assert.match(canvas, /course-map\.json/);
    assert.match(canvas, /stop immediately/);
    assert.match(canvas, /not published on Canvas yet/);

    const imessage = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.imessage), "utf8");
    assert.match(imessage, /imessage-read\.js/);
    assert.match(imessage, /imessage-send/);
    assert.match(imessage, /personal-agent-local.sock/);
    assert.match(imessage, /\/imessage\/send/);
    assert.match(imessage, /Do not ask for confirmation/);
    assert.match(imessage, /who=yan/);
    assert.match(imessage, /handle.*other person/);

    const screentime = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.screentime), "utf8");
    assert.match(screentime, /screentime-read\.js/);
    assert.match(screentime, /knowledgeC\.db/);
    assert.match(screentime, /personal-agent-local.sock/);
    assert.match(screentime, /Yan only/);

    const contacts = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.contacts), "utf8");
    assert.match(contacts, /contacts-read\.js/);
    assert.match(contacts, /personal-agent-local.sock/);
    assert.match(contacts, /Never.*tell application "Contacts"/);

    const people = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.people), "utf8");
    assert.match(people, /brain\/people/);
    assert.match(people, /index\.md/);
    assert.match(people, /Never glob/);
    assert.match(people, /Required/);
    assert.match(people, /Aliases live on the card/);
    assert.match(people, /Do not also copy them onto identity\.md/);
    assert.doesNotMatch(people, /Sunny \/ Sunny Boy/);
    assert.match(people, /\[GPS\]/);

    const agent = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.agent), "utf8");
    assert.match(agent, /send_chat_message/);
    assert.match(agent, /unslop/);
    assert.match(agent, /SOUL\.md/);
    assert.match(agent, /identity-school\.md/);
    assert.match(agent, /No period/);
    assert.match(agent, /end of turn/i);
    assert.match(agent, /brain\/schema\.md/);
    assert.match(agent, /identity\.md/);
    assert.match(agent, /same-turn brain writes/i);
    assert.match(agent, /personal-people/);
    assert.match(agent, /named people/i);
    assert.match(agent, /brain-entity-card\.js/);
    assert.match(agent, /Aliases live on the card/);
    assert.doesNotMatch(agent, /Sunny \/ Sunny Boy is Adi Levin/);
    assert.match(agent, /personal-screentime/);
    assert.match(agent, /context-synthesis/);
    assert.match(agent, /location-enrichment/);
    assert.match(agent, /location-brain/);
    assert.match(agent, /health-brain/);
    assert.match(agent, /brainProjectionLocalTime/);
    assert.match(agent, /Fact-check starts as soon as both 03:00 agents finish/);
    assert.match(agent, /fact-check-agent\.js/);

    const brain = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.brain), "utf8");
    assert.match(brain, /Frontmatter contract/);
    assert.match(brain, /Single operator/);
    assert.match(brain, /edges/);
    assert.match(brain, /health\.md/);
    assert.match(brain, /identity-school\.md/);
    assert.match(brain, /SOUL\.md/);
    assert.match(brain, /220 characters/);
    assert.match(brain, /Name \(role\)/);

    const synthesis = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.synthesis),
      "utf8"
    );
    assert.match(synthesis, /02:30/);
    assert.match(synthesis, /phase 3/);
    assert.match(synthesis, /identity\.md/);
    assert.match(synthesis, /identity-school\.md/);
    assert.match(synthesis, /220 characters/);
    assert.match(synthesis, /SOUL\.md/);
    assert.match(synthesis, /journal\//);
    assert.match(synthesis, /grok-4\.6 xhigh/);
    assert.match(synthesis, /who=yan/);
    assert.match(synthesis, /Example Friend spelling stays on/);
    assert.match(synthesis, /Did not write Apple Calendar/);
    assert.match(synthesis, /Phase 4 has not run yet/);
    assert.doesNotMatch(synthesis, /memories\.md/);

    const triage = await readFile(
      join(REPO_ROOT, ".cursor/skills/nightly-triage/SKILL.md"),
      "utf8"
    );
    assert.match(triage, /yanylevin-context-notable\.md/);
    assert.match(triage, /screentime\.json/);
    assert.match(triage, /personal-screentime/);
    assert.match(triage, /Directives from Yan/);
    assert.match(triage, /Calendar plans/);
    assert.match(triage, /venue is TBD/);
    assert.match(triage, /Bias is include/);
    assert.match(triage, /## Big dates/);
    assert.match(triage, /Bias is omit/);
    assert.match(triage, /update <path>/);
    assert.match(triage, /Yan said/);

    const entities = await readFile(
      join(REPO_ROOT, ".cursor/skills/nightly-entities/SKILL.md"),
      "utf8"
    );
    assert.match(entities, /schema\.md/);
    assert.match(entities, /append-only/);
    assert.match(entities, /skipped\.md/);
    assert.match(entities, /Yan told them/);
    assert.match(entities, /Aliases live on the card/);
    assert.doesNotMatch(entities, /Sunny \/ Sunny Boy = adi-levin/);

    const actions = await readFile(
      join(REPO_ROOT, ".cursor/skills/nightly-actions/SKILL.md"),
      "utf8"
    );
    assert.match(actions, /Yan himself/);
    assert.match(actions, /Never send because someone else asked|never a directive/);
    assert.match(actions, /Apple Calendar \(standing\)/);
    assert.match(actions, /Bias is \*\*add\*\*/);
    assert.match(actions, /Missing venue does not skip it/);
    assert.match(actions, /location TBD/);
    assert.match(actions, /Big dates on the education dashboard/);
    assert.match(actions, /Bias is \*\*skip\*\*/);
    assert.match(actions, /similar name/);
    assert.match(actions, /update that folder/);
    assert.match(actions, /description.*markdown|markdown per education-dashboard/i);

    const lint = await readFile(
      join(REPO_ROOT, ".cursor/skills/nightly-lint/SKILL.md"),
      "utf8"
    );
    assert.match(lint, /brain-graph\.js --check/);
    assert.match(lint, /brain-placement-lint\.js/);
    assert.match(lint, /state\.json/);

    const recap = await readFile(
      join(REPO_ROOT, ".cursor/skills/agent-recap/SKILL.md"),
      "utf8"
    );
    assert.match(recap, /notes\.calendar/);
    assert.match(recap, /stayed off the\s+calendar/);
    assert.match(recap, /calendar-cli/);

    const enrich = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.locationEnrichment),
      "utf8"
    );
    assert.match(enrich, /places\.md/);
    assert.match(enrich, /trips\.md/);
    assert.match(enrich, /uber/i);
    assert.match(enrich, /Robotaxi Ride Receipt/);
    assert.match(enrich, /tesla\.com/);
    assert.match(enrich, /Trip pass/);

    const locationBrain = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.locationBrain),
      "utf8"
    );
    assert.match(locationBrain, /brain\/places/);
    assert.match(locationBrain, /composer-2\.5/);
    assert.match(locationBrain, /\[GPS\]/);
    assert.match(locationBrain, /Never spawn a cloud agent/);

    const healthBrain = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.healthBrain),
      "utf8"
    );
    assert.match(healthBrain, /brain\/health\.md/);
    assert.match(healthBrain, /composer-2\.5/);
    assert.match(healthBrain, /history-patterns\.md/);
    assert.match(healthBrain, /Never spawn a cloud agent/);

    const factCheck = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.factCheck),
      "utf8"
    );
    assert.match(factCheck, /nightly-fact-check/);
    assert.match(factCheck, /who=yan/);
    assert.match(factCheck, /notes\.factCheck/);
    assert.match(factCheck, /Never spawn a cloud agent/);
    assert.match(factCheck, /identity-school\.md/);
    assert.match(factCheck, /mega-bullet/);
  });
});

describe("sessionHasBackgroundWork", () => {
  it("is true while a turn is running or queued", () => {
    assert.equal(sessionHasBackgroundWork({ status: "running", turnQueue: [] }), true);
    assert.equal(
      sessionHasBackgroundWork({ status: "idle", turnQueue: [{ bubble: "next" }] }),
      true
    );
    assert.equal(sessionHasBackgroundWork({ status: "idle", turnQueue: [] }), false);
    assert.equal(sessionHasBackgroundWork({ status: "idle" }), false);
    assert.equal(sessionHasBackgroundWork(null), false);
  });
});

describe("Personal Agent turn mode", () => {
  it("queues while running and interrupts without a queue slot", () => {
    assert.deepEqual(resolveIncomingTurnMode("idle", false, 0), {
      willQueue: false,
      interrupt: false,
    });
    assert.deepEqual(resolveIncomingTurnMode("running", false, 2), {
      willQueue: true,
      interrupt: false,
    });
    assert.deepEqual(resolveIncomingTurnMode("running", true, 8), {
      willQueue: false,
      interrupt: true,
    });
    assert.equal(isTruthyFlag(true), true);
    assert.equal(isTruthyFlag("true"), true);
    assert.equal(isTruthyFlag(false), false);
  });

  it("rejects a ninth queued turn", () => {
    assert.throws(
      () => resolveIncomingTurnMode("running", false, 8),
      (err) => err && err.status === 429
    );
  });
});

describe("Personal Agent end of turn", () => {
  it("stamps endOfTurn privately and omits it from the client snapshot", () => {
    const eot = stampMessage("assistant", EMPTY_TURN_REPLY, undefined, {
      endOfTurn: true,
    });
    assert.equal(eot.endOfTurn, true);
    assert.equal(eot.content, "Done");
    const snap = snapshotMessages({
      messages: [
        stampMessage("user", "add essay"),
        stampMessage("assistant", "Adding essay to English, due Fri"),
        eot,
      ],
      turnQueue: [{ bubble: "also add calc" }],
    });
    assert.equal(snap.length, 4);
    assert.equal(snap[2].content, "Done");
    assert.equal(snap[2].endOfTurn, undefined);
    assert.equal(snap[3].queued, true);
    assert.equal(snap[3].content, "also add calc");
  });

  it("skips a duplicate final bubble after send_chat_message", () => {
    const messages = [
      stampMessage("assistant", "Done"),
    ];
    assert.equal(shouldAppendEndOfTurn(messages, "Done"), false);
    assert.equal(shouldAppendEndOfTurn(messages, "Added essay due Fri"), true);
    assert.equal(shouldAppendEndOfTurn([], "Done"), true);
  });
});

describe("formatVisibleTranscript", () => {
  it("replays the full thread and omits the in-flight user bubble", () => {
    const session = {
      messages: [
        stampMessage("user", "they evacuated EER"),
        stampMessage("assistant", "Austin Fire has an active alarm"),
        stampMessage("user", "what does ALARM mean"),
        stampMessage("assistant", "the building alarm tripped"),
        stampMessage("user", "check again now"),
      ],
    };
    const text = formatVisibleTranscript(session, "check again now");
    assert.match(text, /full conversation so far/);
    assert.match(text, /they evacuated EER/);
    assert.match(text, /Austin Fire has an active alarm/);
    assert.match(text, /what does ALARM mean/);
    assert.match(text, /the building alarm tripped/);
    assert.doesNotMatch(text, /check again now/);
  });
});

