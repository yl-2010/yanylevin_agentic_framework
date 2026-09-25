import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FRIEND_HOURLY_LIMIT,
  GROK_HOURLY,
  GUEST_COMPOSER_SPEC,
  GUEST_FRIEND_COMPOSER_SPEC,
  GUEST_GROK_SPEC,
  AGENTG_DAILY_LIMIT,
  formatAgentgDailyLimitMessage,
  jypeMentionModelSpec,
  HOURLY_LIMIT,
  contactHasHandle,
  dayKey,
  displayGivenName,
  evaluateGuestMention,
  formatGuestUserBubble,
  formatRateLimitMessage,
  formatRetryAt,
  guestRunModels,
  hourKey,
  isFriendGuest,
  phonesMatch,
  platformLabel,
  quotaKeyFor,
  resetGuestAgentCaches,
  resolvePerson,
  describeGuestAudience,
  takeGuestSlot,
  isTeamsClassOf2028Chat,
  isAllowedTeamsClassOf2028Caller,
  withoutFast,
} from "./guest-agent.js";

const PRASHAM = {
  id: "people/alex-rivera",
  kind: "person",
  name: "Alex Rivera",
  fields: {
    aliases: ["Alex"],
    emails: ["friend@school.example"],
    phones: ["+15555550111"],
  },
};

const JEFFERY = {
  id: "people/example-friend",
  kind: "person",
  name: "Example Friend",
  fields: {
    aliases: ["Example Friend"],
    emails: [],
    phones: ["+15555550122"],
  },
};

const EVERETTE = {
  id: "people/example-neighbor",
  kind: "person",
  name: "Example Neighbor",
  fields: {
    aliases: ["Example Neighbor"],
    emails: ["edeng@school.example"],
    phones: ["+15555550133"],
  },
};

const PEOPLE = [PRASHAM, JEFFERY, EVERETTE];

const FIVE_PM = new Date("2026-09-10T17:12:00-07:00");
const SIX_PM = new Date("2026-09-10T18:00:00-07:00");

function contact(first, phones, emails = "") {
  return {
    first,
    last: "Test",
    name: `${first} Test`,
    phones,
    emails,
  };
}

describe("guest-agent helpers", () => {
  it("matches phones on last 10 digits", () => {
    assert.equal(phonesMatch("+15555550111", "555-555-0111"), true);
    assert.equal(phonesMatch("+15555550111", "+15555550999"), false);
  });

  it("matches a contact by phone or email", () => {
    const row = contact("Sam", "+1 555-555-0111", "sam@icloud.com");
    assert.equal(contactHasHandle(row, "+15555550111"), true);
    assert.equal(contactHasHandle(row, "sam@icloud.com"), true);
    assert.equal(contactHasHandle(row, "+15555550999"), false);
  });

  it("resolves a person from phone, email, or full name", () => {
    assert.equal(
      personSlugOf(resolvePerson(PEOPLE, { handle: "+15555550111" })),
      "alex-rivera"
    );
    assert.equal(
      personSlugOf(resolvePerson(PEOPLE, { email: "friend@school.example" })),
      "alex-rivera"
    );
    assert.equal(
      personSlugOf(resolvePerson(PEOPLE, { name: "Example Friend" })),
      "example-friend"
    );
    assert.equal(resolvePerson(PEOPLE, { name: "Nobody" }), null);
  });

  it("uses the given name for the From line", () => {
    assert.equal(
      displayGivenName({ person: PRASHAM, contact: null, fromName: "" }),
      "Alex"
    );
    assert.equal(
      formatGuestUserBubble({
        name: "Alex",
        platform: "iMessage",
        text: "@agent is yan free this afternoon",
      }),
      "From Alex on iMessage:\n\n@agent is yan free this afternoon"
    );
    assert.equal(platformLabel("teams"), "Teams");
    assert.equal(platformLabel("imessage"), "iMessage");
  });

  it("uses Pacific clock hours, not a rolling 60 minutes", () => {
    assert.equal(hourKey(FIVE_PM), "2026-09-10T17");
    assert.equal(hourKey(new Date("2026-09-10T17:59:00-07:00")), "2026-09-10T17");
    assert.equal(hourKey(SIX_PM), "2026-09-10T18");
    assert.equal(dayKey(FIVE_PM), "2026-09-10");
    assert.equal(formatRetryAt(FIVE_PM), "6:00 PM");
    assert.equal(formatRetryAt(new Date("2026-09-10T23:10:00-07:00")), "12:00 AM");
    assert.match(
      formatRateLimitMessage("6:00 PM"),
      /Try again at 6:00 PM\.$/
    );
  });

  it("keys quota by slug when known", () => {
    assert.equal(quotaKeyFor("+15555550111", "alex-rivera"), "alex-rivera");
    assert.equal(quotaKeyFor("+15555550999", ""), "phone:5555550999");
  });

  it("labels 1:1 vs group audience", () => {
    assert.deepEqual(
      describeGuestAudience("imessage", {
        chat: "Sam",
        chatId: "+15555550999",
        handle: "+15555550999",
      }),
      { kind: "dm", threadLabel: "Sam", viewers: [] }
    );
    assert.equal(
      describeGuestAudience("imessage", {
        chat: "JYPE",
        chatId: "chat123",
        handle: "+15555550111",
      }).kind,
      "group"
    );
    const teamsGroup = describeGuestAudience("teams", {
      chat: "Class of 2028",
      chatType: "group",
      members: [
        { name: "Alex Rivera" },
        { name: "Yan Levin" },
        { name: "Sam Classmate" },
      ],
    });
    assert.equal(teamsGroup.kind, "group");
    assert.equal(teamsGroup.threadLabel, "Class of 2028");
    assert.equal(teamsGroup.gradeWide, true);
    assert.deepEqual(teamsGroup.viewers, ["Alex Rivera", "Sam Classmate"]);
    assert.equal(
      describeGuestAudience("teams", {
        chat: "Alex",
        chatType: "oneOnOne",
        members: [{ name: "Alex Rivera" }],
      }).kind,
      "dm"
    );
    assert.equal(
      isTeamsClassOf2028Chat({ chat: "Class of 2028", chatType: "group" }),
      true
    );
    assert.equal(
      isTeamsClassOf2028Chat({ chat: "EPS Class of 2028", chatType: "group" }),
      true
    );
    assert.equal(
      isTeamsClassOf2028Chat({ chat: "Class of 2028", chatType: "oneOnOne" }),
      false
    );
    assert.equal(
      isTeamsClassOf2028Chat({ chat: "JYPE", chatType: "group" }),
      false
    );
    assert.equal(isAllowedTeamsClassOf2028Caller("alex-rivera", ""), true);
    assert.equal(isAllowedTeamsClassOf2028Caller("example-friend", ""), true);
    assert.equal(isAllowedTeamsClassOf2028Caller("example-neighbor", ""), true);
    assert.equal(isAllowedTeamsClassOf2028Caller("", "Example Friend"), true);
    assert.equal(isAllowedTeamsClassOf2028Caller("", "Sam Classmate"), false);
  });
});

function personSlugOf(entity) {
  return entity ? String(entity.id).replace(/^people\//, "") : "";
}

describe("guest-agent limits", () => {
  beforeEach(() => {
    resetGuestAgentCaches();
  });

  it("caps at 10 per clock hour and resets at the next hour", async () => {
    assert.equal(HOURLY_LIMIT, 10);
    const dir = await mkdtemp(join(tmpdir(), "guest-limit-"));
    const statePath = join(dir, "limits.json");
    for (let i = 0; i < HOURLY_LIMIT; i += 1) {
      const slot = await takeGuestSlot({
        platform: "imessage",
        personKey: "sam",
        now: FIVE_PM,
        statePath,
      });
      assert.equal(slot.overHourly, false);
    }
    const blocked = await takeGuestSlot({
      platform: "imessage",
      personKey: "sam",
      now: FIVE_PM,
      statePath,
    });
    assert.equal(blocked.overHourly, true);
    const nextHour = await takeGuestSlot({
      platform: "imessage",
      personKey: "sam",
      now: SIX_PM,
      statePath,
    });
    assert.equal(nextHour.overHourly, false);
    assert.equal(nextHour.hourCount, 1);
  });

  it("keeps iMessage and Teams counters separate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-limit-"));
    const statePath = join(dir, "limits.json");
    for (let i = 0; i < HOURLY_LIMIT; i += 1) {
      await takeGuestSlot({
        platform: "imessage",
        personKey: "alex-rivera",
        slug: "alex-rivera",
        now: FIVE_PM,
        statePath,
      });
    }
    const teams = await takeGuestSlot({
      platform: "teams",
      personKey: "alex-rivera",
      slug: "alex-rivera",
      now: FIVE_PM,
      statePath,
    });
    assert.equal(teams.overHourly, false);
    assert.equal(teams.useGrok, true);
  });

  it("gives Alex Grok for every turn in the hour", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-limit-"));
    const statePath = join(dir, "limits.json");
    const cap = GROK_HOURLY["alex-rivera"];
    assert.equal(cap, FRIEND_HOURLY_LIMIT);
    for (let i = 0; i < cap; i += 1) {
      const slot = await takeGuestSlot({
        platform: "imessage",
        personKey: "alex-rivera",
        slug: "alex-rivera",
        now: FIVE_PM,
        statePath,
      });
      assert.equal(slot.overHourly, false);
      assert.equal(slot.useGrok, true);
    }
    const blocked = await takeGuestSlot({
      platform: "imessage",
      personKey: "alex-rivera",
      slug: "alex-rivera",
      now: FIVE_PM,
      statePath,
    });
    assert.equal(blocked.overHourly, true);
    const nextHour = await takeGuestSlot({
      platform: "imessage",
      personKey: "alex-rivera",
      slug: "alex-rivera",
      now: SIX_PM,
      statePath,
    });
    assert.equal(nextHour.overHourly, false);
    assert.equal(nextHour.useGrok, true);
  });

  it("gives Example Friend and Example Neighbor Grok for half the hourly cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-limit-"));
    const statePath = join(dir, "limits.json");
    const cap = GROK_HOURLY["example-friend"];
    assert.equal(cap, FRIEND_HOURLY_LIMIT / 2);
    /** @type {boolean[]} */
    const grok = [];
    for (let i = 0; i < cap + 1; i += 1) {
      const slot = await takeGuestSlot({
        platform: "teams",
        personKey: "example-friend",
        slug: "example-friend",
        now: FIVE_PM,
        statePath,
      });
      grok.push(slot.useGrok);
    }
    assert.deepEqual(
      grok,
      Array.from({ length: cap }, () => true).concat(false)
    );
    const nextHour = await takeGuestSlot({
      platform: "teams",
      personKey: "example-friend",
      slug: "example-friend",
      now: SIX_PM,
      statePath,
    });
    assert.equal(nextHour.useGrok, true);
    assert.equal(GROK_HOURLY["example-neighbor"], FRIEND_HOURLY_LIMIT / 2);
    assert.equal(GUEST_GROK_SPEC.id, "grok-4.7");
    assert.equal(
      GUEST_GROK_SPEC.params.find((p) => p.id === "fast")?.value,
      "false"
    );
    assert.equal(GUEST_COMPOSER_SPEC.id, "composer-2.5");
    assert.equal(GUEST_COMPOSER_SPEC.params[0].value, "false");
    assert.equal(GUEST_FRIEND_COMPOSER_SPEC.params[0].value, "false");
  });

  it("gives Alex, Example Friend, and Example Neighbor 20 turns per clock hour", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-limit-"));
    const statePath = join(dir, "limits.json");
    assert.equal(FRIEND_HOURLY_LIMIT, 20);
    for (let i = 0; i < FRIEND_HOURLY_LIMIT; i += 1) {
      const slot = await takeGuestSlot({
        platform: "imessage",
        personKey: "alex-rivera",
        slug: "alex-rivera",
        now: FIVE_PM,
        statePath,
      });
      assert.equal(slot.overHourly, false);
    }
    const blocked = await takeGuestSlot({
      platform: "imessage",
      personKey: "alex-rivera",
      slug: "alex-rivera",
      now: FIVE_PM,
      statePath,
    });
    assert.equal(blocked.overHourly, true);
  });

  it("keeps Fast off on Grok and Composer for the three friends", () => {
    assert.equal(isFriendGuest("example-friend", ""), true);
    assert.equal(isFriendGuest("", "Example Neighbor"), true);
    assert.equal(isFriendGuest("", "Sam"), false);
    const grok = withoutFast({
      id: "grok-4.7",
      params: [
        { id: "context", value: "256k" },
        { id: "reasoning_effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
    assert.equal(grok.params.find((p) => p.id === "fast")?.value, "false");
    assert.equal(grok.params.find((p) => p.id === "reasoning_effort")?.value, "high");
    const run = guestRunModels({
      slug: "alex-rivera",
      displayName: "Alex",
      model: GUEST_GROK_SPEC,
    });
    assert.equal(run.preferred.id, "grok-4.7");
    assert.equal(run.preferred.params.find((p) => p.id === "fast")?.value, "false");
    assert.equal(run.fallback.id, "composer-2.5");
    assert.equal(run.fallback.params.find((p) => p.id === "fast")?.value, "false");
  });
});

describe("evaluateGuestMention", () => {
  beforeEach(() => {
    resetGuestAgentCaches();
  });

  it("ignores iMessage senders who are not in Contacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-eval-"));
    const decision = await evaluateGuestMention({
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550999",
        text: "@agent hi",
      },
      contacts: [contact("Sam", "+15555550111")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath: join(dir, "limits.json"),
    });
    assert.equal(decision.action, "ignore");
  });

  it("starts an iMessage guest turn on Composer for a contact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-eval-"));
    const decision = await evaluateGuestMention({
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550999",
        chatId: "+15555550999",
        text: "@agent hi",
        chat: "Sam",
      },
      contacts: [contact("Sam", "+15555550999")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath: join(dir, "limits.json"),
    });
    assert.equal(decision.action, "start");
    assert.equal(decision.caller.displayName, "Sam");
    assert.equal(decision.caller.model.id, "composer-2.5");
    assert.equal(decision.caller.model.params[0].value, "false");
    assert.equal(decision.caller.audience.kind, "dm");
  });

  it("uses Grok for Alex's first iMessage turns and prefixes the name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-eval-"));
    const decision = await evaluateGuestMention({
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550111",
        text: "@agent is yan free this afternoon",
      },
      contacts: [contact("Alex", "+15555550111")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath: join(dir, "limits.json"),
    });
    assert.equal(decision.action, "start");
    assert.equal(decision.caller.slug, "alex-rivera");
    assert.equal(decision.caller.model.id, "grok-4.7");
    assert.equal(
      decision.caller.model.params.find((p) => p.id === "fast")?.value,
      "false"
    );
    assert.equal(
      formatGuestUserBubble({
        name: decision.caller.displayName,
        platform: platformLabel(decision.platform),
        text: "@agent is yan free this afternoon",
      }),
      "From Alex on iMessage:\n\n@agent is yan free this afternoon"
    );
  });

  it("uses Composer for Example Friend after half the hourly Grok cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-eval-"));
    const statePath = join(dir, "limits.json");
    const base = {
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550122",
        text: "@agent hi",
      },
      contacts: [contact("Example Friend", "+15555550122")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    };
    for (let i = 0; i < GROK_HOURLY["example-friend"]; i += 1) {
      assert.equal((await evaluateGuestMention(base)).caller.model.id, "grok-4.7");
    }
    const composer = await evaluateGuestMention(base);
    assert.equal(composer.caller.model.id, "composer-2.5");
    assert.equal(composer.caller.model.params[0].value, "false");
  });

  it("keeps Fast off for Example Friend even without a people-card slug", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-eval-"));
    const decision = await evaluateGuestMention({
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550998",
        text: "@agent hi",
      },
      contacts: [contact("Example Friend", "+15555550998")],
      people: [],
      now: FIVE_PM,
      statePath: join(dir, "limits.json"),
    });
    assert.equal(decision.action, "start");
    assert.equal(decision.caller.model.id, "composer-2.5");
    assert.equal(
      decision.caller.model.params.find((p) => p.id === "fast")?.value,
      "false"
    );
  });

  it("sends a programmatic rate-limit action after the base hourly cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-eval-"));
    const statePath = join(dir, "limits.json");
    const base = {
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550999",
        text: "@agent hi",
      },
      contacts: [contact("Sam", "+15555550999")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    };
    for (let i = 0; i < HOURLY_LIMIT; i += 1) {
      assert.equal((await evaluateGuestMention(base)).action, "start");
    }
    const blocked = await evaluateGuestMention(base);
    assert.equal(blocked.action, "rate-limit");
    assert.equal(
      blocked.text,
      "Your hourly rate limit has been reached. Try again at 6:00 PM."
    );
  });

  it("allows any Teams 1:1 and other Teams groups; Class of 2028 is allowlisted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-eval-"));
    const statePath = join(dir, "limits.json");
    const stranger = await evaluateGuestMention({
      platform: "teams",
      message: {
        fromMe: false,
        from: "Sam Classmate",
        fromEmail: "sam@school.example",
        chatType: "oneOnOne",
        text: "@agent hi",
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(stranger.action, "start");
    assert.equal(stranger.caller.model.id, "composer-2.5");

    const otherGroup = await evaluateGuestMention({
      platform: "teams",
      message: {
        fromMe: false,
        from: "Sam Classmate",
        fromEmail: "sam@school.example",
        chat: "Robotics",
        chatType: "group",
        text: "@agent hi",
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(otherGroup.action, "start");
    assert.equal(otherGroup.caller.audience.kind, "group");
    assert.equal(otherGroup.caller.audience.threadLabel, "Robotics");

    const groupStranger = await evaluateGuestMention({
      platform: "teams",
      message: {
        fromMe: false,
        from: "Sam Classmate",
        fromEmail: "sam@school.example",
        chat: "Class of 2028",
        chatType: "group",
        text: "@agent hi",
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(groupStranger.action, "ignore");

    const groupPrasham = await evaluateGuestMention({
      platform: "teams",
      message: {
        fromMe: false,
        from: "Alex Rivera",
        fromEmail: "friend@school.example",
        chat: "Class of 2028",
        chatType: "group",
        text: "@agent hi",
        members: [{ name: "Alex Rivera" }, { name: "Sam Classmate" }],
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(groupPrasham.action, "start");
    assert.equal(groupPrasham.caller.model.id, "grok-4.7");
    assert.equal(groupPrasham.caller.audience.kind, "group");
    assert.equal(groupPrasham.caller.audience.threadLabel, "Class of 2028");
    assert.equal(groupPrasham.caller.audience.gradeWide, true);
    assert.deepEqual(groupPrasham.caller.audience.viewers, [
      "Alex Rivera",
      "Sam Classmate",
    ]);

    const groupExample Friend = await evaluateGuestMention({
      platform: "teams",
      message: {
        fromMe: false,
        from: "Example Friend",
        chat: "Class of 2028",
        chatType: "group",
        text: "@Agent ping",
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(groupExample Friend.action, "start");
    assert.equal(groupExample Friend.caller.slug, "example-friend");

    const groupExample Neighbor = await evaluateGuestMention({
      platform: "teams",
      message: {
        fromMe: false,
        from: "Example Neighbor",
        fromEmail: "edeng@school.example",
        chat: "Class of 2028",
        chatType: "group",
        text: "@AGENT hi",
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(groupExample Neighbor.action, "start");
    assert.equal(groupExample Neighbor.caller.slug, "example-neighbor");
  });

  it("leaves iMessage Class of 2028 groups alone and does not burn Teams quota on ignores", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-eval-"));
    const statePath = join(dir, "limits.json");
    const imessageGroup = await evaluateGuestMention({
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550999",
        chatId: "chat2028",
        chat: "Class of 2028",
        text: "@agent hi",
      },
      contacts: [contact("Sam", "+15555550999")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(imessageGroup.action, "start");

    const blocked = {
      platform: "teams",
      message: {
        fromMe: false,
        from: "Sam Classmate",
        fromEmail: "sam@school.example",
        chat: "Class of 2028",
        chatType: "group",
        text: "@agent hi",
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    };
    assert.equal((await evaluateGuestMention(blocked)).action, "ignore");
    assert.equal((await evaluateGuestMention(blocked)).action, "ignore");

    const laterDm = await evaluateGuestMention({
      platform: "teams",
      message: {
        fromMe: false,
        from: "Sam Classmate",
        fromEmail: "sam@school.example",
        chat: "Sam",
        chatType: "oneOnOne",
        text: "@agent hi",
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(laterDm.action, "start");
    assert.equal(laterDm.caller.audience.kind, "dm");
  });

  it("does not treat Yan fromMe as a guest", async () => {
    const decision = await evaluateGuestMention({
      platform: "imessage",
      message: { fromMe: true, handle: "+15555550111", text: "@agent" },
      contacts: [contact("Alex", "+15555550111")],
      people: PEOPLE,
      now: FIVE_PM,
    });
    assert.equal(decision.action, "ignore");
  });

  it("sends a rate-limit text without starting an agent", async () => {
    /** @type {object[]} */
    const sent = [];
    const { deliverGuestRateLimit } = await import("./guest-agent.js");
    const result = await deliverGuestRateLimit({
      platform: "imessage",
      message: {
        chat: "Sam",
        chatId: "+15555550999",
        handle: "+15555550999",
        text: "@agent hi",
        chatGuid: "guid-1",
      },
      text: "Your hourly rate limit has been reached. Try again at 6:00 PM.",
      sendIMessage: async (opts) => {
        sent.push(opts);
        return { ok: true };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /hourly rate limit/);
    assert.match(sent[0].text, /Sent by Yan's Personal Agent/);
    assert.equal(sent[0].chatGuid, "guid-1");
  });

  it("gives JYPE thread members unlimited Grok and skips the hourly cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-jype-"));
    const statePath = join(dir, "limits.json");
    const base = {
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550111",
        chatId: "chat-jype",
        chat: "JYPE",
        text: "@agent notes",
      },
      contacts: [contact("Alex", "+15555550111")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    };
    for (let i = 0; i < FRIEND_HOURLY_LIMIT + 3; i += 1) {
      const decision = await evaluateGuestMention(base);
      assert.equal(decision.action, "start");
      assert.equal(decision.caller.model.id, "grok-4.7");
      assert.equal(
        decision.caller.model.params.find((p) => p.id === "fast")?.value,
        "false"
      );
      assert.equal(decision.caller.workspace, "jype");
    }

    const stranger = await evaluateGuestMention({
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550999",
        chatId: "chat-jype",
        chat: "JYPE",
        text: "@agent hi",
      },
      contacts: [contact("Sam", "+15555550999")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(stranger.action, "ignore");
  });

  it("uses Composer 2.5 for the JYPE Teams group and still skips the hourly cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-jype-teams-"));
    const statePath = join(dir, "limits.json");
    assert.equal(jypeMentionModelSpec("teams").id, "composer-2.5");
    assert.equal(jypeMentionModelSpec("imessage").id, "grok-4.7");
    const base = {
      platform: "teams",
      message: {
        fromMe: false,
        from: "Alex Rivera",
        fromEmail: "friend@school.example",
        chat: "JYPE",
        chatType: "group",
        text: "@agent notes",
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    };
    for (let i = 0; i < FRIEND_HOURLY_LIMIT + 3; i += 1) {
      const decision = await evaluateGuestMention(base);
      assert.equal(decision.action, "start");
      assert.equal(decision.caller.model.id, "composer-2.5");
      assert.equal(
        decision.caller.model.params.find((p) => p.id === "fast")?.value,
        "false"
      );
      assert.equal(decision.caller.workspace, "jype");
    }

    const dm = await evaluateGuestMention({
      platform: "teams",
      message: {
        fromMe: false,
        from: "Alex Rivera",
        fromEmail: "friend@school.example",
        chat: "Alex",
        chatType: "oneOnOne",
        text: "@agent hi",
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(dm.action, "start");
    assert.equal(dm.caller.model.id, "grok-4.7");
    assert.equal(dm.caller.workspace, undefined);
  });

  it("starts one Grok run for @agentg and skips the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-agent-grok-"));
    const statePath = join(dir, "limits.json");
    for (let i = 0; i < HOURLY_LIMIT; i += 1) {
      await takeGuestSlot({
        platform: "teams",
        personKey: "alex-rivera",
        slug: "alex-rivera",
        now: FIVE_PM,
        statePath,
      });
    }
    const teamsGroup = await evaluateGuestMention({
      platform: "teams",
      message: {
        fromMe: false,
        from: "Alex Rivera",
        fromEmail: "friend@school.example",
        chat: "JYPE",
        chatType: "group",
        text: "@agentg write the study guide",
      },
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(teamsGroup.action, "start");
    assert.equal(teamsGroup.caller.model.id, "grok-4.7");
    assert.equal(teamsGroup.caller.forceGrok, true);
    assert.equal(teamsGroup.caller.workspace, "jype");
    assert.equal(
      teamsGroup.caller.model.params.find((p) => p.id === "reasoning_effort")?.value,
      "high"
    );
    assert.equal(
      teamsGroup.caller.model.params.find((p) => p.id === "fast")?.value,
      "false"
    );

    const dm = await evaluateGuestMention({
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550111",
        chatId: "+15555550111",
        chat: "Alex",
        text: "hey @agentg",
      },
      contacts: [contact("Alex", "+15555550111")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(dm.action, "start");
    assert.equal(dm.caller.model.id, "grok-4.7");
    assert.equal(dm.caller.workspace, undefined);

    const stranger = await evaluateGuestMention({
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550999",
        chatId: "+15555550999",
        chat: "Sam",
        text: "@agentg hi",
      },
      contacts: [contact("Sam", "+15555550999")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(stranger.action, "start");
    assert.equal(stranger.caller.model.id, "grok-4.7");
    assert.equal(stranger.caller.forceGrok, true);
  });

  it("gives everyone else 5 @agentg turns a day and still applies the hourly cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-agentg-day-"));
    const statePath = join(dir, "limits.json");
    assert.equal(AGENTG_DAILY_LIMIT, 5);
    const sam = {
      id: "people/sam-classmate",
      kind: "person",
      name: "Sam Classmate",
      fields: {
        aliases: ["Sam"],
        emails: ["sam@school.example"],
        phones: ["+15555550999"],
      },
    };
    const people = [...PEOPLE, sam];
    const base = {
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550999",
        chatId: "+15555550999",
        chat: "Sam",
        text: "@agentg hi",
      },
      contacts: [contact("Sam", "+15555550999")],
      people,
      now: FIVE_PM,
      statePath,
    };
    for (let i = 0; i < AGENTG_DAILY_LIMIT; i += 1) {
      const decision = await evaluateGuestMention(base);
      assert.equal(decision.action, "start");
      assert.equal(decision.caller.model.id, "grok-4.7");
      assert.equal(decision.caller.forceGrok, true);
    }
    const blocked = await evaluateGuestMention(base);
    assert.equal(blocked.action, "rate-limit");
    assert.equal(blocked.text, formatAgentgDailyLimitMessage());

    const plain = await evaluateGuestMention({
      ...base,
      message: { ...base.message, text: "@agent hi" },
    });
    assert.equal(plain.action, "start");
    assert.equal(plain.caller.model.id, "composer-2.5");

    const teams = await evaluateGuestMention({
      platform: "teams",
      message: {
        fromMe: false,
        from: "Sam Classmate",
        fromEmail: "sam@school.example",
        chatType: "oneOnOne",
        text: "@agentg hi",
      },
      people,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(teams.action, "rate-limit");
    assert.equal(teams.text, formatAgentgDailyLimitMessage());

    const run = guestRunModels({
      slug: "",
      displayName: "Sam",
      model: GUEST_GROK_SPEC,
      forceGrok: true,
    });
    assert.equal(run.fallback.id, "composer-2.5");
  });

  it("blocks a non-JYPE @agentg on the hourly cap without using a daily credit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-agentg-hour-"));
    const statePath = join(dir, "limits.json");
    for (let i = 0; i < HOURLY_LIMIT; i += 1) {
      await takeGuestSlot({
        platform: "imessage",
        personKey: "phone:5555550999",
        slug: "",
        now: FIVE_PM,
        statePath,
      });
    }
    const blocked = await evaluateGuestMention({
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550999",
        chatId: "+15555550999",
        chat: "Sam",
        text: "@agentg hi",
      },
      contacts: [contact("Sam", "+15555550999")],
      people: PEOPLE,
      now: FIVE_PM,
      statePath,
    });
    assert.equal(blocked.action, "rate-limit");
    assert.match(blocked.text, /hourly rate limit/);
    const nextHour = await evaluateGuestMention({
      platform: "imessage",
      message: {
        fromMe: false,
        handle: "+15555550999",
        chatId: "+15555550999",
        chat: "Sam",
        text: "@agentg hi",
      },
      contacts: [contact("Sam", "+15555550999")],
      people: PEOPLE,
      now: SIX_PM,
      statePath,
    });
    assert.equal(nextHour.action, "start");
    assert.equal(nextHour.caller.model.id, "grok-4.7");
  });
});
