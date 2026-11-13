/**
 * Device token registration and cross-device alert dismiss.
 * Paths sit on the Mac API. The iOS client sends them to api.yanylevin.com.
 */

import { dismissAlertOnOtherDevices } from "./apns.js";
import { dismissedSince, registerDevice, upsertLiveActivity } from "./push-devices.js";

/**
 * @param {import('express').Application} app
 * @param {import('express').RequestHandler} requireEducationUser
 */
export function mountPushRoutes(app, requireEducationUser) {
  app.post("/api/push/register", requireEducationUser, async (req, res) => {
    try {
      const result = await registerDevice(req.user.email, {
        deviceId: req.body?.deviceId,
        token: req.body?.token,
        sandbox: req.body?.sandbox === true || req.body?.sandbox === "true",
        idiom: req.body?.idiom,
        name: req.body?.name,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || "register failed" });
    }
  });

  app.post("/api/push/opened", requireEducationUser, async (req, res) => {
    const id = String(req.body?.id || "").trim();
    if (!id) {
      res.status(400).json({ ok: false, error: "id is required" });
      return;
    }
    try {
      const result = await dismissAlertOnOtherDevices(
        req.user.email,
        id,
        String(req.body?.deviceId || "")
      );
      res.json({ ok: true, sent: result.sent });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || "dismiss failed" });
    }
  });

  app.get("/api/push/dismissed", requireEducationUser, async (req, res) => {
    try {
      const since = Number(req.query?.since || 0);
      const result = await dismissedSince(req.user.email, since);
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || "dismissed read failed" });
    }
  });

  app.post("/api/live-activity/token", requireEducationUser, async (req, res) => {
    try {
      const result = await upsertLiveActivity(req.user.email, {
        deviceId: req.body?.deviceId,
        sandbox: req.body?.sandbox === true || req.body?.sandbox === "true",
        pushToStartToken: req.body?.pushToStartToken,
        activityPushToken: req.body?.activityPushToken,
        dayId: req.body?.dayId,
        ended: req.body?.ended === true || req.body?.ended === "true",
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || "token failed" });
    }
  });
}
