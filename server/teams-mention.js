/**
 * Detect Teams chat texts that mention @agent / @Agent.
 * Yan fromMe and guest (1:1 and group chats) share the token gate.
 * Who may start a session is the poller's job.
 */

import {
  AGENT_SENT_FOOTER,
  guestCallerLines,
  AGENT_VS_YAN_LINE,
  isBareAgentMention,
  isJypeThread,
  messageMentionsAgent,
  stripAgentSentFooter,
} from "./imessage-mention.js";
import { SCHOOL_EMAIL } from "./school-mail.js";

const FOOTER_RE = new RegExp(
  AGENT_SENT_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "i"
);

function clip(raw, max = 200) {
  return String(raw || "").trim().slice(0, max);
}

/**
 * @param {object|null|undefined} message
 */
export function teamsMessageKey(message) {
  const id = clip(message?.id, 120);
  const chatId = clip(message?.chatId, 120);
  if (id && chatId) return `teams:${chatId}:${id}`;
  if (id) return `teams:${id}`;
  return "";
}

/**
 * @param {object|null|undefined} message
 */
export function shouldTriggerTeamsAgent(message) {
  if (!message || typeof message !== "object") return false;
  const type = String(message.messageType || "message").trim().toLowerCase();
  if (type && type !== "message") return false;
  const text = String(message.text || "").trim();
  if (!text) return false;
  if (FOOTER_RE.test(text)) return false;
  return messageMentionsAgent(text);
}

/**
 * @param {object|null|undefined} message
 */
export function normalizeTeamsOrigin(message) {
  if (!message || typeof message !== "object") return null;
  const chat = clip(message.chat, 80);
  const chatId = clip(message.chatId, 200);
  if (!chatId && !chat) return null;
  return {
    to: chatId || chat,
    chat,
    chatId,
    key: teamsMessageKey(message),
    text: String(message.text || "").trim().slice(0, 10_000),
    fromEmail: clip(
      message.fromEmail || (message.fromMe === true ? SCHOOL_EMAIL : ""),
      80
    ),
  };
}

/**
 * Live-context block for a session started from a Teams @agent mention.
 * @param {object|null|undefined} origin
 * @param {{ deliverFinal?: boolean, guestCaller?: object|null }} [opts]
 */
export function formatTeamsOriginBlock(origin, opts = {}) {
  if (!origin || typeof origin !== "object") return "";
  const chat = String(origin.chat || "").trim();
  const chatId = String(origin.chatId || origin.to || "").trim();
  const bare = isBareAgentMention(origin.text);
  const threadLimit = bare ? 80 : 40;
  const chatArg = chatId || chat;
  const guestLines = guestCallerLines(opts.guestCaller, "Teams");
  const deliver = opts.deliverFinal !== false;
  const footerPhrase = "// Sent by Yan's Personal Agent";
  const lines = [
    guestLines.length
      ? guestLines[0]
      : "Called from Teams. This Personal Agent chat is otherwise normal (app and website bubbles, send_chat_message, tools).",
    ...guestLines.slice(1),
    `- Teams chat: ${chat || "?"}${chatId && chatId !== chat ? ` (${chatId})` : ""}`,
  ];
  const threadCmd = `node server/school-teams.js thread --chat ${JSON.stringify(chatArg)} --limit ${threadLimit}`;
  const speakerLine =
    `Each row in that thread has its own speaker. That field is who wrote the text. The chat name is the group, not the author. Do not attribute one person's message to someone else, including the person who just called @agent. Check speaker before you say they said it. ${AGENT_VS_YAN_LINE}`;
  if (deliver) {
    if (chatId) lines.push(`- send replies to chat id: ${chatId}`);
    if (bare) {
      lines.push(
        "The user message is only @agent. That is not the task. Read the surrounding Teams thread first, then infer why they called you and what to do from the recent messages (a question someone asked, a plan, a thing they want handled). Do not reply asking what they want unless the thread is empty or you truly cannot tell."
      );
    }
    lines.push(
      `Read the surrounding thread before answering: ${threadCmd} (school Teams skill).`,
      speakerLine,
      "school-teams.js cannot attach a file. When the job is to get a PDF or other file into this Teams chat, open the Teams app and attach it with computer use (personal-computer skill). Do not paste a file path into the chat. Do not email it instead. School Outlook still cannot send. An images field on a message has no pixels. Open that chat in the Teams app and look.",
      "The app and website thread is a normal Personal Agent chat.",
      `Write the final bubble as the text that should land in that Teams chat. Markdown is fine, same as the app bubble (bold, italic, lists, links, headings, code). Use it. A list, bold on the key fact, or a short heading when several points would otherwise sit in one paragraph. The server converts it to Teams HTML so desktop and mobile keep newlines and formatting. Teams does not render KaTeX. Write equations in plain words, not $$. No HTML tags, no @agent. The app and website keep that final bubble as the end of the turn (the answer or what you did). Do not write Sent on Teams. Do not add ${footerPhrase}. The server appends that footer on the Teams message only, never in the app or website thread.`,
      "Keep the reply that lands in this chat short. A few sentences, or a short list. Answer and stop. Write at length only when they asked for a lot of text, such as an essay, a full explanation, or a drafted message. A study guide or plan still goes on a page. This chat gets the URL and one line.",
      "On a long job, call send_chat_message with one short line of what you are about to do before you start the work. A new page, a study guide, or a big write counts. @agent and @agentg both do this. That message is posted to this Teams chat immediately. Markdown is fine on that line. Then do the work. Send another the same way only when this chat should hear something new. Do not send still working with no news. Quick answers stay one message, so skip send_chat_message. The server still sends your final bubble when you are done. Do not also send_chat_message that same final text.",
      "The server delivers your final bubble to that same Teams chat. Do not also school-teams send that same final text."
    );
  } else {
    if (chatId) {
      lines.push(`- Teams chat id if they ask you to post there: ${chatId}`);
    }
    lines.push(
      "This turn is on the website or app. The reply stays in this chat. Do not post it to Teams. Do not run school-teams.js send. send_chat_message stays in the app and website only.",
      "Post to that Teams chat only when this message asks you to tell that chat, reply there, or send something those people should see. A follow-up on the same topic, typed here, stays here. The group already got the first reply.",
      `If this message is about what was said in that Teams chat, read it first: ${threadCmd} (school Teams skill).`,
      speakerLine,
      "school-teams.js cannot attach a file. When they ask you to get a PDF or other file to someone on Teams, open the Teams app and attach it with computer use (personal-computer skill). Do not paste a file path into Teams. Do not email it instead. School Outlook still cannot send. An images field on a message has no pixels. Open that chat in the Teams app and look."
    );
  }
  return lines.join("\n");
}

/** JYPE Teams group. Composer 2.5 answers @agent here. @agentg stays on Grok. */
export const JYPE_TEAMS_CHAT_ID =
  "19:5b03f2304dff426d95ebda79495d479a@thread.v2";

/**
 * Yan, 2026-10-01 JYPE Teams. Composer in this chat kept using Yan's bells
 * for other members. Grok does not get this line.
 * @param {{ id?: string }|null|undefined} model
 * @param {object|null|undefined} origin
 */
export function jypeComposerScheduleLine(model, origin) {
  if (String(model?.id || "") !== "composer-2.5") return "";
  if (!origin || typeof origin !== "object") return "";
  const chat = String(origin.chat || "");
  const chatId = String(origin.chatId || origin.to || "");
  if (!isJypeThread(chat) && chatId !== JYPE_TEAMS_CHAT_ID) return "";
  return [
    "When Composer 2.5 answers in this JYPE Teams chat, Live context bells are Yan's.",
    "Before you name a class time, alarm, or tomorrow for anyone in the thread, open that person's roster and that date's rotation.",
    "Files: people/<slug>/schedule.md and education/<email>/schedule.json.",
    "Alex is alex-rivera / you@example.com. Example Friend is example-friend / friend@example.com. Example Neighbor is example-neighbor / neighbor@example.com.",
    "Spanish at 8:30 only when that person's D block is first that day.",
  ].join(" ");
}

export { stripAgentSentFooter };
