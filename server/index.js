/**
 * Yan Levin personal-site Mac Express API.
 * Pattern matches ExampleCo / ExampleNotes: JWT from Vercel, LM Studio GPT-OSS, Cloudflare Tunnel.
 *
 * Port 3004 — public hostname api.yanylevin.com (own tunnel; never expose :1234).
 */

import express from "express";
import cors from "cors";
import { authConfigured, requireAuth, getAuthConfig } from "./auth.js";
import { probeLmStudio, chatCompletions, getLmStudioConfig } from "./lmstudio.js";
import {
  buildYanSystemPrompt,
  invalidateYanMarkdownCache,
  getKnowledgeStats,
} from "./yan-kb.js";
import { appendChatTurn, isChatLogViewer, readChatLog } from "./chat-log.js";
import { appendLogin, readLoginLog } from "./login-log.js";
import { recordAccountDeletionRequest } from "./account-delete.js";
import { extractClientSignals } from "./client-signals.js";
import { mintVisitorToken } from "./mint.js";
import { finalizeChatTheme } from "./chat-theme.js";
import {
  isEducationUser,
  readEducationTree,
  setTodoDone,
  setCapsuleVote,
  markProjectOpened,
  resolveContextFile,
  sendContextFile,
} from "./education-data.js";
import {
  ingestTokenMatches,
  isYanLocationUser,
  writePhoneLocation,
} from "./phone-location.js";
import { healthTokenMatches, writeHealthDump } from "./phone-health.js";
import { writeLifeStateIntent } from "./life-state-intent.js";
import { startDailyBriefingScheduler } from "./daily-briefing-agent.js";
import { startLocationHistoryScheduler } from "./location-history-agent.js";
import { startLocationEnrichmentScheduler } from "./location-enrichment-agent.js";
import { startContextSynthesisScheduler } from "./context-synthesis-agent.js";
import { startChatTitleRefreshScheduler } from "./chat-title-refresh-agent.js";
import { startLifeStateCleanupScheduler } from "./life-state-cleanup-agent.js";
import { startCanvasSyncScheduler, applyLiveCanvasOverlay, seedLiveCanvasTodoDone, syncCanvasTodoDone, YAN_EMAIL } from "./canvas-sync.js";
import { canonicalizeEmail, isFullAccessEmail, isJypeAccessEmail } from "./identity.js";
import { ingestTokenOk, ingestUsageBatch, usageIndex, usageReport } from "./usage-log.js";
import {
  revealOpenEducationObject,
  syncOnedriveObjectVisibility,
} from "./education-onedrive-visibility.js";
import { startHealthTakeawaysScheduler } from "./health-takeaways-agent.js";
import { startLocationBrainScheduler } from "./location-brain-agent.js";
import { startHealthBrainScheduler } from "./health-brain-agent.js";
import { startFactCheckScheduler } from "./fact-check-agent.js";
import { startLifeStateScheduler } from "./life-state-agent.js";
import { lightsStatePath, startHomeAgentScheduler, vacuumStatePath } from "./home-agent.js";
import { readAgentActions } from "./agent-actions.js";
import { attachEducationEvents } from "./education-events.js";
import {
  startAgent,
  messageAgent,
  promoteQueuedTurn,
  stopAgent,
  getAgentState,
  getActiveAgent,
  getRunningAgents,
  listAgentChats,
  resumeAgent,
  markAgentChatRead,
  startFutureAgentScheduler,
} from "./personal-agent.js";
import {
  listUpcomingFutureAgents,
  publicFutureAgentEntry,
} from "./future-agents.js";
import {
  isFitnessUser,
  readFitnessTree,
  appendFitnessEntries,
  ensureFitnessUser,
} from "./fitness-data.js";
import { attachFitnessEvents } from "./fitness-events.js";
import { startLocalIpc } from "./local-ipc.js";
import { startIMessageAgentMentionScheduler } from "./imessage-agent-mentions.js";
import { startTeamsAgentMentionScheduler } from "./teams-agent-mentions.js";
import { startWhatsAppAgentMentionScheduler } from "./whatsapp-agent-mentions.js";
import { startAppleMailFileScheduler } from "./apple-mail-file.js";
import { startCalendarReconcileScheduler } from "./calendar-memory.js";
import {
  startSchoolMailCalendarScheduler,
  startTeamsChannelCalendarScheduler,
} from "./calendar-on-demand.js";
import {
  startFitnessAgent,
  messageFitnessAgent,
  stopFitnessAgent,
} from "./fitness-agent.js";
import {
  claimHeadline,
  getHeadlineAssignment,
  listHeadlineAssignments,
  startHeadlinesWipeScheduler,
} from "./headlines-activity.js";
import { attachStudyRoutes } from "./study.js";
import { readQuizAttempt, saveQuizAttempt } from "./quiz-attempts.js";

const PORT = Number(process.env.PORT || 3004);
const HOST = process.env.HOST || "0.0.0.0";

const DEFAULT_ORIGINS = [
  "https://yanylevin.com",
  "https://www.yanylevin.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULT_ORIGINS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Very small in-memory rate limit for visitor token minting. */
const tokenHits = new Map();
function rateLimitOk(ip, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const key = ip || "unknown";
  let bucket = tokenHits.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    tokenHits.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

const app = express();
app.set("trust proxy", 1);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const list = allowedOrigins();
      if (list.includes(origin) || list.includes("*")) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);
/** 100mb: education attachments are JSON+base64 (~4/3 wire size); 64MB raw ≈ 86MB on the wire. */
app.use(express.json({ limit: "100mb" }));

app.get("/health", async (_req, res) => {
  const lm = await probeLmStudio();
  const { issuer, audience } = getAuthConfig();
  const kb = getKnowledgeStats();
  res.json({
    ok: true,
    service: "yanylevin-server",
    authConfigured: authConfigured(),
    jwt: { issuer, audience },
    knowledgeBase: kb,
    lmStudio: {
      ok: lm.ok,
      baseUrl: lm.baseUrl,
      model: lm.model,
      modelLoaded: lm.modelLoaded ?? false,
    },
    time: new Date().toISOString(),
  });
});

/**
 * Mint a short-lived visitor JWT for the public FAQ chatbot.
 * Used by local preview and as a fallback when the Vercel bridge is unavailable.
 */
app.get("/api/visitor-token", async (req, res) => {
  try {
    if (!authConfigured()) {
      res.status(503).json({ ok: false, error: "AUTH_SECRET not configured" });
      return;
    }
    const ip = req.ip || req.socket?.remoteAddress || "";
    if (!rateLimitOk(ip)) {
      res.status(429).json({ ok: false, error: "rate limit exceeded" });
      return;
    }
    const token = await mintVisitorToken();
    const { issuer, audience } = getAuthConfig();
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      token,
      expiresIn: 600,
      issuer,
      audience,
    });
  } catch (err) {
    console.error("[/api/visitor-token]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "token mint failed",
    });
  }
});

/**
 * Free-form chat against GPT-OSS for the site chatbot.
 * Requires Bearer JWT. Slim system prompt + per-turn yan.md section retrieval.
 */
app.post("/api/chat", requireAuth, async (req, res) => {
  try {
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ ok: false, error: "messages required" });
      return;
    }
    const safe = messages
      .filter(
        (m) =>
          m &&
          typeof m.role === "string" &&
          typeof m.content === "string" &&
          ["system", "user", "assistant"].includes(m.role)
      )
      .slice(-40)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 16000) }));

    if (!safe.length) {
      res.status(400).json({ ok: false, error: "no valid messages" });
      return;
    }

    // Always ground answers in yan.md — strip client system messages so visitors
    // cannot override the knowledge base / persona.
    const conversation = safe.filter((m) => m.role !== "system");
    if (!conversation.length) {
      res.status(400).json({ ok: false, error: "no user messages" });
      return;
    }

    const baseUi =
      req.body?.uiContext && typeof req.body.uiContext === "object"
        ? req.body.uiContext
        : {};

    const lastUser = [...conversation]
      .reverse()
      .find((m) => m.role === "user");
    const query = typeof lastUser?.content === "string" ? lastUser.content : "";

    const grounded = [
      {
        role: "system",
        content: buildYanSystemPrompt(baseUi, { query }),
      },
      ...conversation,
    ];

    const result = await chatCompletions({
      messages: grounded,
      temperature:
        typeof req.body?.temperature === "number" ? req.body.temperature : 0.4,
      maxTokens:
        typeof req.body?.maxTokens === "number" ? req.body.maxTokens : 2048,
    });

    // Theme updates only when the model emits [[set_theme:…]] (or compatible JSON).
    const applied = finalizeChatTheme(result.content);

    // Audit trail: every user prompt + model reply → data/chat-log.md
    const signals = extractClientSignals(req);
    appendChatTurn({
      messages: conversation,
      assistantContent: applied.content,
      model: result.model,
      ...signals,
    }).catch((err) => console.error("[chat-log]", err));

    /** @type {Record<string, unknown>} */
    const payload = {
      ok: true,
      content: applied.content,
      model: result.model,
      usage: result.usage,
      lmStudio: getLmStudioConfig(),
    };
    if (applied.themeUpdate) {
      payload.themeUpdate = applied.themeUpdate;
    }
    res.json(payload);
  } catch (err) {
    console.error("[/api/chat]", err);
    res.status(502).json({ ok: false, error: err.message || "chat failed" });
  }
});

/**
 * Chat audit log for the gated /dashboard (operator only).
 * Visitor JWTs are rejected — require a full-access email claim.
 */
app.get("/api/chat-log", requireAuth, async (req, res) => {
  try {
    if (!isChatLogViewer(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    const { entries, mtimeMs, size } = await readChatLog();
    // Newest first for the dashboard feed.
    const newestFirst = entries.slice().reverse();

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      count: newestFirst.length,
      mtimeMs,
      size,
      entries: newestFirst,
    });
  } catch (err) {
    console.error("[/api/chat-log]", err);
    res.status(500).json({
      ok: false,
      error: err.message || "chat-log read failed",
    });
  }
});

/**
 * Record a successful Google login (called from Vercel OAuth callback).
 * Email is taken from the JWT — body email is ignored for trust.
 */
app.post("/api/login-log", requireAuth, async (req, res) => {
  try {
    const email = String(req.user?.email || "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) {
      res.status(400).json({ ok: false, error: "email required" });
      return;
    }

    const result = await appendLogin({ email });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, email: result.email, appended: result.appended });
  } catch (err) {
    console.error("[/api/login-log POST]", err);
    res.status(500).json({
      ok: false,
      error: err.message || "login-log append failed",
    });
  }
});

/**
 * Quiz answers for the signed-in Google account.
 * Email is the JWT. The body cannot name a different account.
 */
app.post("/api/education/quiz-attempt", requireAuth, async (req, res) => {
  try {
    const doc = await saveQuizAttempt(req.user?.email, req.body || {});
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      quizId: doc.quizId,
      score: doc.score,
      total: doc.total,
      updatedAt: doc.updatedAt,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[/api/education/quiz-attempt POST]", err);
    res.status(status).json({
      ok: false,
      error: err.message || "quiz save failed",
    });
  }
});

app.get("/api/education/quiz-attempt", requireAuth, async (req, res) => {
  try {
    const quiz = String(req.query?.quiz || "");
    const doc = await readQuizAttempt(req.user?.email, quiz);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, attempt: doc });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[/api/education/quiz-attempt GET]", err);
    res.status(status).json({
      ok: false,
      error: err.message || "quiz read failed",
    });
  }
});

/**
 * App Store account-deletion request (iOS). JWT email must match body email.
 */
app.post("/api/account-delete", requireAuth, async (req, res) => {
  try {
    const email = String(req.user?.email || "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@")) {
      res.status(400).json({ ok: false, error: "email required" });
      return;
    }
    const result = await recordAccountDeletionRequest({ email });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      email: result.email,
      recorded: result.recorded,
      message:
        "Deletion request recorded. Client session should be cleared. Contact you@example.com for education-folder removal.",
    });
  } catch (err) {
    console.error("[/api/account-delete]", err);
    res.status(500).json({
      ok: false,
      error: err.message || "account-delete failed",
    });
  }
});

/**
 * Login audit log for the gated /dashboard (operator only).
 */
app.get("/api/future-agents", requireAuth, async (req, res) => {
  try {
    if (!isChatLogViewer(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    const entries = (await listUpcomingFutureAgents()).map(publicFutureAgentEntry);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, count: entries.length, entries });
  } catch (err) {
    console.error("[/api/future-agents]", err);
    res.status(500).json({
      ok: false,
      error: err.message || "future-agents read failed",
    });
  }
});

app.get("/api/agent-actions", requireAuth, async (req, res) => {
  try {
    if (!isChatLogViewer(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    const { entries, mtimeMs, size } = await readAgentActions({
      lightsPath: lightsStatePath(),
      vacuumPath: vacuumStatePath(),
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      count: entries.length,
      mtimeMs,
      size,
      entries,
    });
  } catch (err) {
    console.error("[/api/agent-actions]", err);
    res.status(500).json({
      ok: false,
      error: err.message || "agent-actions read failed",
    });
  }
});

function requireUsageReader(req, res, next) {
  return requireAuth(req, res, () => {
    if (!isFullAccessEmail(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    next();
  });
}

app.post("/api/usage/ingest", async (req, res) => {
  try {
    if (!ingestTokenOk(req.get("authorization") || "")) {
      requireUsageReader(req, res, async () => {
        try {
          const result = await ingestUsageBatch(req.body || {});
          res.json(result);
        } catch (err) {
          console.error("[/api/usage/ingest]", err);
          res.status(500).json({ ok: false, error: "usage ingest failed" });
        }
      });
      return;
    }
    const result = await ingestUsageBatch(req.body || {});
    res.json(result);
  } catch (err) {
    console.error("[/api/usage/ingest]", err);
    res.status(500).json({ ok: false, error: "usage ingest failed" });
  }
});

app.get("/api/usage/index", requireUsageReader, async (req, res) => {
  try {
    const index = await usageIndex();
    res.setHeader("Cache-Control", "no-store");
    res.json(index);
  } catch (err) {
    console.error("[/api/usage/index]", err);
    res.status(500).json({ ok: false, error: "usage index failed" });
  }
});

app.get("/api/usage/summary", requireUsageReader, async (req, res) => {
  try {
    const report = await usageReport({ ...req.query, limit: 1, offset: 0 });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      range: report.range,
      from: report.from,
      to: report.to,
      summary: report.summary,
      total: report.total,
    });
  } catch (err) {
    console.error("[/api/usage/summary]", err);
    res.status(500).json({ ok: false, error: "usage summary failed" });
  }
});

app.get("/api/usage/prompts", requireUsageReader, async (req, res) => {
  try {
    const report = await usageReport(req.query || {});
    res.setHeader("Cache-Control", "no-store");
    res.json(report);
  } catch (err) {
    console.error("[/api/usage/prompts]", err);
    res.status(500).json({ ok: false, error: "usage prompts failed" });
  }
});

app.get("/api/login-log", requireAuth, async (req, res) => {
  try {
    if (!isChatLogViewer(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    const { entries, mtimeMs, size } = await readLoginLog();
    const newestFirst = entries.slice().reverse();

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      count: newestFirst.length,
      mtimeMs,
      size,
      entries: newestFirst,
    });
  } catch (err) {
    console.error("[/api/login-log GET]", err);
    res.status(500).json({
      ok: false,
      error: err.message || "login-log read failed",
    });
  }
});

/**
 * Education academic OS — gated to the operator.
 * Separate from /api/chat (LM Studio). Local Cursor SDK only.
 */
function requireEducationUser(req, res, next) {
  requireAuth(req, res, () => {
    if (!isEducationUser(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    next();
  });
}

function requireJypeUser(req, res, next) {
  requireAuth(req, res, () => {
    if (!isJypeAccessEmail(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    next();
  });
}

const JYPE_WS = { workspace: "jype" };

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || typeof header !== "string") return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/** iOS session JWT (Yan) or LOCATION_INGEST_TOKEN for an iPhone Shortcut. */
function requireYanLocationWriter(req, res, next) {
  if (ingestTokenMatches(bearerToken(req))) {
    req.locationSource = "shortcut";
    next();
    return;
  }
  requireEducationUser(req, res, () => {
    if (!isYanLocationUser(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    req.locationSource = "ios";
    next();
  });
}

app.post("/api/education/location", requireYanLocationWriter, async (req, res) => {
  try {
    const saved = await writePhoneLocation(req.body, {
      source: req.locationSource,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      latitude: saved.latitude,
      longitude: saved.longitude,
      receivedAt: saved.receivedAt,
    });
  } catch (err) {
    console.error("[/api/education/location]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "location write failed",
    });
  }
});

/** Phone dock Shortcut: LOCATION_INGEST_TOKEN or HEALTH_INGEST_TOKEN, or Yan JWT. */
function requireYanIntentWriter(req, res, next) {
  const token = bearerToken(req);
  if (ingestTokenMatches(token) || healthTokenMatches(token)) {
    req.locationSource = "shortcut";
    next();
    return;
  }
  requireEducationUser(req, res, () => {
    if (!isYanLocationUser(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    req.locationSource = "ios";
    next();
  });
}

/** Phone Shortcuts: dock, unplug, Driving Focus, Tesla Bluetooth. */
app.post("/api/education/life-state-intent", requireYanIntentWriter, async (req, res) => {
  try {
    const saved = await writeLifeStateIntent(req.body);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      received: "yes",
      kind: saved.kind,
      orientation: saved.orientation,
      at: saved.at,
    });
  } catch (err) {
    console.error("[/api/education/life-state-intent]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "intent write failed",
    });
  }
});

/** iPhone Shortcut bearer token, or Yan's session JWT. */
function requireYanHealthWriter(req, res, next) {
  if (healthTokenMatches(bearerToken(req))) {
    req.healthSource = "shortcut";
    next();
    return;
  }
  requireEducationUser(req, res, () => {
    if (!isYanLocationUser(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    req.healthSource = "ios";
    next();
  });
}

app.post("/api/education/health", requireYanHealthWriter, async (req, res) => {
  try {
    const saved = await writeHealthDump(req.body, {
      source: req.healthSource,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, received: "yes", ...saved });
  } catch (err) {
    console.error("[/api/education/health]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "health write failed",
    });
  }
});

const educationTreeCache = new Map();
const educationTreeInflight = new Map();
const EDUCATION_TREE_CACHE_MS = 20_000;
let onedriveVisibilityJob = null;
let onedriveVisibilityFinishedAt = 0;
const ONEDRIVE_VISIBILITY_GAP_MS = 3 * 60_000;

function scheduleOnedriveVisibility(email) {
  if (canonicalizeEmail(email) !== YAN_EMAIL) return;
  if (onedriveVisibilityJob) return;
  if (Date.now() - onedriveVisibilityFinishedAt < ONEDRIVE_VISIBILITY_GAP_MS) return;
  onedriveVisibilityJob = syncOnedriveObjectVisibility(email)
    .catch((err) => console.error("[onedrive-visibility]", err))
    .finally(() => {
      onedriveVisibilityJob = null;
      onedriveVisibilityFinishedAt = Date.now();
    });
}

async function educationDataTree(email) {
  const key = canonicalizeEmail(email);
  const hit = educationTreeCache.get(key);
  if (hit && Date.now() - hit.at < EDUCATION_TREE_CACHE_MS) return hit.tree;
  const pending = educationTreeInflight.get(key);
  if (pending) return pending;
  const job = readEducationTree(email)
    .then((tree) => {
      educationTreeCache.set(key, { at: Date.now(), tree });
      return tree;
    })
    .finally(() => {
      educationTreeInflight.delete(key);
    });
  educationTreeInflight.set(key, job);
  return job;
}

app.get("/api/education/data", requireEducationUser, async (req, res) => {
  try {
    try {
      await revealOpenEducationObject(req.user.email, req.query || {});
    } catch (err) {
      console.error("[onedrive-reveal]", err);
    }
    const tree = await educationDataTree(req.user.email);
    // Finder hide/show walks the same CloudStorage files. Not on every poll.
    scheduleOnedriveVisibility(req.user.email);
    const live = /^(1|true|yes)$/i.test(String(req.query?.live || ""));
    if (canonicalizeEmail(req.user.email) === YAN_EMAIL) {
      await applyLiveCanvasOverlay(tree, { force: live });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...tree });
  } catch (err) {
    console.error("[/api/education/data]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "education data failed",
    });
  }
});

app.get("/api/education/file", requireEducationUser, async (req, res) => {
  try {
    const file = await resolveContextFile(req.user.email, {
      scope: req.query?.scope,
      id: req.query?.id,
      classId: req.query?.classId,
      projectId: req.query?.projectId,
      name: req.query?.name,
      source: req.query?.source,
      path: req.query?.path,
    });
    sendContextFile(res, file);
  } catch (err) {
    console.error("[/api/education/file]", err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "file failed",
      });
    }
  }
});

app.patch(
  "/api/education/todo/:id/done",
  requireEducationUser,
  async (req, res) => {
    try {
      const done = Boolean(req.body?.done);
      const classId =
        req.body?.classId != null && String(req.body.classId).trim() !== ""
          ? String(req.body.classId).trim()
          : req.query?.classId != null && String(req.query.classId).trim() !== ""
            ? String(req.query.classId).trim()
            : null;
      const projectId =
        req.body?.projectId != null && String(req.body.projectId).trim() !== ""
          ? String(req.body.projectId).trim()
          : req.query?.projectId != null &&
              String(req.query.projectId).trim() !== ""
            ? String(req.query.projectId).trim()
            : null;
      const props = await setTodoDone(req.user.email, req.params.id, done, {
        classId,
        projectId,
      });
      if (canonicalizeEmail(req.user.email) === YAN_EMAIL) {
        await seedLiveCanvasTodoDone(props, done);
        syncCanvasTodoDone(props, done).catch((err) =>
          console.error("[canvas-sync] todo done", err)
        );
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        id: req.params.id,
        classId: classId || null,
        projectId: projectId || null,
        todo: props,
      });
    } catch (err) {
      console.error("[/api/education/todo/done]", err);
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "todo update failed",
      });
    }
  }
);

app.post(
  "/api/education/project/:id/opened",
  requireEducationUser,
  async (req, res) => {
    try {
      const result = await markProjectOpened(req.user.email, req.params.id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[/api/education/project/opened]", err);
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "project open failed",
      });
    }
  }
);

app.patch(
  "/api/education/todo/:id/capsule/:capsuleId/vote",
  requireEducationUser,
  async (req, res) => {
    try {
      const classId =
        req.body?.classId != null && String(req.body.classId).trim() !== ""
          ? String(req.body.classId).trim()
          : req.query?.classId != null && String(req.query.classId).trim() !== ""
            ? String(req.query.classId).trim()
            : null;
      const projectId =
        req.body?.projectId != null && String(req.body.projectId).trim() !== ""
          ? String(req.body.projectId).trim()
          : req.query?.projectId != null &&
              String(req.query.projectId).trim() !== ""
            ? String(req.query.projectId).trim()
            : null;
      const vote = Object.prototype.hasOwnProperty.call(req.body || {}, "vote")
        ? req.body.vote
        : null;
      const props = await setCapsuleVote(
        req.user.email,
        req.params.id,
        req.params.capsuleId,
        vote,
        { classId, projectId }
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        id: req.params.id,
        capsuleId: req.params.capsuleId,
        classId: classId || null,
        projectId: projectId || null,
        todo: props,
      });
    } catch (err) {
      console.error("[/api/education/todo/capsule/vote]", err);
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "capsule vote failed",
      });
    }
  }
);

app.get("/api/education/events", requireEducationUser, (req, res) => {
  try {
    attachEducationEvents(req, res, req.user.email);
  } catch (err) {
    console.error("[/api/education/events]", err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "events failed",
      });
    }
  }
});

app.post("/api/education/agent/start", requireEducationUser, async (req, res) => {
  try {
    const result = await startAgent(req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/education/agent/start]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent start failed",
    });
  }
});

app.post(
  "/api/education/agent/message",
  requireEducationUser,
  async (req, res) => {
    try {
      const result = await messageAgent(
        req.body?.sessionId,
        req.user.email,
        req.body?.message,
        req.body?.attachments,
        req.body?.uiContext,
        req.body?.interrupt
      );
      res.setHeader("Cache-Control", "no-store");
      // Async run — returns immediately with status:running; clients poll /state.
      res.status(202).json(result);
    } catch (err) {
      console.error("[/api/education/agent/message]", err);
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "agent message failed",
      });
    }
  }
);

app.post(
  "/api/education/agent/interrupt-queued",
  requireEducationUser,
  async (req, res) => {
    try {
      const result = await promoteQueuedTurn(
        req.body?.sessionId,
        req.user.email,
        req.body?.queueId
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(202).json(result);
    } catch (err) {
      console.error("[/api/education/agent/interrupt-queued]", err);
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "agent interrupt failed",
      });
    }
  }
);

app.get("/api/education/agent/state", requireEducationUser, (req, res) => {
  try {
    const result = getAgentState(req.query?.sessionId, req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/education/agent/state]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent state failed",
    });
  }
});

app.get("/api/education/agent/active", requireEducationUser, (req, res) => {
  try {
    const result = getActiveAgent(req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/education/agent/active]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent active failed",
    });
  }
});

app.get("/api/education/agent/running", requireEducationUser, async (req, res) => {
  try {
    const result = await getRunningAgents(req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/education/agent/running]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent running failed",
    });
  }
});

app.get("/api/education/agent/chats", requireEducationUser, async (req, res) => {
  try {
    const result = await listAgentChats(req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/education/agent/chats]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent chats failed",
    });
  }
});

app.post("/api/education/agent/resume", requireEducationUser, async (req, res) => {
  try {
    const result = await resumeAgent(req.body?.sessionId, req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/education/agent/resume]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent resume failed",
    });
  }
});

app.post("/api/education/agent/read", requireEducationUser, async (req, res) => {
  try {
    const result = await markAgentChatRead(req.body?.sessionId, req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/education/agent/read]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent read failed",
    });
  }
});

app.post("/api/education/agent/stop", requireEducationUser, async (req, res) => {
  try {
    const result = await stopAgent(req.body?.sessionId, req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/education/agent/stop]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent stop failed",
    });
  }
});

app.get("/api/jype/data", requireJypeUser, async (req, res) => {
  try {
    const tree = await readEducationTree(req.user.email, JYPE_WS);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...tree, workspace: "jype" });
  } catch (err) {
    console.error("[/api/jype/data]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "jype data failed",
    });
  }
});

app.get("/api/jype/file", requireJypeUser, async (req, res) => {
  try {
    const file = await resolveContextFile(req.user.email, {
      scope: req.query?.scope,
      id: req.query?.id,
      classId: req.query?.classId,
      projectId: req.query?.projectId,
      name: req.query?.name,
      source: req.query?.source,
      path: req.query?.path,
      workspace: "jype",
    });
    sendContextFile(res, file);
  } catch (err) {
    console.error("[/api/jype/file]", err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "file failed",
      });
    }
  }
});

app.patch("/api/jype/todo/:id/done", requireJypeUser, async (req, res) => {
  try {
    const done = Boolean(req.body?.done);
    const classId =
      req.body?.classId != null && String(req.body.classId).trim() !== ""
        ? String(req.body.classId).trim()
        : req.query?.classId != null && String(req.query.classId).trim() !== ""
          ? String(req.query.classId).trim()
          : null;
    const projectId =
      req.body?.projectId != null && String(req.body.projectId).trim() !== ""
        ? String(req.body.projectId).trim()
        : req.query?.projectId != null && String(req.query.projectId).trim() !== ""
          ? String(req.query.projectId).trim()
          : null;
    const props = await setTodoDone(req.user.email, req.params.id, done, {
      classId,
      projectId,
      workspace: "jype",
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      id: req.params.id,
      classId: classId || null,
      projectId: projectId || null,
      todo: props,
    });
  } catch (err) {
    console.error("[/api/jype/todo/done]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "todo update failed",
    });
  }
});

app.post("/api/jype/project/:id/opened", requireJypeUser, async (req, res) => {
  try {
    const result = await markProjectOpened(req.user.email, req.params.id, JYPE_WS);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/jype/project/opened]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "project open failed",
    });
  }
});

app.patch(
  "/api/jype/todo/:id/capsule/:capsuleId/vote",
  requireJypeUser,
  async (req, res) => {
    try {
      const classId =
        req.body?.classId != null && String(req.body.classId).trim() !== ""
          ? String(req.body.classId).trim()
          : req.query?.classId != null && String(req.query.classId).trim() !== ""
            ? String(req.query.classId).trim()
            : null;
      const projectId =
        req.body?.projectId != null && String(req.body.projectId).trim() !== ""
          ? String(req.body.projectId).trim()
          : req.query?.projectId != null &&
              String(req.query.projectId).trim() !== ""
            ? String(req.query.projectId).trim()
            : null;
      const vote = Object.prototype.hasOwnProperty.call(req.body || {}, "vote")
        ? req.body.vote
        : null;
      const props = await setCapsuleVote(
        req.user.email,
        req.params.id,
        req.params.capsuleId,
        vote,
        { classId, projectId, workspace: "jype" }
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        id: req.params.id,
        capsuleId: req.params.capsuleId,
        classId: classId || null,
        projectId: projectId || null,
        todo: props,
      });
    } catch (err) {
      console.error("[/api/jype/todo/capsule/vote]", err);
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "capsule vote failed",
      });
    }
  }
);

app.get("/api/jype/events", requireJypeUser, (req, res) => {
  try {
    attachEducationEvents(req, res, req.user.email, JYPE_WS);
  } catch (err) {
    console.error("[/api/jype/events]", err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "events failed",
      });
    }
  }
});

app.post("/api/jype/agent/start", requireJypeUser, async (req, res) => {
  try {
    const result = await startAgent(req.user.email, JYPE_WS);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/jype/agent/start]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent start failed",
    });
  }
});

app.post("/api/jype/agent/message", requireJypeUser, async (req, res) => {
  try {
    const result = await messageAgent(
      req.body?.sessionId,
      req.user.email,
      req.body?.message,
      req.body?.attachments,
      req.body?.uiContext,
      req.body?.interrupt
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(202).json(result);
  } catch (err) {
    console.error("[/api/jype/agent/message]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent message failed",
    });
  }
});

app.post("/api/jype/agent/interrupt-queued", requireJypeUser, async (req, res) => {
  try {
    const result = await promoteQueuedTurn(
      req.body?.sessionId,
      req.user.email,
      req.body?.queueId
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(202).json(result);
  } catch (err) {
    console.error("[/api/jype/agent/interrupt-queued]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent interrupt failed",
    });
  }
});

app.get("/api/jype/agent/state", requireJypeUser, (req, res) => {
  try {
    const result = getAgentState(req.query?.sessionId, req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/jype/agent/state]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent state failed",
    });
  }
});

app.get("/api/jype/agent/active", requireJypeUser, (req, res) => {
  try {
    const result = getActiveAgent(req.user.email, JYPE_WS);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/jype/agent/active]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent active failed",
    });
  }
});

app.get("/api/jype/agent/running", requireJypeUser, async (req, res) => {
  try {
    const result = await getRunningAgents(req.user.email, JYPE_WS);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/jype/agent/running]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent running failed",
    });
  }
});

app.get("/api/jype/agent/chats", requireJypeUser, async (req, res) => {
  try {
    const result = await listAgentChats(req.user.email, JYPE_WS);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/jype/agent/chats]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent chats failed",
    });
  }
});

app.post("/api/jype/agent/resume", requireJypeUser, async (req, res) => {
  try {
    const result = await resumeAgent(req.body?.sessionId, req.user.email, JYPE_WS);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/jype/agent/resume]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent resume failed",
    });
  }
});

app.post("/api/jype/agent/read", requireJypeUser, async (req, res) => {
  try {
    const result = await markAgentChatRead(
      req.body?.sessionId,
      req.user.email,
      JYPE_WS
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/jype/agent/read]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent read failed",
    });
  }
});

app.post("/api/jype/agent/stop", requireJypeUser, async (req, res) => {
  try {
    const result = await stopAgent(req.body?.sessionId, req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/jype/agent/stop]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent stop failed",
    });
  }
});

/**
 * Fitness / gym — gated to the operator (same full-access set).
 */
function requireFitnessUser(req, res, next) {
  requireAuth(req, res, () => {
    if (!isFitnessUser(req.user?.email)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    next();
  });
}

app.get("/api/fitness/data", requireFitnessUser, async (req, res) => {
  try {
    await ensureFitnessUser(req.user.email);
    const tree = await readFitnessTree(req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...tree });
  } catch (err) {
    console.error("[/api/fitness/data]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "fitness data failed",
    });
  }
});

app.post("/api/fitness/entries", requireFitnessUser, async (req, res) => {
  try {
    const machineId = String(req.body?.machineId || "").trim();
    let weights = req.body?.weights;
    if (!Array.isArray(weights) && req.body?.weight != null) {
      weights = [req.body.weight];
    }
    const result = await appendFitnessEntries(
      req.user.email,
      machineId,
      weights,
      { at: req.body?.at }
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/fitness/entries]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "fitness entry failed",
    });
  }
});

app.get("/api/fitness/events", requireFitnessUser, (req, res) => {
  try {
    attachFitnessEvents(req, res, req.user.email);
  } catch (err) {
    console.error("[/api/fitness/events]", err);
    if (!res.headersSent) {
      res.status(err.status || 500).json({
        ok: false,
        error: err.message || "events failed",
      });
    }
  }
});

app.post("/api/fitness/agent/start", requireFitnessUser, async (req, res) => {
  try {
    const result = await startFitnessAgent(req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[/api/fitness/agent/start]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent start failed",
    });
  }
});

app.post("/api/fitness/agent/message", requireFitnessUser, async (req, res) => {
  try {
    const result = await messageFitnessAgent(
      req.body?.sessionId,
      req.user.email,
      req.body?.message,
      {
        machineId: req.body?.machineId,
        machineName: req.body?.machineName,
      }
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/fitness/agent/message]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent message failed",
    });
  }
});

app.post("/api/fitness/agent/stop", requireFitnessUser, async (req, res) => {
  try {
    const result = await stopFitnessAgent(req.body?.sessionId, req.user.email);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[/api/fitness/agent/stop]", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "agent stop failed",
    });
  }
});

app.post("/api/headlines/claim", async (req, res) => {
  try {
    const payload = await claimHeadline(req.body?.name);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...payload });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[/api/headlines/claim]", err);
    res.status(status).json({
      ok: false,
      error: err.message || "claim failed",
    });
  }
});

app.get("/api/headlines/assignment", async (req, res) => {
  try {
    const payload = await getHeadlineAssignment(req.query?.name);
    res.setHeader("Cache-Control", "no-store");
    if (!payload) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }
    res.json({ ok: true, ...payload });
  } catch (err) {
    console.error("[/api/headlines/assignment]", err);
    res.status(500).json({ ok: false, error: err.message || "lookup failed" });
  }
});

app.get("/api/headlines/assignments", async (_req, res) => {
  try {
    const assignments = await listHeadlineAssignments();
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, assignments });
  } catch (err) {
    console.error("[/api/headlines/assignments]", err);
    res.status(500).json({
      ok: false,
      error: err.message || "list failed",
    });
  }
});

attachStudyRoutes(app);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "not found" });
});

  startDailyBriefingScheduler();
  startLocationHistoryScheduler();
  startLocationEnrichmentScheduler();
  startHealthTakeawaysScheduler();
  startCanvasSyncScheduler();
  startChatTitleRefreshScheduler();
  startLifeStateCleanupScheduler();
  startContextSynthesisScheduler();
  startLocationBrainScheduler();
  startHealthBrainScheduler();
  startFactCheckScheduler();
  startLifeStateScheduler();
  startHomeAgentScheduler();
  startLocalIpc();
  startIMessageAgentMentionScheduler();
  startTeamsAgentMentionScheduler();
  startWhatsAppAgentMentionScheduler();
  startFutureAgentScheduler();
  startAppleMailFileScheduler();
  startCalendarReconcileScheduler();
  startSchoolMailCalendarScheduler();
  startTeamsChannelCalendarScheduler();
  startHeadlinesWipeScheduler();
});

