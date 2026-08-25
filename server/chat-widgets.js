/**
 * Parse Personal Agent widget fences out of assistant markdown.
 * Widgets are a separate message field — never HTML in the text bubble.
 */

export const MAX_WIDGETS = 12;
export const MAX_PINS = 40;
export const MAX_HTML_BYTES = 80 * 1024;
export const MAX_PIN_DESCRIPTION = 800;

const FENCE_RE =
  /^```(widgets|widget)[ \t]*([^\n]*)\r?\n([\s\S]*?)^```[ \t]*\r?$/gm;
const MD_IMAGE_RE =
  /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/**
 * @param {unknown} raw
 * @returns {string}
 */
function str(raw) {
  return String(raw ?? "").trim();
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function httpsUrl(raw) {
  const url = str(raw);
  if (!/^https:\/\//i.test(url)) return "";
  if (/\s/.test(url)) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return "";
    return u.href;
  } catch {
    return "";
  }
}

/**
 * @param {unknown} latRaw
 * @param {unknown} lngRaw
 * @returns {{ lat: number, lng: number } | null}
 */
function parseCoord(latRaw, lngRaw) {
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * @param {string} info
 * @returns {{ type: string, attrs: Record<string, string> }}
 */
function parseInfo(info) {
  const parts = str(info).split(/\s+/).filter(Boolean);
  const type = str(parts[0] || "").toLowerCase();
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) attrs[key] = val;
  }
  return { type, attrs };
}

/**
 * @param {unknown} raw
 * @returns {unknown}
 */
function tryJson(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @returns {string}
 */
function pinIdFrom(raw, index) {
  const id = str(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return id || `pin-${index + 1}`;
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, lat: number, lng: number, title: string, subtitle: string, description: string }[]}
 */
export function normalizePins(raw) {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray(/** @type {any} */ (raw).pins)
      ? /** @type {any} */ (raw).pins
      : [];
  /** @type {{ id: string, lat: number, lng: number, title: string, subtitle: string, description: string }[]} */
  const out = [];
  const used = new Set();
  for (const item of list) {
    if (out.length >= MAX_PINS) break;
    if (!item || typeof item !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const coord = parseCoord(row.lat ?? row.latitude, row.lng ?? row.lon ?? row.longitude);
    if (!coord) continue;
    let id = pinIdFrom(row.id ?? row.pinId ?? row.pin, out.length);
    if (used.has(id)) id = `${id}-${out.length + 1}`;
    used.add(id);
    /** @type {{ id: string, lat: number, lng: number, title: string, subtitle: string, description: string }} */
    const pin = {
      id,
      lat: coord.lat,
      lng: coord.lng,
      title: str(row.title ?? row.name).slice(0, 160) || id,
      subtitle: str(row.subtitle ?? row.address).slice(0, 240),
      description: str(row.description ?? row.body ?? row.detail).slice(0, MAX_PIN_DESCRIPTION),
    };
    out.push(pin);
  }
  return out;
}

/**
 * @param {unknown} html
 * @returns {string}
 */
function clipHtml(html) {
  const text = String(html ?? "").replace(/\r\n/g, "\n").replace(/\n+$/g, "");
  if (!text.trim()) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MAX_HTML_BYTES) return text;
  return "";
}

/**
 * @param {string} type
 * @param {Record<string, string>} attrs
 * @param {string} body
 * @returns {object[]}
 */
function widgetsFromFence(type, attrs, body) {
  const pinId = str(attrs.pin || attrs.pinid);
  if (type === "map") {
    const data = tryJson(body);
    const pins = normalizePins(data);
    if (!pins.length) return [];
    return [{ type: "map", pins }];
  }
  if (type === "image") {
    const data = tryJson(body);
    const url = httpsUrl(
      data && typeof data === "object"
        ? /** @type {any} */ (data).url ?? /** @type {any} */ (data).src
        : body
    );
    if (!url) return [];
    const alt =
      data && typeof data === "object"
        ? str(/** @type {any} */ (data).alt).slice(0, 200)
        : "";
    /** @type {Record<string, unknown>} */
    const w = { type: "image", url };
    if (alt) w.alt = alt;
    if (pinId) w.pinId = pinId;
    return [w];
  }
  if (type === "html") {
    const html = clipHtml(body);
    if (!html) return [];
    const theme = str(attrs.theme).toLowerCase();
    const pairId = str(attrs.id || attrs.pair);
    /** @type {Record<string, unknown>} */
    const w = { type: "html" };
    if (theme === "dark") w.htmlDark = html;
    else {
      w.html = html;
      if (theme === "light") w.htmlLight = html;
    }
    if (pinId) w.pinId = pinId;
    if (pairId) w.pairId = pairId;
    return [w];
  }
  return [];
}

/**
 * @param {unknown} data
 * @returns {object[]}
 */
function widgetsFromArray(data) {
  if (!Array.isArray(data)) return [];
  /** @type {object[]} */
  const out = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const type = str(row.type).toLowerCase();
    const attrs = {
      pin: str(row.pinId ?? row.pin),
      theme: str(row.theme),
      id: str(row.pairId ?? row.pair),
    };
    if (type === "map") {
      out.push(...widgetsFromFence("map", attrs, JSON.stringify(row)));
    } else if (type === "image") {
      out.push(
        ...widgetsFromFence(
          "image",
          attrs,
          JSON.stringify({ url: row.url, alt: row.alt, src: row.src })
        )
      );
    } else if (type === "html") {
      out.push({
        type: "html",
        html: row.html,
        htmlLight: row.htmlLight,
        htmlDark: row.htmlDark,
        pinId: row.pinId ?? row.pin,
        pairId: row.pairId ?? row.pair,
        theme: row.theme,
      });
    }
  }
  return out;
}

/**
 * @param {string} content
 * @returns {{ content: string, lifted: object[] }}
 */
function liftMarkdownImages(content) {
  /** @type {object[]} */
  const lifted = [];
  const next = String(content || "").replace(MD_IMAGE_RE, (_, alt, url) => {
    const href = httpsUrl(url);
    if (href && lifted.length < MAX_WIDGETS) {
      /** @type {Record<string, unknown>} */
      const w = { type: "image", url: href };
      const label = str(alt).slice(0, 200);
      if (label) w.alt = label;
      lifted.push(w);
      return "";
    }
    return str(alt);
  });
  return { content: next, lifted };
}

/**
 * @param {object[]} widgets
 * @returns {object[]}
 */
export function normalizeWidgets(widgets) {
  const incoming = Array.isArray(widgets) ? widgets : [];
  /** @type {{ id: string, lat: number, lng: number, title: string, subtitle: string, description: string }[]} */
  let pins = [];
  /** @type {object[]} */
  const htmlOrImage = [];

  for (const w of incoming) {
    if (!w || typeof w !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (w);
    const type = str(row.type).toLowerCase();
    if (type === "map") {
      const extra = normalizePins(row.pins);
      const seen = new Set(pins.map((p) => p.id));
      for (const pin of extra) {
        if (pins.length >= MAX_PINS) break;
        if (seen.has(pin.id)) continue;
        seen.add(pin.id);
        pins.push(pin);
      }
      continue;
    }
    if (type === "image") {
      const url = httpsUrl(row.url);
      if (!url) continue;
      /** @type {Record<string, unknown>} */
      const next = { type: "image", url };
      const alt = str(row.alt).slice(0, 200);
      const pinId = str(row.pinId ?? row.pin);
      if (alt) next.alt = alt;
      if (pinId) next.pinId = pinId;
      htmlOrImage.push(next);
      continue;
    }
    if (type === "place") {
      const pinId = str(row.pinId ?? row.pin);
      const title = str(row.title).slice(0, 160) || pinId;
      if (!title) continue;
      /** @type {Record<string, unknown>} */
      const next = { type: "place", title };
      const subtitle = str(row.subtitle).slice(0, 240);
      const body = str(row.body ?? row.description).slice(0, MAX_PIN_DESCRIPTION);
      const coord = parseCoord(row.lat ?? row.latitude, row.lng ?? row.lon ?? row.longitude);
      if (subtitle) next.subtitle = subtitle;
      if (body) next.body = body;
      if (pinId) next.pinId = pinId;
      if (coord) {
        next.lat = coord.lat;
        next.lng = coord.lng;
      }
      htmlOrImage.push(next);
      continue;
    }
    if (type === "html") {
      const theme = str(row.theme).toLowerCase();
      let light = clipHtml(row.htmlLight);
      let dark = clipHtml(row.htmlDark);
      const html = clipHtml(row.html);
      if (theme === "dark") dark = dark || html;
      else if (theme === "light") light = light || html;
      else if (!light) light = html;
      if (!light && !dark) continue;
      const pinId = str(row.pinId ?? row.pin);
      const pairId = str(row.pairId ?? row.pair);
      const existing = htmlOrImage.find((prev) => {
        if (str(/** @type {any} */ (prev).type) !== "html") return false;
        if (pinId && str(/** @type {any} */ (prev).pinId) === pinId) return true;
        if (!pinId && pairId && str(/** @type {any} */ (prev).pairId) === pairId) {
          return true;
        }
        return false;
      });
      if (existing) {
        const cur = /** @type {Record<string, unknown>} */ (existing);
        if (light) cur.html = light;
        if (dark) cur.htmlDark = dark;
        continue;
      }
      /** @type {Record<string, unknown>} */
      const next = { type: "html", html: light || dark };
      if (dark) next.htmlDark = dark;
      if (pinId) next.pinId = pinId;
      if (pairId) next.pairId = pairId;
      htmlOrImage.push(next);
    }
  }

  /** @type {object[]} */
  const ordered = [];
  if (pins.length) {
    ordered.push({ type: "map", pins });
  }

  const boundIds = new Set();
  for (const pin of pins) {
    const match = htmlOrImage.find(
      (w) => str(/** @type {any} */ (w).pinId) === pin.id && !boundIds.has(w)
    );
    if (match) {
      boundIds.add(match);
      const kind = str(/** @type {any} */ (match).type).toLowerCase();
      if (kind === "html") {
        ordered.push(
          stubPinCard(pin, extraPlaceBody(pin, String(/** @type {any} */ (match).html || "")))
        );
        continue;
      }
      if (kind === "place") {
        const row = /** @type {Record<string, unknown>} */ (match);
        if (!str(row.title)) row.title = pin.title;
        if (!str(row.subtitle) && pin.subtitle) row.subtitle = pin.subtitle;
        row.lat = pin.lat;
        row.lng = pin.lng;
        ordered.push(row);
        continue;
      }
      ordered.push(match);
      continue;
    }
    ordered.push(stubPinCard(pin));
  }

  for (const w of htmlOrImage) {
    if (!boundIds.has(w)) ordered.push(w);
  }

  const capped = ordered.slice(0, MAX_WIDGETS);
  if (pins.length && capped[0]?.type !== "map") {
    return [{ type: "map", pins }, ...capped.filter((w) => w.type !== "map")].slice(
      0,
      MAX_WIDGETS
    );
  }

  const used = new Set();
  return capped.map((w, i) => {
    const row = /** @type {Record<string, unknown>} */ (w);
    let id =
      row.type === "map"
        ? "map"
        : str(row.pinId) ||
          str(row.pairId) ||
          (row.type === "image" ? `image-${i}` : `w${i}`);
    if (used.has(id)) id = `${id}-${i}`;
    used.add(id);
    return { ...row, id };
  });
}

/**
 * @param {{ id: string, lat: number, lng: number, title: string, subtitle: string, description?: string }} pin
 * @param {string} [body]
 * @returns {{ type: string, pinId: string, title: string, lat: number, lng: number, subtitle?: string, body?: string }}
 */
function stubPinCard(pin, body) {
  /** @type {{ type: string, pinId: string, title: string, lat: number, lng: number, subtitle?: string, body?: string }} */
  const next = {
    type: "place",
    pinId: pin.id,
    title: pin.title,
    lat: pin.lat,
    lng: pin.lng,
  };
  if (pin.subtitle) next.subtitle = pin.subtitle;
  const extra = str(pin.description || body).slice(0, MAX_PIN_DESCRIPTION);
  if (extra) next.body = extra;
  return next;
}

/**
 * @param {unknown} html
 * @returns {string}
 */
function htmlToPlain(html) {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extra body text from pin HTML, skipping title/subtitle already on the pin.
 * @param {{ title: string, subtitle: string }} pin
 * @param {string} html
 */
function extraPlaceBody(pin, html) {
  let text = htmlToPlain(html);
  if (!text) return "";
  const title = str(pin.title);
  const sub = str(pin.subtitle);
  if (title && text.toLowerCase().startsWith(title.toLowerCase())) {
    text = text.slice(title.length).trim();
  }
  if (sub && text.toLowerCase().startsWith(sub.toLowerCase())) {
    text = text.slice(sub.length).trim();
  }
  if (!text) return "";
  if (text.toLowerCase() === title.toLowerCase()) return "";
  if (sub && text.toLowerCase() === sub.toLowerCase()) return "";
  return text.slice(0, MAX_PIN_DESCRIPTION);
}

/**
 * @param {string} s
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {unknown} raw
 * @returns {{ content: string, widgets: object[] }}
 */
export function parseAgentReply(raw) {
  let text = String(raw ?? "");
  /** @type {object[]} */
  const extracted = [];

  text = text.replace(FENCE_RE, (_, kind, info, body) => {
    if (String(kind) === "widgets") {
      extracted.push(...widgetsFromArray(tryJson(body)));
      return "\n";
    }
    const parsed = parseInfo(info);
    extracted.push(...widgetsFromFence(parsed.type, parsed.attrs, String(body ?? "")));
    return "\n";
  });

  const lifted = liftMarkdownImages(text);
  const widgets = normalizeWidgets([...extracted, ...lifted.lifted]);
  const content = lifted.content.replace(/\n{3,}/g, "\n\n").trim();
  return { content, widgets };
}

/**
 * Re-emit widgets as fences for transcripts / agent replay.
 * @param {object[]} widgets
 * @returns {string}
 */
export function formatWidgetsAsFences(widgets) {
  const list = Array.isArray(widgets) ? widgets : [];
  if (!list.length) return "";
  /** @type {string[]} */
  const parts = [];
  for (const w of list) {
    if (!w || typeof w !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (w);
    const type = str(row.type).toLowerCase();
    if (type === "map") {
      parts.push(
        "```widget map\n" + JSON.stringify({ pins: normalizePins(row.pins) }) + "\n```"
      );
    } else if (type === "image") {
      const url = httpsUrl(row.url);
      if (!url) continue;
      const payload = { url };
      const alt = str(row.alt);
      const pinId = str(row.pinId);
      if (alt) payload.alt = alt;
      const info = pinId ? `widget image pin=${pinId}` : "widget image";
      parts.push("```" + info + "\n" + JSON.stringify(payload) + "\n```");
    } else if (type === "html") {
      const light = clipHtml(row.htmlLight || row.html);
      const dark = clipHtml(row.htmlDark);
      const pinId = str(row.pinId);
      const pairId = str(row.pairId);
      const bits = [];
      if (pinId) bits.push(`pin=${pinId}`);
      else if (pairId) bits.push(`id=${pairId}`);
      const base = bits.length ? `widget html ${bits.join(" ")}` : "widget html";
      if (light && dark && light !== dark) {
        parts.push("```" + `${base} theme=light` + "\n" + light + "\n```");
        parts.push("```" + `${base} theme=dark` + "\n" + dark + "\n```");
      } else {
        const html = light || dark;
        if (!html) continue;
        const theme = !light && dark ? " theme=dark" : "";
        parts.push("```" + `${base}${theme}` + "\n" + html + "\n```");
      }
    }
  }
  return parts.join("\n\n");
}
