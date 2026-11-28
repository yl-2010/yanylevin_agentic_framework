/**
 * Pure helpers for agent-to-agent mail.
 * No session map, no filesystem, no Cursor SDK.
 */

export const AGENT_MAIL_RULE =
  'You can mail another thread in this same workspace with message_agent. Pass sessionId and text. list_agent_threads returns session ids and titles, including threads hidden from the chat list. A mail is a user bubble. The first line is From "thread title": then a blank line, then the text. The sender session id is in the turn notes, not in the bubble. Answer by calling message_agent back to that session id. If the bubble is already the answer to what you asked, use it and stop. Mail again only when you have a new ask.';

export const ORCHESTRATOR_RULE =
  "You are the orchestrator for this Teams or iMessage chat. Do not do the task. Call start_subagent with the task text. That opens a Subagent thread and mails it. To steer a subagent that is still running, call message_agent on its session id. That interrupts it. You are the only one who posts to that Teams or iMessage chat. Use send_chat_message for a short update. Your final reply on a mention turn is posted by the server. A mail from a subagent is not posted until you call send_chat_message with the line those people should see. Subagents do not post there.";

export const SUBAGENT_RULE =
  "You are a subagent. Do the task in the mail. When you finish, call message_agent on the orchestrator session id from the turn notes. Do not call send_chat_message. Do not run school-teams.js send or sendIMessage. If the new mail is already the answer to what you asked, stop.";

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
