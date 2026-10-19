/**
 * Quiz answers, one file per Google account and quiz.
 * Email comes from the session, never from the request body.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeEmail } from "./identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function safeEmail(email) {
  const canonical = canonicalizeEmail(email);
  if (!canonical.includes("@") || /[/\\]|\.\./.test(canonical)) {
    const err = new Error("invalid email");
    err.status = 400;
    throw err;
  }
  return canonical;
}

function safeQuizId(quizId) {
  const id = String(quizId || "");
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) {
    const err = new Error("invalid quiz");
    err.status = 400;
    throw err;
  }
  return id;
}

export function quizAttemptPath(email, quizId) {
  return join(
    ROOT,
    "education",
    safeEmail(email),
    "quiz-attempts",
    `${safeQuizId(quizId)}.json`
  );
}

function cleanAnswers(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, 80) : [];
  return list.map((item, i) => ({
    id: String(item?.id || i + 1).slice(0, 40),
    stem: String(item?.stem || "").slice(0, 300),
    choice: String(item?.choice || "").slice(0, 240),
    correct: Boolean(item?.correct),
  }));
}

export async function readQuizAttempt(email, quizId) {
  const path = quizAttemptPath(email, quizId);
  try {
    const doc = JSON.parse(await readFile(path, "utf8"));
    return doc && typeof doc === "object" ? doc : null;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * @param {string} email
 * @param {{ quizId?: string, answers?: unknown, done?: boolean }} body
 */
export async function saveQuizAttempt(email, body) {
  const quizId = safeQuizId(body?.quizId);
  const path = quizAttemptPath(email, quizId);
  const answers = cleanAnswers(body?.answers);
  const score = answers.filter((item) => item.correct).length;
  const now = new Date().toISOString();
  const canonical = safeEmail(email);

  let history = [];
  try {
    const prev = JSON.parse(await readFile(path, "utf8"));
    if (Array.isArray(prev?.history)) history = prev.history.slice(-19);
  } catch {
    history = [];
  }

  if (body?.done) {
    history.push({
      at: now,
      score,
      total: answers.length,
      answers,
    });
  }

  const doc = {
    quizId,
    email: canonical,
    updatedAt: now,
    score,
    total: answers.length,
    answers,
    history,
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}
