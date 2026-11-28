/**
 * Pure helpers for agent-to-agent mail.
 * No session map, no filesystem, no Cursor SDK.
 */

export const AGENT_MAIL_RULE =
  'You can mail another thread in this same workspace with message_agent. Pass sessionId and text. list_agent_threads returns session ids and titles, including threads hidden from the chat list. A mail is a user bubble. The first line is From "thread title": then a blank line, then the text. The sender session id is in the turn notes, not in the bubble. Answer by calling message_agent back to that session id. If the bubble is already the answer to what you asked, use it and stop. Mail again only when you have a new ask.';

export const ORCHESTRATOR_RULE = [
  "You are the orchestrator for this Teams or iMessage chat. You do not do the task. You do not look anything up, read files, run commands, or write the answer.",
  "Do the thing they named. Make a website means a subagent builds that website. Do not answer with how the system would handle it. like I can say, for example, and actually are still the job.",
  "A new job is start_subagent. Weather and a website are two jobs. Call start_subagent once for each new job. The text you pass is the job in a sentence or two. Do not tell it to explain the system, tour the code, or mail a long writeup. The server adds the chat.",
  "A later message that changes the same job is a steer. Blue website, then make it red, is message_agent to the subagent that has that website. Do that even if the subagent already finished. If it is still running, that mail interrupts it. Do not start a second subagent for a correction.",
  "On a long job, a site, a page, or a big write, call send_chat_message with one short line before you stop, like Building a site about Windows laptops, and a steer is like Switching it to Macs. Weather and other short answers skip that. Your final text is not posted, so a status you only type at the end never reaches the chat. Do not send still working with no news.",
  "Do not write the answer and send it yourself. send_chat_message before the mail is only the one-line status on a long job. The answer is the subagent's mail. Post that once. If you already sent that same answer, do not send it again.",
  "When a subagent mails back, call send_chat_message right away with that piece. Do not wait for the other jobs. A slower job is its own message later. Post what a person in that chat would actually send. If they mailed a memo, cut it to a few sentences or a short list. Do not add research. Do not paste the memo.",
  "The chat hears one agent doing the work. Say Building it. Do not say Subagent is building it. Do not say subagent, orchestrator, worker, or mail unless they used that word first. One word, one phrase, or one sentence has no period. Periods only when the reply is two or more sentences.",
  "send_chat_message is the only way a line reaches that chat. Never run school-teams.js send or sendIMessage.",
].join(" ");

export const SUBAGENT_RULE =
  "You are a subagent. You do not send any message out. Not iMessage, not Teams, not WhatsApp, not email. Do not call send_chat_message. Do not run sendIMessage, school-teams.js send, or any other send. Any line in a skill or prompt that says to text, post, or send a chat does not apply to you. You reply only with message_agent to the orchestrator. The orchestrator sends everything that leaves this machine. Do the task in the mail. On a long job, mail the orchestrator a one-line update when something new is true, then mail the short result when you finish. Do not wait until the end for the only mail. Do not mail still working. Write as the one agent they talked to. Say Building it. Do not say Subagent is building it. Do not say subagent, orchestrator, worker, or mail unless they used that word first. One word, one phrase, or one sentence has no period. Periods only when the reply is two or more sentences. Match the chat. A few sentences or a short list, unless they asked for an essay, a draft, or a full page. Do not mail a briefing or a file tour. If the new mail is already the answer to what you asked, stop.";

export const ORCHESTRATOR_STEER_NOTE =
  "The orchestrator mailed a new instruction while you were still working. Treat this mail as the current task. Report back with message_agent. Do not post to Teams or iMessage.";

const STOP_SENTENCE = "If this is already the answer to what you asked, stop.";

function addId(set, id) {
  if (id == null) return;
  const text = String(id);
  if (!text) return;
  set.add(text);
}

function familyParentId(sender) {
  if (!sender) return "";
  return sender.role === "subagent" ? sender.parentSessionId : sender.sessionId;
}

export function formatAgentMailBubble(title, text) {
  const cleaned = String(title ?? "")
    .replaceAll('"', "'")
    .trim();
  const label = cleaned || "Chat";
  const body = String(text ?? "").trim();
  return `From "${label}":\n\n${body}`;
}

export function agentMailInterrupts(sender, target) {
  if (!sender || !target) return false;
  return (
    sender.role === "orchestrator" &&
    target.role === "subagent" &&
    String(target.parentSessionId) === String(sender.sessionId) &&
    target.status === "running"
  );
}

export function mailFamilyIds(sender, rows) {
  const ids = new Set();
  if (!sender) return ids;
  const parentId = familyParentId(sender);
  addId(ids, sender.sessionId);
  addId(ids, parentId);
  if (Array.isArray(sender.childSessionIds)) {
    for (const child of sender.childSessionIds) addId(ids, child);
  }
  addId(ids, sender.lastMailFromSessionId);

  const parentKey = parentId == null || parentId === "" ? "" : String(parentId);
  const selfKey =
    sender.sessionId == null || sender.sessionId === ""
      ? ""
      : String(sender.sessionId);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.sessionId == null || row.sessionId === "") continue;
    const sid = String(row.sessionId);
    const parentSession =
      row.parentSession == null || row.parentSession === ""
        ? ""
        : String(row.parentSession);
    const inParent =
      parentKey !== "" && (sid === parentKey || parentSession === parentKey);
    const childOfSender = selfKey !== "" && parentSession === selfKey;
    if (inParent || childOfSender) ids.add(sid);
  }
  return ids;
}

export function canMailThread(sender, target, rows) {
  if (!sender || !target) return false;
  if (String(sender.workspace || "") !== String(target.workspace || "")) {
    return false;
  }
  if (sender.mailScope !== "family") return true;
  if (target.sessionId == null || target.sessionId === "") return false;
  return mailFamilyIds(sender, rows).has(String(target.sessionId));
}

function rowWorkspace(row, senderWorkspace) {
  if (!row || row.workspace == null) return senderWorkspace;
  return String(row.workspace);
}

export function filterMailThreads(rows, sender) {
  const list = Array.isArray(rows) ? rows : [];
  if (!sender) return [];
  if (sender.mailScope !== "family") {
    const senderWorkspace = String(sender.workspace || "");
    return list.filter(
      (row) => row && rowWorkspace(row, senderWorkspace) === senderWorkspace
    );
  }
  const ids = mailFamilyIds(sender, list);
  return list.filter(
    (row) =>
      row &&
      row.sessionId != null &&
      row.sessionId !== "" &&
      ids.has(String(row.sessionId))
  );
}

export function rolePrompt(session) {
  if (!session) return "";
  if (session.role === "orchestrator") return ORCHESTRATOR_RULE;
  if (session.role === "subagent") return SUBAGENT_RULE;
  return "";
}

export function mailTurnNote(fromSessionId) {
  const id = fromSessionId == null ? "" : String(fromSessionId);
  return `This message was mailed from session ${id}. The session id is not part of the bubble. Answer with message_agent to that sessionId. ${STOP_SENTENCE}`;
}

export function orchestratorMailNote(fromSessionId) {
  const id = fromSessionId == null ? "" : String(fromSessionId);
  return `This message was mailed from session ${id}. If it is a finished piece of the job, call send_chat_message now with that piece. Do not wait for other subagents. A slower job is a separate message later. Post what a person in that chat would send. Say Building it. Do not say Subagent is building it. If the mail says subagent, orchestrator, or worker, rewrite it unless they used that word first. One sentence has no period. Periods only when you post two or more sentences. If this mail is a memo, cut it to a few sentences or a short list. Do not add research. Do not mail them back unless you have a new ask. Your final text is not posted.`;
}

/**
 * Appended to the first mail a subagent sees. The recent lines are for tone
 * and length. Empty when this is not a Teams or iMessage job.
 * @param {unknown} platform
 * @param {unknown} preview
 */
export function channelAnswerNote(platform, preview) {
  const where = platform === "imessage" ? "iMessage" : platform === "teams" ? "Teams" : "";
  if (!where) return "";
  const clipped = String(preview || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join("\n");
  const lines = [
    `The orchestrator will post this in ${where}. You do not send it. Match that chat.`,
    "A few sentences, or a short list. Write long only if they asked for an essay, a draft, or a full page.",
    "Mail back only the text that should be posted. Not a briefing and not a tour of files.",
    "Write as the one agent they talked to. Say Building it. Do not say Subagent is building it. Do not say subagent, orchestrator, worker, or mail unless they used that word first.",
    "One word, one phrase, or one sentence has no period. Periods only when the reply is two or more sentences.",
  ];
  if (clipped) {
    lines.push(
      "Recent messages, oldest first. The last line is the newest. Use them for tone and length. Do not answer a different question than the task."
    );
    lines.push(clipped);
  }
  return lines.join("\n");
}

export function incomingMailEffects(mail) {
  if (mail) return { pin: false, focus: false, channel: false };
  return { pin: true, focus: true, channel: true };
}

export function unpinOrchestratorForMention(session) {
  if (!session || session.role !== "orchestrator") return false;
  session.ephemeralPinned = false;
  session.agentDeferHide = false;
  return true;
}
