/**
 * SSE live updates when fitness/<email>/** changes.
 */

import { watch } from "node:fs";
import { userFitnessRoot } from "./fitness-data.js";

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} email
 */
export function attachFitnessEvents(req, res, email) {
  const root = userFitnessRoot(email);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store, no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("ready", { email, root: `fitness/${email}` });

  let timer = null;
  const bump = (filename) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      send("change", {
        path: filename || "",
        at: new Date().toISOString(),
      });
    }, 200);
  };

  let watcher;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      bump(filename ? String(filename) : "");
    });
  } catch (err) {
    send("error", {
      error: err instanceof Error ? err.message : "watch failed",
    });
  }

  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
}
