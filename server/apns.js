/**
 * APNs token auth. Alerts, silent dismiss, and Live Activity pushes.
 * The .p8 key stays in server/.env and is never committed.
 */

import { readFile } from "node:fs/promises";
import http2 from "node:http2";
import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import {
  PUSH_CAP_PER_HOUR,
  dropDeviceToken,
  listDevices,
  notePushSent,
  recentPushCount,
  recordDismissed,
} from "./push-devices.js";

const SANDBOX_HOST = "https://api.sandbox.push.apple.com";
const PROD_HOST = "https://api.push.apple.com";

/** @type {Map<string, import('node:http2').ClientHttp2Session>} */
const sessions = new Map();

/** @type {{ jwt: string, exp: number, key: string }|null} */
let cachedJwt = null;

let apnsTs = 0;

export function apnsConfigured() {
  return Boolean(
    process.env.APNS_KEY_ID &&
      process.env.APNS_TEAM_ID &&
      process.env.APNS_KEY_PATH &&
      process.env.APNS_BUNDLE_ID
  );
}

export function nextApnsTimestamp() {
  const now = Math.floor(Date.now() / 1000);
  apnsTs = Math.max(apnsTs + 1, now);
  return apnsTs;
}

async function providerJwt() {
  const keyId = process.env.APNS_KEY_ID || "";
  const teamId = process.env.APNS_TEAM_ID || "";
  const keyPath = process.env.APNS_KEY_PATH || "";
  const cacheKey = `${keyId}:${teamId}:${keyPath}`;
  const now = Date.now();
  if (cachedJwt && cachedJwt.key === cacheKey && cachedJwt.exp > now + 60_000) {
    return cachedJwt.jwt;
  }
  const pem = await readFile(keyPath, "utf8");
  const key = await importPKCS8(pem, "ES256");
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt()
    .sign(key);
  cachedJwt = { jwt, exp: now + 50 * 60 * 1000, key: cacheKey };
  return jwt;
}

/**
 * @param {boolean} sandbox
 */
function sessionFor(sandbox) {
  const host = sandbox ? SANDBOX_HOST : PROD_HOST;
  const current = sessions.get(host);
  if (current && !current.closed && !current.destroyed) return current;
  const client = http2.connect(host);
  client.on("error", (err) => {
    console.error("[apns] session", err.message);
    sessions.delete(host);
  });
  sessions.set(host, client);
  return client;
}

/**
 * @param {{
 *   sandbox: boolean,
 *   token: string,
 *   topic: string,
 *   pushType: string,
 *   priority: number,
 *   collapseId?: string,
 *   expiration?: number,
 *   payload: object,
 * }} opts
 */
export function sendApns(opts) {
  const token = String(opts.token || "").trim().toLowerCase();
  if (!apnsConfigured()) {
    return Promise.resolve({ ok: false, status: 0, reason: "push is not configured on the Mac" });
  }
  if (!/^[0-9a-f]{32,}$/.test(token)) {
    return Promise.resolve({ ok: false, status: 0, reason: "bad device token" });
  }
  return providerJwt().then(
    (jwt) =>
      new Promise((resolve) => {
        const client = sessionFor(Boolean(opts.sandbox));
        const headers = {
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${jwt}`,
          "apns-topic": opts.topic,
          "apns-push-type": opts.pushType,
          "apns-priority": String(opts.priority),
          "apns-expiration": String(opts.expiration ?? 0),
        };
        if (opts.collapseId) headers["apns-collapse-id"] = opts.collapseId;
        const req = client.request(headers);
        const chunks = [];
        req.on("response", (resHeaders) => {
          const status = Number(resHeaders[":status"] || 0);
          req.on("data", (chunk) => chunks.push(chunk));
          req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            let reason = "";
            if (body) {
              try {
                reason = JSON.parse(body).reason || body.slice(0, 180);
              } catch {
                reason = body.slice(0, 180);
              }
            }
            if (status !== 200) {
              console.error("[apns]", status, opts.pushType, reason || "rejected");
            }
            resolve({
              ok: status === 200,
              status,
              reason,
              unregistered: status === 410 || reason === "Unregistered" || reason === "BadDeviceToken",
            });
          });
        });
        req.on("error", (err) => {
          console.error("[apns] request", err.message);
          resolve({ ok: false, status: 0, reason: err.message });
        });
        req.end(JSON.stringify(opts.payload));
      })
  );
}

function bundleId() {
  return process.env.APNS_BUNDLE_ID || "com.example.personalagent";
}

/**
 * Alert every registered device for this account.
 * @param {{ email: string, title: string, body: string, sessionId?: string }} opts
 */
export async function sendAccountAlert(opts) {
  if (!apnsConfigured()) {
    return { ok: false, error: "push is not configured on the Mac" };
  }
  const title = String(opts.title || "").trim().slice(0, 80);
  const body = String(opts.body || "").trim().slice(0, 180);
  if (!title || !body) return { ok: false, error: "title and body are required" };
  const used = await recentPushCount(opts.email);
  if (used >= PUSH_CAP_PER_HOUR) {
    return { ok: false, error: "push cap reached, 8 per hour" };
  }
  const devices = await listDevices(opts.email);
  if (!devices.length) return { ok: false, error: "no registered iPhone or iPad" };
  const id = randomUUID();
  const payload = {
    aps: {
      alert: { title, body },
      sound: "default",
    },
    id,
    sessionId: String(opts.sessionId || ""),
  };
  const topic = bundleId();
  const results = await Promise.all(
    devices.map(async (device) => {
      const result = await sendApns({
        sandbox: Boolean(device.sandbox),
        token: device.token,
        topic,
        pushType: "alert",
        priority: 10,
        collapseId: id,
        expiration: Math.floor(Date.now() / 1000) + 3600,
        payload,
      });
      if (result.unregistered) await dropDeviceToken(opts.email, device.token);
      return result;
    })
  );
  const sent = results.filter((row) => row.ok).length;
  if (!sent) {
    return { ok: false, error: results.find((row) => row.reason)?.reason || "push rejected", id };
  }
  await notePushSent(opts.email);
  return { ok: true, id, sent };
}

/**
 * Ask the other devices to remove one alert.
 * @param {string} email
 * @param {string} id
 * @param {string} [exceptDeviceId]
 */
export async function dismissAlertOnOtherDevices(email, id, exceptDeviceId = "") {
  const { devices } = await recordDismissed(email, id, exceptDeviceId);
  if (!apnsConfigured() || !devices.length) return { ok: true, sent: 0 };
  const payload = {
    aps: { "content-available": 1 },
    dismiss: [id],
  };
  const topic = bundleId();
  const results = await Promise.all(
    devices.map(async (device) => {
      const result = await sendApns({
        sandbox: Boolean(device.sandbox),
        token: device.token,
        topic,
        pushType: "background",
        priority: 5,
        expiration: Math.floor(Date.now() / 1000) + 3600,
        payload,
      });
      if (result.unregistered) await dropDeviceToken(email, device.token);
      return result;
    })
  );
  return { ok: true, sent: results.filter((row) => row.ok).length };
}

/**
 * @param {{
 *   sandbox: boolean,
 *   token: string,
 *   event: 'start'|'update'|'end',
 *   contentState?: object|null,
 *   attributes?: object|null,
 *   staleDate?: number|null,
 *   dismissalDate?: number|null,
 *   alert?: { title: string, body: string }|null,
 * }} opts
 */
export function sendLiveActivity(opts) {
  const timestamp = nextApnsTimestamp();
  /** @type {Record<string, unknown>} */
  const aps = { timestamp, event: opts.event };
  if (opts.contentState) aps["content-state"] = opts.contentState;
  if (opts.event === "start") {
    aps["attributes-type"] = "ClassActivityAttributes";
    aps.attributes = opts.attributes || {};
    if (opts.alert) aps.alert = opts.alert;
  }
  if (opts.staleDate) aps["stale-date"] = opts.staleDate;
  if (opts.event === "end") {
    aps["dismissal-date"] = opts.dismissalDate || timestamp - 60;
  }
  return sendApns({
    sandbox: Boolean(opts.sandbox),
    token: opts.token,
    topic: `${bundleId()}.push-type.liveactivity`,
    pushType: "liveactivity",
    priority: 10,
    expiration: Math.floor(Date.now() / 1000) + 300,
    payload: { aps },
  });
}
