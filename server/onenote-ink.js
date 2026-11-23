/**
 * OneNote page content with `?includeInkML=true`: split the multipart body,
 * parse InkML traces into page px, and find the absolutely placed page
 * images those strokes sit on. Ink is himetric (1/2540 in); page HTML is
 * 96 px per inch, so one factor maps both into the same space.
 */

export const HIMETRIC_TO_PX = 96 / 2540;

/**
 * @param {string} body
 * @param {string} contentType
 */
export function splitInkMultipart(body, contentType = "") {
  const text = String(body || "");
  const m = String(contentType).match(/boundary="?([^";]+)"?/i);
  if (!m) {
    const at = text.indexOf("<?xml");
    if (at > 0 && /<inkml:ink/i.test(text)) {
      return { html: text.slice(0, at), inkml: text.slice(at) };
    }
    return { html: text, inkml: "" };
  }
  const boundary = `--${m[1]}`;
  let html = "";
  let inkml = "";
  for (const chunk of text.split(boundary)) {
    const split = chunk.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const head = chunk.slice(0, split).toLowerCase();
    const part = chunk.slice(split).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
    if (head.includes("text/html")) html = part;
    else if (head.includes("inkml")) inkml = part;
  }
  return { html, inkml };
}

/**
 * Decode one InkML trace body. Supports explicit values plus the `'`
 * (first difference) and `"` (second difference) prefixes from the spec.
 * Returns [x, y] pairs in himetric.
 * @param {string} body
 */
export function decodeTrace(body) {
  /** @type {[number, number][]} */
  const out = [];
  const points = String(body || "").replace(/\s+/g, " ").split(",");
  /** @type {("!"|"'"|"\"")[]} */
  const mode = ["!", "!"];
  const prev = [0, 0];
  const vel = [0, 0];
  for (const raw of points) {
    const tokens = raw.trim().match(/[!'"]?-?\d*\.?\d+(?:[eE][-+]?\d+)?|[!'"]/g);
    if (!tokens || tokens.length < 2) continue;
    const xy = [0, 0];
    let channel = 0;
    let ok = true;
    for (const tok of tokens) {
      if (channel > 1) break;
      let t = tok;
      if (t[0] === "!" || t[0] === "'" || t[0] === '"') {
        mode[channel] = /** @type {any} */ (t[0]);
        t = t.slice(1);
      }
      if (!t) continue;
      const n = Number(t);
      if (!Number.isFinite(n)) {
        ok = false;
        break;
      }
      if (mode[channel] === "!") {
        vel[channel] = n - prev[channel];
        xy[channel] = n;
      } else if (mode[channel] === "'") {
        vel[channel] = n;
        xy[channel] = prev[channel] + n;
      } else {
        vel[channel] += n;
        xy[channel] = prev[channel] + vel[channel];
      }
      channel += 1;
    }
    if (!ok || channel < 2) continue;
    prev[0] = xy[0];
    prev[1] = xy[1];
    out.push([xy[0], xy[1]]);
  }
  return out;
}

/**
 * @param {string} inkml
 */
export function parseInkml(inkml) {
  const text = String(inkml || "");
  /** @type {Record<string, { color: string, width: number, raster: string }>} */
  const brushes = {};
  for (const m of text.matchAll(/<inkml:brush\b[^>]*xml:id="([^"]+)"[^>]*>([\s\S]*?)<\/inkml:brush>/g)) {
    const body = m[2];
    const prop = (name) => {
      const hit = body.match(new RegExp(`name="${name}"[^>]*value="([^"]+)"`));
      return hit ? hit[1] : "";
    };
    brushes[m[1]] = {
      color: (prop("color") || "#000000").toUpperCase(),
      width: Number(prop("width")) || 26,
      raster: prop("rasterOp") || "copyPen",
    };
  }
  /** @type {{ color: string, widthPx: number, points: [number, number][] }[]} */
  const traces = [];
  for (const m of text.matchAll(/<inkml:trace\b([^>]*)>([\s\S]*?)<\/inkml:trace>/g)) {
    const ref = m[1].match(/brushRef="#?([^"]+)"/);
    const brush = (ref && brushes[ref[1]]) || { color: "#004F8B", width: 26, raster: "copyPen" };
    if (brush.raster === "maskPen") continue;
    if (brush.color === "#FFFFFF" || brush.color === "#FFF") continue;
    const pts = decodeTrace(m[2]).map(([x, y]) => [x * HIMETRIC_TO_PX, y * HIMETRIC_TO_PX]);
    if (!pts.length) continue;
    traces.push({
      color: brush.color,
      widthPx: Math.max(1.5, brush.width * HIMETRIC_TO_PX),
      points: /** @type {[number, number][]} */ (pts),
    });
  }
  return { brushes, traces };
}

/**
 * @param {string} style
 * @param {string} key
 */
function stylePx(style, key) {
  const m = String(style || "").match(new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*(-?[\\d.]+)px`, "i"));
  return m ? Number(m[1]) : NaN;
}

/**
 * Absolutely placed images on a returned page, in page order.
 * @param {string} html
 */
export function pageImages(html) {
  /** @type {{ alt: string, left: number, top: number, width: number, height: number, src: string }[]} */
  const out = [];
  for (const m of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name) => {
      const hit = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
      return hit ? hit[1] : "";
    };
    const style = attr("style");
    const left = stylePx(style, "left");
    const top = stylePx(style, "top");
    if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
    out.push({
      alt: attr("alt"),
      left,
      top,
      width: Number(attr("width")) || 0,
      height: Number(attr("height")) || 0,
      src: attr("data-fullres-src") || attr("src"),
    });
  }
  return out.sort((a, b) => a.top - b.top || a.left - b.left);
}

/**
 * Strokes whose centroid sits on this image, translated into image px.
 * @param {{ color: string, widthPx: number, points: [number, number][] }[]} traces
 * @param {{ left: number, top: number, width: number, height: number }} image
 */
export function strokesOnImage(traces, image) {
  const out = [];
  for (const t of traces) {
    let cx = 0;
    let cy = 0;
    for (const [x, y] of t.points) {
      cx += x;
      cy += y;
    }
    cx /= t.points.length;
    cy /= t.points.length;
    if (
      cx < image.left ||
      cy < image.top ||
      cx > image.left + image.width ||
      cy > image.top + image.height
    ) {
      continue;
    }
    out.push({
      color: t.color,
      widthPx: t.widthPx,
      points: t.points.map(([x, y]) => [x - image.left, y - image.top]),
    });
  }
  return out;
}

/**
 * Strokes that touch a box (image px).
 * @param {{ points: [number, number][] }[]} strokes
 * @param {{ x: number, y: number, width: number, height: number }} box
 */
export function strokesInBox(strokes, box) {
  return strokes.filter((s) =>
    s.points.some(
      ([x, y]) =>
        x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height
    )
  );
}
