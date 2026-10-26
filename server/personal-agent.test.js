import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatTeamsOriginBlock, normalizeTeamsOrigin } from "./teams-mention.js";
import { formatIMessageOriginBlock, normalizeIMessageOrigin } from "./imessage-mention.js";
import { formatWhatsAppOriginBlock, normalizeWhatsAppOrigin } from "./whatsapp-mention.js";
import {
  queueIMessageReplyFiles,
  resetIMessageReplyFiles,
  takeIMessageReplyFiles,
} from "./imessage-send.js";
import {
  PERSONAL_SKILL_PATHS,
  UNSLOP_SKILL_PATH,
  FOUR11_SKILL_PATH,
  ATTACHMENT_MODEL_SPEC,
  DEFAULT_MODEL_SPEC,
  EMPTY_TURN_REPLY,
  guestTurnModelSpec,
  formatLiveContextBlock,
  normalizeUiContext,
  buildYanLiveAppendix,
  isTruthyFlag,
  resolveIncomingTurnMode,
  sessionHasBackgroundWork,
  shouldKeepChatHistoryRead,
  isUiChatClient,
  shouldPersistChatEphemeral,
  pinEphemeralChatIfUiClient,
  shouldAppendEndOfTurn,
  snapshotMessages,
  stampMessage,
  detachQueuedTurn,
  withInterruptNote,
  interruptClarificationNote,
  rewritePromptForOwedChannel,
  restoreOwedChannelDelivery,
  claimChannelDelivery,
  handOffOwedChannel,
  INTERRUPT_NOTE,
  systemPrompt,
  formatVisibleTranscript,
  normalizeEducationNavigate,
  educationNavigateHref,
  queueEducationNavigate,
  publishQueuedEducationNavigate,
  deliverIMessageFinalReply,
  deliverIMessageProgressReply,
  deliverTeamsFinalReply,
  channelProgressKind,
  channelSendToolResult,
  usageKind,
  usagePerson,
  dropRejectedChatGuid,
  nextOutboundAction,
  outboundResumePrompt,
  shouldSkipDuplicateChannelSend,
} from "./personal-agent.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YAN = "you@example.com";

describe("usage labels", () => {
  it("records JYPE from the workspace, and the sender from the poller", () => {
    const session = {
      workspace: "jype",
      teamsOrigin: { chat: "1" },
      guestCaller: { displayName: "Example Neighbor" },
      email: YAN,
    };
    assert.equal(usageKind(session), "jype-agent");
    assert.equal(usagePerson(session), "Example Neighbor");
  });

  it("records a Teams DM as teams agent for the person who sent it", () => {
    const session = {
      teamsOrigin: { chat: "1" },
      guestCaller: { displayName: "Alex" },
      email: YAN,
    };
    assert.equal(usageKind(session), "teams-agent");
    assert.equal(usagePerson(session), "Alex");
  });

  it("records a scheduled kickoff as a future agent before the workspace", () => {
    assert.equal(usageKind({ workspace: "jype" }, { scheduledKickoff: true }), "future-agent");
  });
});

describe("Personal Agent models", () => {
  it("uses grok-4.7 high with Fast off for text and attachments", () => {
    assert.equal(DEFAULT_MODEL_SPEC.id, "grok-4.7");
    assert.deepEqual(DEFAULT_MODEL_SPEC.params, [
      { id: "context", value: "256k" },
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "false" },
    ]);
    assert.equal(ATTACHMENT_MODEL_SPEC.id, "grok-4.7");
    assert.deepEqual(ATTACHMENT_MODEL_SPEC.params, [
      { id: "context", value: "256k" },
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "false" },
    ]);
  });

  it("keeps Fast off for @agent first turns and later app turns", () => {
    const yanMention = guestTurnModelSpec(
      { imessageDeliverFinal: true, guestCaller: null },
      false
    );
    assert.equal(yanMention.id, "grok-4.7");
    assert.deepEqual(yanMention.params, [
      { id: "context", value: "256k" },
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "false" },
    ]);
    const later = guestTurnModelSpec(
      { imessageDeliverFinal: false, guestCaller: null },
      false
    );
    assert.deepEqual(later.params, DEFAULT_MODEL_SPEC.params);
    const guestMention = guestTurnModelSpec(
      {
        imessageDeliverFinal: true,
        guestCaller: {
          slug: "alex-rivera",
          displayName: "Alex",
          model: {
            id: "grok-4.7",
            params: [
              { id: "context", value: "256k" },
              { id: "reasoning_effort", value: "high" },
              { id: "fast", value: "false" },
            ],
          },
        },
      },
      false
    );
    assert.equal(
      guestMention.params.find((p) => p.id === "fast")?.value,
      "false"
    );
    const teamsJype = guestTurnModelSpec(
      {
        teamsDeliverFinal: true,
        workspace: "jype",
        guestCaller: null,
      },
      false
    );
    assert.equal(teamsJype.id, "composer-2.5");
    assert.deepEqual(teamsJype.params, [{ id: "fast", value: "false" }]);
    const imessageJype = guestTurnModelSpec(
      {
        imessageDeliverFinal: true,
        workspace: "jype",
        guestCaller: null,
      },
      false
    );
    assert.equal(imessageJype.id, "grok-4.7");
    const grokOverride = guestTurnModelSpec(
      {
        teamsDeliverFinal: true,
        workspace: "jype",
        forceGrok: true,
        guestCaller: null,
      },
      false
    );
    assert.equal(grokOverride.id, "grok-4.7");
    assert.equal(
      grokOverride.params.find((p) => p.id === "reasoning_effort")?.value,
      "high"
    );
    assert.equal(
      grokOverride.params.find((p) => p.id === "fast")?.value,
      "false"
    );
  });
});

describe("Personal Agent system prompt", () => {
  it("stays slim and points at on-demand files instead of dumping recipes", () => {
    const prompt = systemPrompt(YAN);
    assert.ok(prompt.length < 7800, `prompt length ${prompt.length}`);
    assert.match(prompt, /Personal Agent/);
    assert.match(prompt, /schedule_future_agent/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.futureAgents));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.celebration));
    assert.match(prompt, /Do not preload other skills/);
    assert.ok(prompt.includes(UNSLOP_SKILL_PATH));
    assert.ok(prompt.includes(FOUR11_SKILL_PATH));
    assert.match(prompt, /Always Read and apply the unslop skill/);
    assert.match(prompt, /Never mention the surprise hoodies to Alex/);
    assert.match(prompt, /Yan's course percent, letter, and assignment scores do not go to Example Friend, Example Neighbor/);
    assert.match(prompt, /education\/tests\/ is a private guide/);
    assert.match(prompt, /do not say a scan or last year's test exists/);
    assert.match(prompt, /EPS student IDs \/ school photos/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.soul));
    assert.match(prompt, /Always Read SOUL\.md/);
    assert.match(prompt, /send_chat_message/);
    assert.match(prompt, /Send more mid-run/);
    assert.match(prompt, /posted to the chat before you start the work/);
    assert.doesNotMatch(prompt, /once, first/);
    assert.match(prompt, /open_education_page/);
    assert.match(prompt, /No period when the reply is one word/);
    assert.match(prompt, /Math on the website and in the iOS app is a display block/);
    assert.match(prompt, /Never backticks for math/);
    assert.match(prompt, /Never put Sent by Yan's Personal Agent in app or website bubbles/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.education));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.schedule));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.widgets));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.browser));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.computer));
    assert.match(prompt, /skip static fetch/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.mail));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.schoolMail));
    assert.match(prompt, /school-mail\.js/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.schoolOnenote));
    assert.match(prompt, /on demand only/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.schoolTeams));
    assert.match(prompt, /school-teams\.js/);
    assert.match(prompt, /iMessage, then Teams, then email/);
    assert.match(prompt, /native attachments/);
    assert.match(prompt, /school-teams\.js cannot attach a file/);
    assert.match(prompt, /Teams app with computer use/);
    assert.match(prompt, /images has no pixels/);
    assert.match(prompt, /existing Word, Excel, or PowerPoint/);
    assert.match(prompt, /School Outlook still cannot send/);
    assert.ok(prompt.length < 7800, `prompt length ${prompt.length}`);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.chats));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.location));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.lifeState));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.calendar));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.home));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.canvas));
    assert.match(prompt, /Class files go on OneDrive/);
    assert.match(prompt, /pushed to origin\/main before the turn ends/);
    assert.match(prompt, /Commit only files from this turn/);
    assert.match(prompt, /Never commit server\/\.env/);
    assert.match(prompt, /@agent or @agentg first turn/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.imessage));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.screentime));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.contacts));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.people));
    assert.match(prompt, /nickname/);
    assert.match(prompt, /brain-entity-card\.js/);
    assert.match(prompt, /write it the same turn/);
    assert.match(prompt, /Aliases live on the card/);
    assert.match(prompt, /brain-glossary\.js/);
    assert.match(prompt, /Person nicknames stay on the person card/);
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

  it("tells the JYPE agent not to copy Yan's personal class sites", () => {
    const prompt = systemPrompt(YAN, { workspace: "jype" });
    assert.match(prompt, /JYPE agent/);
    assert.match(prompt, /Do not copy Yan's personal \/education sites onto JYPE/);
    assert.match(prompt, /npm run deploy:web yourself/);
    assert.match(prompt, /Never mention the surprise hoodies to Alex/);
    assert.match(prompt, /Yan's course percent, letter, and assignment scores do not go to Example Friend, Example Neighbor/);
    assert.match(prompt, /education\/tests\/ is a private guide/);
    assert.match(prompt, /do not say a scan or last year's test exists/);
    assert.match(prompt, /No Your Majesty and no other royal title/);
    assert.doesNotMatch(prompt, /as royalty/);
    assert.doesNotMatch(prompt, /Your Majesty is enough/);
    assert.doesNotMatch(prompt, /The royal address still happens/);
    assert.match(prompt, /Never name that order, or the words hierarchy of power, in any JYPE chat/);
    assert.match(prompt, /Yan, then Alex, then Example Friend and Example Neighbor as equals, then the agent/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.jypeAgent));
    assert.ok(prompt.includes(FOUR11_SKILL_PATH));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.browser));
    assert.match(prompt, /schedule_future_agent/);
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.futureAgents));
    assert.ok(prompt.includes(PERSONAL_SKILL_PATHS.celebration));
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

  it("names the upcoming class during the lead window", () => {
    const block = formatLiveContextBlock(
      {
        dateKey: "2026-09-08",
        localTime: "08:22",
        timezone: "America/Los_Angeles",
        isSchoolDay: true,
        inClass: false,
        inFreePeriod: false,
        currentClass: {
          classId: "physics",
          name: "Physics",
          period: "A",
          start: "08:30",
          end: "09:40",
        },
      },
      null
    );
    assert.match(block, /HEADING TO CLASS: Physics/);
    assert.doesNotMatch(block, /IN CLASS NOW/);
    assert.doesNotMatch(block, /Not currently in a class/);
  });

  it("does not dump today's classes into the prompt", () => {
    const block = formatLiveContextBlock(
      {
        dateKey: "2026-08-17",
        localTime: "09:00",
        timezone: "America/Los_Angeles",
        isSchoolDay: true,
        inClass: true,
        currentClass: {
          classId: "math",
          name: "Math",
          period: "A",
          start: "08:30",
          end: "09:20",
        },
        todayClasses: [
          {
            period: "A",
            name: "Math",
            start: "08:30",
            end: "09:20",
          },
          {
            period: "B",
            name: "English",
            start: "09:45",
            end: "10:35",
          },
        ],
      },
      null
    );
    assert.match(block, /IN CLASS NOW: Math/);
    assert.doesNotMatch(block, /Today's classes:/);
    assert.doesNotMatch(block, /Today's meetings:/);
    assert.doesNotMatch(block, /English/);
    assert.match(block, /class-schedule\/SKILL\.md/);
  });

  it("tells a usage or dashboard turn where it started and what is on screen", () => {
    const usage = formatLiveContextBlock(null, {
      client: "web",
      path: "/usage/",
      view: "usage",
      site: "usage",
      screen: "Range: Last 7 days\nFilters: person Yan",
    });
    assert.match(usage, /Called from the usage site/);
    assert.match(usage, /same chat history as education/);
    assert.match(usage, /Range: Last 7 days/);
    assert.match(usage, /Filters: person Yan/);
    assert.doesNotMatch(usage, /education-dashboard skill/);

    const dash = formatLiveContextBlock(null, {
      client: "web",
      path: "/dashboard/",
      view: "dashboard",
      screen: "Actions:\n- Canvas sync",
    });
    assert.match(dash, /Called from the dashboard site/);
    assert.match(dash, /Canvas sync/);
    assert.doesNotMatch(dash, /Before creating or editing dashboard objects/);
  });

  it("keeps usage screen text and drops unknown fields", () => {
    const ctx = normalizeUiContext({
      client: "web",
      view: "usage",
      site: "usage",
      screen: "Metric: tokens",
      secret: "nope",
    });
    assert.equal(ctx.view, "usage");
    assert.equal(ctx.site, "usage");
    assert.equal(ctx.screen, "Metric: tokens");
    assert.equal(ctx.secret, undefined);
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
    const four11 = await readFile(FOUR11_SKILL_PATH, "utf8");
    assert.match(four11, /thefixphotogroup\.zenfolio\.com\/f409629586/);
    assert.match(four11, /eq=\{STUDENT_ID\}/);
    const dashboard = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.education),
      "utf8"
    );
    assert.match(dashboard, /Todo identity/);
    assert.match(dashboard, /Date identity/);
    assert.match(dashboard, /open_education_page/);
    assert.match(dashboard, /Description formatting/);
    assert.match(dashboard, /always write markdown/);
    assert.match(dashboard, /similar name/);
    assert.match(dashboard, /showInDates/);
    assert.match(dashboard, /hiddenFromHome/);
    assert.match(dashboard, /canvas-files\.js store/);
    assert.match(dashboard, /handle this file" is store only/);
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
    assert.match(location, /5-minute heartbeat/);
    assert.match(location, /Sitting still/);
    assert.match(location, /device/);
    assert.match(location, /iPad app must not/);
    assert.match(location, /Yan only/);
    assert.match(location, /1–2 sentence/);

    const lifeState = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.lifeState),
      "utf8"
    );
    assert.match(lifeState, /Yan only/);
    assert.match(lifeState, /current\.json/);
    assert.match(lifeState, /life-state\.js now/);
    assert.match(lifeState, /bathroom/);
    assert.match(lifeState, /lastMotionRoom/);
    assert.match(lifeState, /bathroomBoolean/);
    assert.match(lifeState, /going_to_shower/);
    assert.match(lifeState, /plugged_in/);
    assert.match(lifeState, /tesla_bluetooth/);
    assert.match(lifeState, /Nightly jobs/);
    assert.match(lifeState, /life-state-cleanup/);
    assert.match(lifeState, /Never spawn a cloud agent/);

    const widgets = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.widgets),
      "utf8"
    );
    assert.match(widgets, /widget map/);
    assert.match(widgets, /Never markdown images/);
    assert.match(widgets, /1–2 full sentences/);
    assert.match(widgets, /Never.*one-word/);
    assert.match(widgets, /personal-browser/);

    const browser = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.browser),
      "utf8"
    );
    assert.match(browser, /Google Chrome/);
    assert.match(browser, /skip static|When to skip/i);
    assert.match(browser, /JYPE/);
    assert.match(browser, /family portal/i);
    assert.match(browser, /school-mail\.js search/);
    assert.match(browser, /Fidelity|brokerage/);
    assert.match(browser, /browser_navigate/);
    assert.doesNotMatch(browser, /school-mail\/chrome-profile/);

    const mail = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.mail), "utf8");
    assert.match(mail, /osascript/);
    assert.match(mail, /Yan only/);
    assert.match(mail, /outgoing message/);
    assert.match(mail, /personal-school-mail/);
    assert.match(mail, /read `source` of that message/);
    assert.match(mail, /drops the href/);
    assert.match(mail, /Sent by Yan's Personal Agent/);
    assert.match(mail, /Never put that line in the Personal Agent app/);
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

    const schoolOnenote = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.schoolOnenote),
      "utf8"
    );
    assert.match(schoolOnenote, /owner@school.example/);
    assert.match(schoolOnenote, /school-onenote\.js/);
    assert.match(schoolOnenote, /Yan only/);
    assert.match(schoolOnenote, /no `school-onenote-fill`/i);
    assert.match(schoolOnenote, /default nightly source/);

    const schoolTeams = await readFile(
      join(REPO_ROOT, PERSONAL_SKILL_PATHS.schoolTeams),
      "utf8"
    );
    assert.match(schoolTeams, /owner@school.example/);
    assert.match(schoolTeams, /school-teams\.js/);
    assert.match(schoolTeams, /Yan only/);
    assert.match(schoolTeams, /Sent by Yan's Personal Agent/);
    assert.match(schoolTeams, /\/\/ Sent by Yan's Personal Agent/);
    assert.match(schoolTeams, /JYPE \(iMessage or Teams\)/);
    assert.match(schoolTeams, /@agent/);
    assert.match(schoolTeams, /keep that final bubble/);
    assert.match(schoolTeams, /before they start/);
    assert.match(schoolTeams, /posted to this Teams chat immediately/);
    assert.match(schoolTeams, /class channel/);
    assert.match(schoolTeams, /Anyone can call/);
    assert.match(schoolTeams, /except the Class of 2028/);
    assert.match(schoolTeams, /to himself/);
    assert.match(schoolTeams, /--chat myself/);
    assert.match(schoolTeams, /only Yan, Alex, Example Friend, and Example Neighbor/);
    assert.doesNotMatch(schoolTeams, /Other people typing `@agent` do nothing/);
    assert.match(schoolTeams, /school-teams-fill/);
    assert.match(schoolTeams, /brain-school-teams/);
    assert.match(schoolTeams, /Each row's `speaker` is the/);
    assert.match(schoolTeams, /speaker=Agent`? is you/);

    const calendar = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.calendar), "utf8");
    assert.match(calendar, /yl-calendar/);
    assert.match(calendar, /education todos/);
    assert.match(calendar, /Meeting links \(required\)/);
    assert.match(calendar, /--url/);
    assert.match(calendar, /zoom\.us\/webinar\/register/);

    const home = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.home), "utf8");
    assert.match(home, /HomeClaw/);
    assert.match(home, /home-cli\.js/);
    assert.match(home, /homeclaw-cli/);
    assert.match(home, /Yan only/);
    assert.match(home, /brightness/);
    assert.match(home, /Do not install Homebridge/);
    assert.match(home, /apps\.apple\.com\/us\/app\/homeclaw/);

    const canvas = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.canvas), "utf8");
    assert.match(canvas, /canvas.instructure.com/);
    assert.match(canvas, /canvasLink/);
    assert.match(canvas, /\/grades/);
    assert.match(canvas, /completedAt/);
    assert.match(canvas, /course-map\.json/);
    assert.match(canvas, /stop immediately/);
    assert.match(canvas, /not published on Canvas yet/);
    assert.match(canvas, /canvas-files\.js/);
    assert.match(canvas, /not-online-upload/);
    assert.match(canvas, /Turn in and save are different jobs/);
    assert.match(canvas, /never submits/);

    const imessage = await readFile(join(REPO_ROOT, PERSONAL_SKILL_PATHS.imessage), "utf8");
    assert.match(imessage, /imessage-read\.js/);
    assert.match(imessage, /imessage-send/);
    assert.match(imessage, /personal-agent-local.sock/);
    assert.match(imessage, /\/imessage\/send/);
    assert.match(imessage, /Do not ask for confirmation/);
    assert.match(imessage, /who=yan/);
    assert.match(imessage, /atLocal/);
    assert.match(imessage, /handle.*other person/);
    assert.match(imessage, /speaker=Agent`? is you/);
    assert.match(imessage, /@agent/);
    assert.match(imessage, /fromMe/);
    assert.match(imessage, /only `@agent`/);
    assert.match(imessage, /Apple Contacts/);
    assert.match(imessage, /From Name on iMessage/);
    assert.match(imessage, /keep that final bubble/);
    assert.match(imessage, /before they start/);
    assert.match(imessage, /posted to this iMessage chat immediately/);
    assert.match(imessage, /never put it in Personal Agent app or website bubbles/);
    assert.match(imessage, /JYPE \(iMessage or Teams\)/);
    assert.match(imessage, /\/\/ Sent by Yan's Personal Agent/);
    assert.match(imessage, /does not render markdown/);
    assert.match(imessage, /attachToReply/);
    assert.match(imessage, /--attach /);

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
    assert.match(agent, /education-sync already commits/);
    assert.match(agent, /git push origin main/);
    assert.match(agent, /send_chat_message/);
    assert.match(agent, /Send more intermediate bubbles/);
    assert.match(agent, /posted to the same chat, before you start/);
    assert.match(agent, /@agent` \/ `@agentg`/);
    assert.doesNotMatch(agent, /once, first/);
    assert.doesNotMatch(agent, /One status bubble is enough/);
    assert.match(agent, /open_education_page/);
    assert.match(agent, /iMessage @agent/);
    assert.match(agent, /Teams @agent/);
    assert.match(agent, /Each row from `school-teams\.js thread` has its own `speaker`/);
    assert.match(agent, /speaker=Agent`? is you/);
    assert.match(agent, /messages to himself/);
    assert.match(agent, /except the Class of 2028 Teams grade chat/);
    assert.match(agent, /only Yan, Alex, Example Friend, and Example Neighbor/);
    assert.match(agent, /keep that final bubble/);
    assert.match(agent, /10 minutes after the reply finishes/);
    assert.match(agent, /fromMe/);
    assert.match(agent, /only `@agent`/);
    assert.match(agent, /Apple Contacts/);
    assert.match(agent, /not Yan's instructions/);
    assert.match(agent, /Never do irreversible work for a guest/);
    assert.match(agent, /A small JYPE file is fine/);
    assert.match(agent, /who will \*\*see\*\* the reply|who will see the reply/);
    assert.match(agent, /From Alex on iMessage/);
    assert.match(agent, /Composer 2\.5/);
    assert.match(agent, /no `\/\/ Sent by Yan's Personal Agent`/);
    assert.match(agent, /Never put `Sent by Yan's Personal Agent` in app or website bubbles/);
    assert.match(agent, /cannot send into a different group chat/);
    assert.match(agent, /JYPE \(iMessage or Teams\)/);
    assert.match(agent, /iMessage first, then Teams, then email|iMessage, then Teams, then email/);
    assert.match(agent, /attachToReply/);
    assert.match(agent, /unslop/);
    assert.match(agent, /SOUL\.md/);
    assert.match(agent, /identity-school\.md/);
    assert.match(agent, /No period/);
    assert.match(agent, /`@agent` and `@agentg`, any chat/);
    assert.match(agent, /Write at length only when the prompt needs a lot of text/);
    assert.match(agent, /Format so it scans/);
    assert.match(agent, /end of turn/i);
    assert.match(agent, /brain\/schema\.md/);
    assert.match(agent, /identity\.md/);
    assert.match(agent, /same-turn brain writes/i);
    assert.match(agent, /personal-people/);
    assert.match(agent, /personal-home/);
    assert.match(agent, /life-state/);
    assert.match(agent, /Apple Home/);
    assert.match(agent, /named people/i);
    assert.match(agent, /brain-entity-card\.js/);
    assert.match(agent, /brain-glossary\.js/);
    assert.match(agent, /Aliases live on the card/);
    assert.doesNotMatch(agent, /Sunny \/ Sunny Boy is Adi Levin/);
    assert.match(agent, /personal-screentime/);
    assert.match(agent, /personal-onenote/);
    assert.match(agent, /personal-browser/);
    assert.match(agent, /context-synthesis/);
    assert.match(agent, /location-enrichment/);
    assert.match(agent, /location-brain/);
    assert.match(agent, /health-brain/);
    assert.match(agent, /brainProjectionLocalTime/);
    assert.match(agent, /Fact-check starts as soon as both 03:00 agents finish/);
    assert.match(agent, /fact-check-agent\.js/);
    assert.match(agent, /lifeStateCleanupLocalTime/);
    assert.match(agent, /life-state-cleanup-agent\.js/);
    assert.match(agent, /eps-four11/);

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
    assert.match(synthesis, /grok-4\.7 xhigh/);
    assert.match(synthesis, /who=yan/);
    assert.match(synthesis, /Example Friend spelling stays on/);
    assert.match(synthesis, /Did not write Apple Calendar/);
    assert.match(synthesis, /Phase 4 has not run yet/);
    assert.match(synthesis, /OneNote is not a nightly source/);
    assert.match(synthesis, /life-state/);
    assert.match(synthesis, /teamsSince/);
    assert.match(synthesis, /brain-glossary\.js/);
    assert.match(synthesis, /not a person nickname/);
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
    assert.match(triage, /meeting URL/);
    assert.match(triage, /Bias is include/);
    assert.match(triage, /## Big dates/);
    assert.match(triage, /Bias is omit/);
    assert.match(triage, /update <path>/);
    assert.match(triage, /Yan said/);
    assert.match(triage, /Not a source: OneNote/);
    assert.match(triage, /personal-school-teams/);
    assert.match(triage, /yanylevin-context-school-teams\.json/);
    assert.match(triage, /yanylevin-context-life-state\.json/);
    assert.match(triage, /atLocal/);
    assert.match(triage, /Mail standing/);
    assert.match(triage, /PathIvy/);

    const entities = await readFile(
      join(REPO_ROOT, ".cursor/skills/nightly-entities/SKILL.md"),
      "utf8"
    );
    assert.match(entities, /schema\.md/);
    assert.match(entities, /append-only/);
    assert.match(entities, /skipped\.md/);
    assert.match(entities, /Yan told them/);
    assert.match(entities, /atLocal/);
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
    assert.match(actions, /OneNote/);
    assert.match(actions, /personal-onenote/);
    assert.match(actions, /Meeting links are required/);
    assert.match(actions, /--url/);

    const lint = await readFile(
      join(REPO_ROOT, ".cursor/skills/nightly-lint/SKILL.md"),
      "utf8"
    );
    assert.match(lint, /brain-graph\.js --check/);
    assert.match(lint, /brain-glossary\.js --check/);
    assert.match(lint, /brain-placement-lint\.js/);
    assert.match(lint, /state\.json/);
    assert.match(lint, /commits `server\/`/);

    const recap = await readFile(
      join(REPO_ROOT, ".cursor/skills/agent-recap/SKILL.md"),
      "utf8"
    );
    assert.match(recap, /notes\.calendar/);
    assert.match(recap, /stayed off the\s+calendar/);
    assert.match(recap, /calendar-cli/);
    assert.match(recap, /lifeState\.issues/);
    assert.match(recap, /healthShortcut\.issues/);
    assert.match(recap, /Sitting still/);
    assert.match(recap, /no-new-points/);
    assert.match(recap, /life-state cleanup/);

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
    assert.match(factCheck, /Do not scan OneNote/);
    assert.match(factCheck, /atLocal/);
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

describe("shouldKeepChatHistoryRead", () => {
  const user = [{ role: "user", content: "@agent ping" }];
  const firstTurn = [
    { role: "user", content: "@agent ping" },
    { role: "assistant", content: "done" },
  ];
  const followUp = [
    ...firstTurn,
    { role: "user", content: "and then?" },
  ];

  it("keeps iMessage and Teams @agent first turns read", () => {
    assert.equal(shouldKeepChatHistoryRead({ imessageOrigin: { to: "x" } }, user), true);
    assert.equal(shouldKeepChatHistoryRead({ teamsOrigin: { chatId: "x" } }, firstTurn), true);
    assert.equal(shouldKeepChatHistoryRead({ imessageOrigin: { to: "x" } }, followUp), false);
    assert.equal(shouldKeepChatHistoryRead({}, firstTurn), false);
    assert.equal(shouldKeepChatHistoryRead(null, firstTurn), false);
  });
});

describe("ephemeral @agent chats", () => {
  it("marks iMessage and Teams origin chats ephemeral until the app talks", () => {
    assert.equal(shouldPersistChatEphemeral({ imessageOrigin: { to: "x" } }), true);
    assert.equal(shouldPersistChatEphemeral({ teamsOrigin: { chatId: "x" } }), true);
    assert.equal(
      shouldPersistChatEphemeral({
        imessageOrigin: { to: "x" },
        ephemeralPinned: true,
      }),
      false
    );
    assert.equal(shouldPersistChatEphemeral({}), null);
    assert.equal(shouldPersistChatEphemeral(null), null);
  });

  it("pins when the follow-up is from web or iOS, not iMessage or Teams", () => {
    assert.equal(isUiChatClient({ client: "web" }), true);
    assert.equal(isUiChatClient({ client: "ios" }), true);
    assert.equal(isUiChatClient({ client: "imessage" }), false);
    assert.equal(isUiChatClient({ client: "teams" }), false);
    const session = { imessageOrigin: { to: "x" }, ephemeralPinned: false };
    assert.equal(pinEphemeralChatIfUiClient(session, { client: "imessage" }, "sid"), false);
    assert.equal(session.ephemeralPinned, false);
    assert.equal(pinEphemeralChatIfUiClient(session, { client: "web" }, "sid"), true);
    assert.equal(session.ephemeralPinned, true);
    assert.equal(shouldPersistChatEphemeral(session), false);
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

describe("queued turn promote", () => {
  it("pulls the held turn and leaves the rest in order", () => {
    const session = {
      turnQueue: [
        { queueId: "a", bubble: "first", prompt: "p1\n\nUser:\nfirst" },
        { queueId: "b", bubble: "second", prompt: "p2\n\nUser:\nsecond" },
        { queueId: "c", bubble: "third", prompt: "p3\n\nUser:\nthird" },
      ],
    };
    const turn = detachQueuedTurn(session, "b");
    assert.equal(turn.bubble, "second");
    assert.deepEqual(
      session.turnQueue.map((row) => row.queueId),
      ["a", "c"]
    );
    assert.equal(detachQueuedTurn(session, "missing"), null);
    assert.equal(detachQueuedTurn(session, ""), null);
    assert.equal(session.turnQueue.length, 2);
  });

  it("puts the interrupt sentence in front of the user line", () => {
    const prompt = withInterruptNote("Live context\n\nUser:\ncheck the queue");
    assert.match(prompt, /interrupted your previous work/);
    assert.ok(prompt.includes(INTERRUPT_NOTE));
    assert.ok(prompt.indexOf(INTERRUPT_NOTE) < prompt.indexOf("\n\nUser:\n"));
    assert.equal(withInterruptNote(prompt), prompt);
    const bare = withInterruptNote("no user marker");
    assert.match(bare, /interrupted your previous work/);
  });

  it("keeps the Teams reply when an interrupt clarifies an unfinished @agent", () => {
    const session = { teamsDeliverFinal: true, channelReplyOwed: "" };
    const first = {};
    assert.equal(claimChannelDelivery(session, first), "teams");
    assert.equal(first.teamsDeliverFinal, true);
    assert.equal(session.teamsDeliverFinal, false);
    assert.equal(session.channelReplyOwed, "teams");

    assert.equal(restoreOwedChannelDelivery(session), "teams");
    assert.equal(session.teamsDeliverFinal, true);
    const note = interruptClarificationNote(session.channelReplyOwed);
    assert.match(note, /clarification/);
    assert.match(note, /still goes to that Teams chat/);
    const prompt = withInterruptNote(
      "Live context\n\nUser:\nPut me with the other guys",
      "teams"
    );
    assert.match(prompt, /still goes to that Teams chat/);
    assert.ok(prompt.indexOf("still goes to that Teams chat") < prompt.indexOf("\n\nUser:\n"));

    const origin = normalizeTeamsOrigin({
      id: "m1",
      chatId: "19:abc",
      chat: "JYPE",
      text: "@agent make groups",
    });
    const baked = [
      "system",
      formatTeamsOriginBlock(origin, { deliverFinal: false }),
      "User:",
      "Put me with the other guys",
    ].join("\n\n");
    const rewritten = rewritePromptForOwedChannel(baked, "teams");
    assert.doesNotMatch(rewritten, /Do not post it to Teams/);
    assert.doesNotMatch(rewritten, /already got the first reply/);
    assert.match(rewritten, /text that should land in that Teams chat/);
    const handed = {};
    handOffOwedChannel(session, handed);
    assert.equal(handed.teamsDeliverFinal, true);
    assert.equal(session.channelReplyOwed, "teams");
  });

  it("rewrites an iMessage or WhatsApp later-turn prompt the same way", () => {
    const imessage = rewritePromptForOwedChannel(
      formatIMessageOriginBlock(
        normalizeIMessageOrigin({
          text: "@agent hi",
          chat: "Alex",
          chatId: "+15555550111",
          handle: "+15555550111",
        }),
        { deliverFinal: false }
      ),
      "imessage"
    );
    assert.doesNotMatch(imessage, /Do not text it/);
    assert.match(imessage, /text that should land in that iMessage/);
    const whatsapp = rewritePromptForOwedChannel(
      formatWhatsAppOriginBlock(
        normalizeWhatsAppOrigin({
          text: "@agent hi",
          chat: "JYPE",
          chatJid: "123@g.us",
        }),
        { deliverFinal: false }
      ),
      "whatsapp"
    );
    assert.doesNotMatch(whatsapp, /reply stays here/);
    assert.match(whatsapp, /text that should land in that WhatsApp chat/);
  });

  it("snapshots queueId on waiting bubbles", () => {
    const snap = snapshotMessages({
      messages: [stampMessage("user", "hi")],
      turnQueue: [{ bubble: "later", queueId: "q-1" }],
    });
    assert.equal(snap[1].queued, true);
    assert.equal(snap[1].queueId, "q-1");
    assert.equal(snap[1].content, "later");
  });
});

describe("Personal Agent end of turn", () => {
  it("stamps endOfTurn privately and omits it from the client snapshot", () => {
    const eot = stampMessage("assistant", EMPTY_TURN_REPLY, undefined, {
      endOfTurn: true,
    });
    assert.equal(eot.endOfTurn, true);
    assert.equal(eot.content, "Done");
    const withFooter = stampMessage(
      "assistant",
      "Nothing after Spanish.\n\nSent by Yan's Personal Agent"
    );
    assert.equal(withFooter.content, "Nothing after Spanish.");
    const userQuote = stampMessage(
      "user",
      "keep Sent by Yan's Personal Agent in a user quote"
    );
    assert.match(userQuote.content, /Sent by Yan's Personal Agent/);
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

describe("open_education_page navigate payload", () => {
  it("validates views and required ids", () => {
    assert.equal(normalizeEducationNavigate(null), null);
    assert.equal(normalizeEducationNavigate({ view: "fitness" }), null);
    assert.equal(normalizeEducationNavigate({ view: "class" }), null);
    assert.equal(normalizeEducationNavigate({ view: "todo" }), null);
    assert.equal(normalizeEducationNavigate({ view: "capsule", todoId: "brief" }), null);
    assert.equal(normalizeEducationNavigate({ view: "home" })?.view, "home");
    assert.equal(
      normalizeEducationNavigate({ view: "class", classId: "am-lit" })?.classId,
      "am-lit"
    );
    const todo = normalizeEducationNavigate({
      view: "todo",
      todoId: "hw-personal-infographic",
      classId: "data-science-1",
    });
    assert.equal(
      normalizeEducationNavigate({
        view: "case",
        caseId: "us-ought-to-deborder",
        caseSide: "neg",
      })?.caseSide,
      "neg"
    );
    assert.equal(normalizeEducationNavigate({ view: "case" }), null);
  });

  it("builds website hrefs", () => {
    assert.equal(educationNavigateHref({ view: "home" }), "/education/");
    assert.equal(
      educationNavigateHref({ view: "class", classId: "am-lit" }),
      "/education/class/am-lit"
    );
    assert.equal(
      educationNavigateHref({
        view: "todo",
        todoId: "hw-personal-infographic",
        classId: "data-science-1",
      }),
      "/education/todo/hw-personal-infographic?class=data-science-1"
    );
    assert.equal(
      educationNavigateHref({
        view: "todo",
        todoId: "make-public-repo",
        projectId: "yanylevin",
      }),
      "/education/todo/make-public-repo?project=yanylevin"
    );
    assert.equal(
      educationNavigateHref({
        view: "capsule",
        todoId: "2026-09-01-daily-briefing",
        capsuleId: "cap-1",
      }),
      "/education/todo/2026-09-01-daily-briefing/capsule/cap-1"
    );
    assert.equal(
      educationNavigateHref({
        view: "date",
        dateId: "fall-orientation-day-1",
      }),
      "/education/date/fall-orientation-day-1"
    );
    const spanishHref = educationNavigateHref({
      view: "todo",
      todoId: "QA Sep 24 #1 ESCRITO AUDITIVO Otoño 2026",
      classId: "spanish-4",
    });
    assert.equal(spanishHref.includes("#"), false);
    assert.match(spanishHref, /^\/education\/todo\/QA\*20Sep\*2024\*20\*231/);
    assert.match(spanishHref, /\?class=spanish-4$/);
    assert.equal(
      educationNavigateHref({
        view: "case",
        caseId: "us-ought-to-deborder",
        caseSide: "aff",
      }),
      "/debate/case/us-ought-to-deborder/aff"
    );
    assert.equal(educationNavigateHref({ view: "nope" }), null);
  });

  it("queues a jump and publishes it once", () => {
    const session = {};
    const queued = queueEducationNavigate(session, {
      view: "todo",
      todoId: "hw",
      classId: "spanish-4",
    });
    assert.equal(queued?.todoId, "hw");
    assert.equal("id" in (queued || {}), false);
    assert.equal(session.navigate, undefined);
    const first = publishQueuedEducationNavigate(session);
    assert.ok(first?.id);
    assert.equal(first?.view, "todo");
    assert.equal(first?.todoId, "hw");
    assert.equal(session.pendingNavigate, null);
    assert.equal(session.navigate?.id, first?.id);
    assert.equal(publishQueuedEducationNavigate(session), null);
    assert.equal(session.navigate?.id, first?.id);
  });

  it("keeps the last queued page when the tool is called twice", () => {
    const session = {};
    queueEducationNavigate(session, { view: "home" });
    queueEducationNavigate(session, { view: "class", classId: "am-lit" });
    const pub = publishQueuedEducationNavigate(session);
    assert.equal(pub?.view, "class");
    assert.equal(pub?.classId, "am-lit");
  });

  it("keeps navigate off the chat history snapshot", () => {
    const snap = snapshotMessages({
      messages: [stampMessage("assistant", "That essay is due Friday")],
      navigate: {
        id: "nav-1",
        view: "todo",
        todoId: "essay",
        classId: "am-lit",
      },
    });
    assert.equal(snap.length, 1);
    assert.equal(snap[0].content, "That essay is due Friday");
    assert.equal("navigate" in snap[0], false);
    assert.equal(
      JSON.stringify(snap).includes("nav-1"),
      false
    );
  });
});

describe("channel progress replies", () => {
  it("marks mention first turns and skips a duplicate final", () => {
    assert.equal(channelProgressKind({ imessageDeliverFinal: true }), "imessage");
    assert.equal(channelProgressKind({ teamsDeliverFinal: true }), "teams");
    assert.equal(channelProgressKind({ whatsappDeliverFinal: true }), "whatsapp");
    assert.equal(
      channelProgressKind({ imessageDeliverFinal: true, teamsDeliverFinal: true }),
      "imessage"
    );
    assert.equal(channelProgressKind({}), "");
    assert.equal(
      shouldSkipDuplicateChannelSend("Making the page", "Making the page"),
      true
    );
    assert.equal(
      shouldSkipDuplicateChannelSend("Making the page", "Live at https://yanylevin.com/x"),
      false
    );
    assert.equal(shouldSkipDuplicateChannelSend("", "Done"), false);
  });

  it("keeps the turn going when the chat send is rejected", () => {
    const origin = {
      to: "+14255550100",
      chatGuid: "any;-;+14255550100",
    };
    const refused = {
      ok: false,
      failed: true,
      error:
        "no Messages chat for +14255550100. Refusing to text a person with that name.",
    };
    assert.equal(
      nextOutboundAction({ delivery: refused, guidDropped: false, resumes: 0 }),
      "drop-guid"
    );
    assert.equal(dropRejectedChatGuid(origin, refused.error), true);
    assert.equal(origin.chatGuid, "");
    assert.equal(
      nextOutboundAction({ delivery: refused, guidDropped: true, resumes: 0 }),
      "resume"
    );
    assert.equal(
      nextOutboundAction({ delivery: refused, guidDropped: true, resumes: 3 }),
      "give-up"
    );
    assert.equal(
      nextOutboundAction({
        delivery: { ok: true, skipped: "duplicate" },
        guidDropped: true,
        resumes: 1,
      }),
      "done"
    );
    assert.equal(dropRejectedChatGuid(origin, "Messages send timed out"), false);
    const prompt = outboundResumePrompt("imessage", refused.error, "Moved it to Saturday");
    assert.match(prompt, /This turn is not done/);
    assert.match(prompt, /Moved it to Saturday/);
    assert.match(prompt, /leave chatGuid off/);
    assert.equal(
      channelSendToolResult({ ok: false, error: refused.error }),
      `not sent. ${refused.error} This turn is not done until that text is in the chat. Send it again.`
    );
    assert.equal(channelSendToolResult({ ok: true }), "delivered to the chat");
  });

  it("does not take queued files when a progress line is skipped", async () => {
    resetIMessageReplyFiles();
    queueIMessageReplyFiles({ to: "+14255550100" }, ["/tmp/a.jpg"]);
    const empty = await deliverIMessageProgressReply({ to: "+14255550100" }, "   ");
    assert.equal(empty.skipped, "empty");
    const missing = await deliverIMessageProgressReply({}, "Making the Spanish page");
    assert.equal(missing.skipped, "no-target");
    assert.deepEqual(takeIMessageReplyFiles({ to: "+14255550100" }), ["/tmp/a.jpg"]);
  });
});

describe("iMessage final reply delivery", () => {
  it("skips error fallbacks and empty text", async () => {
    const origin = { to: "+14255550100", chat: "Example Friend" };
    const error = await deliverIMessageFinalReply(
      origin,
      "The personal agent hit an error. Try again or use Cursor Desktop with the personal-agent skill."
    );
    assert.equal(error.skipped, "error");
    const empty = await deliverIMessageFinalReply(origin, "   ");
    assert.equal(empty.skipped, "empty");
    const missing = await deliverIMessageFinalReply({}, "On it");
    assert.equal(missing.skipped, "no-target");
  });

  it("drops queued files when the final reply is skipped", async () => {
    resetIMessageReplyFiles();
    queueIMessageReplyFiles({ to: "+14255550100" }, ["/tmp/a.jpg"]);
    const empty = await deliverIMessageFinalReply({ to: "+14255550100" }, "   ");
    assert.equal(empty.skipped, "empty");
    assert.deepEqual(takeIMessageReplyFiles({ to: "+14255550100" }), []);
  });
});

describe("Teams final reply delivery", () => {
  it("skips error fallbacks and empty text", async () => {
    const origin = { chatId: "19:abc", chat: "Alex" };
    const error = await deliverTeamsFinalReply(
      origin,
      "The personal agent hit an error. Try again or use Cursor Desktop with the personal-agent skill."
    );
    assert.equal(error.skipped, "error");
    const empty = await deliverTeamsFinalReply(origin, "   ");
    assert.equal(empty.skipped, "empty");
    const missing = await deliverTeamsFinalReply({}, "On it");
    assert.equal(missing.skipped, "no-target");
  });
});

