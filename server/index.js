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
import { startDailyBriefingScheduler } from "./daily-briefing-agent.js";
import { startLocationHistoryScheduler } from "./location-history-agent.js";
import { startLocationEnrichmentScheduler } from "./location-enrichment-agent.js";
import { startContextSynthesisScheduler } from "./context-synthesis-agent.js";
import { startChatTitleRefreshScheduler } from "./chat-title-refresh-agent.js";
import { startCanvasSyncScheduler } from "./canvas-sync.js";
import { startHealthTakeawaysScheduler } from "./health-takeaways-agent.js";
import { startLocationBrainScheduler } from "./location-brain-agent.js";
import { startHealthBrainScheduler } from "./health-brain-agent.js";
import { startFactCheckScheduler } from "./fact-check-agent.js";
import { attachEducationEvents } from "./education-events.js";
import {
  startAgent,
  messageAgent,
  stopAgent,
  getAgentState,
  getActiveAgent,
  listAgentChats,
  resumeAgent,
  markAgentChatRead,
} from "./personal-agent.js";
import {
  isFitnessUser,
  readFitnessTree,
  appendFitnessEntries,
  ensureFitnessUser,
} from "./fitness-data.js";
import { attachFitnessEvents } from "./fitness-events.js";
import { startLocalIpc } from "./local-ipc.js";
import {
  startFitnessAgent,
  messageFitnessAgent,
  stopFitnessAgent,
} from "./fitness-agent.js";

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
/** 40mb: education attachments are JSON+base64 (~4/3 wire size); see personal-agent caps. */
app.use(express.json({ limit: "40mb" }));

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

app.get("/api/education/data", requireEducationUser, async (req, res) => {
  try {
    const tree = await readEducationTree(req.user.email);
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

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "not found" });
});

  startDailyBriefingScheduler();
  startLocationHistoryScheduler();
  startLocationEnrichmentScheduler();
  startHealthTakeawaysScheduler();
  startCanvasSyncScheduler();
  startChatTitleRefreshScheduler();
  startContextSynthesisScheduler();
  startLocationBrainScheduler();
  startHealthBrainScheduler();
  startFactCheckScheduler();
  startLocalIpc();
});

