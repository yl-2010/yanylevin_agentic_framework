import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addDateKeyDays,
  applyDumpClock,
  contactHandleNames,
  dateKeyWeekday,
  formatAtLocal,
  givenName,
  isoUtcFromDumpAt,
  phoneDigits,
  prettyDateKey,
  speakerLabel,
  weekDateHelper,
} from "./local-clock.js";

describe("dump clocks", () => {
  it("treats sqlite datetime as UTC and stamps Pacific atLocal", () => {
    const iso = isoUtcFromDumpAt("2026-08-24 06:33:25");
    assert.equal(iso, "2026-08-24T06:33:25.000Z");
    assert.equal(formatAtLocal(iso), "Sun Aug 23, 11:33 PM PT");
    assert.equal(formatAtLocal("2026-08-24 06:33:25"), "Sun Aug 23, 11:33 PM PT");
  });

  it("keeps ISO with Z as UTC", () => {
    assert.equal(
      isoUtcFromDumpAt("2026-09-11T02:15:00.000Z"),
      "2026-09-11T02:15:00.000Z"
    );
    assert.equal(formatAtLocal("2026-09-11T02:15:00.000Z"), "Thu Sep 10, 7:15 PM PT");
  });
});

describe("speaker labels", () => {
  it("credits Yan on fromMe even when handle is the other person", () => {
    assert.equal(
      speakerLabel({
        fromMe: true,
        handle: "+12066976688",
        chat: "Nikita Vidolova",
        who: "yan",
      }),
      "Yan"
    );
  });

  it("uses the 1:1 chat given name for inbound them", () => {
    assert.equal(
      speakerLabel({
        fromMe: false,
        who: "them",
        chat: "Nikita Vidolova",
        handle: "+12066976688",
      }),
      "Nikita"
    );
  });

  it("resolves group handles through contacts, not the chat title", () => {
    const names = contactHandleNames([
      { first: "Alex", name: "Alex Rivera", phones: "(425) 326-0143" },
    ]);
    assert.equal(phoneDigits("+14253260143"), "14253260143");
    assert.equal(
      speakerLabel(
        {
          fromMe: false,
          who: "+14253260143",
          chat: "JYPE",
          handle: "+14253260143",
        },
        names
      ),
      "Alex"
    );
  });

  it("uses Teams from display name", () => {
    assert.equal(
      speakerLabel({
        fromMe: false,
        from: "Alex Rivera",
        fromEmail: "friend@school.example",
        chat: "JYPE",
      }),
      "Alex"
    );
    assert.equal(
      speakerLabel({
        fromMe: true,
        from: "Yan Levin",
        chat: "Alex",
      }),
      "Yan"
    );
    assert.equal(
      speakerLabel({
        fromMe: true,
        from: "Yan Levin",
        chat: "JYPE",
        text: "Calc is limits.\n\n// Sent by Yan's Personal Agent",
      }),
      "Agent"
    );
  });

  it("title-cases an email local-part", () => {
    assert.equal(givenName("adi_levin@icloud.com"), "Adi");
  });
});

describe("applyDumpClock", () => {
  it("stamps at, atLocal, and speaker", () => {
    const msg = applyDumpClock({
      at: "2026-09-11 02:15:00",
      fromMe: false,
      who: "them",
      chat: "Adi Levin",
      handle: "+1425",
    });
    assert.equal(msg.at, "2026-09-11T02:15:00.000Z");
    assert.equal(msg.atLocal, "Thu Sep 10, 7:15 PM PT");
    assert.equal(msg.speaker, "Adi");
    assert.equal(msg.fromAgent, false);
  });

  it("marks an agent footer as speaker Agent even when fromMe", () => {
    const msg = applyDumpClock({
      at: "2026-10-12T18:00:00.000Z",
      fromMe: true,
      from: "Yan Levin",
      chat: "JYPE",
      text: "Do the verbs first.\n\n// Sent by Yan's Personal Agent",
    });
    assert.equal(msg.fromAgent, true);
    assert.equal(msg.speaker, "Agent");
    assert.equal(msg.fromMe, true);
  });
});

describe("week date helper", () => {
  it("names today, yesterday, and this week's days", () => {
    assert.equal(dateKeyWeekday("2026-09-11"), "Friday");
    assert.equal(prettyDateKey("2026-09-11", { year: true }), "Friday Sep 11, 2026");
    assert.equal(addDateKeyDays("2026-09-11", -1), "2026-09-10");
    const text = weekDateHelper("2026-09-11", "America/Los_Angeles");
    assert.match(text, /Friday Sep 11, 2026/);
    assert.match(text, /Thursday Sep 10 \(yesterday\)/);
    assert.match(text, /Friday Sep 11 \(today\)/);
    assert.match(text, /Sunday Sep 13/);
    assert.match(text, /Thursday this week/);
  });
});
