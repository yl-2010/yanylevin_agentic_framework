/**
 * Orange "working" thought-orb for the chat working bubble.
 * Engine: thinking-orbs by Jakub Antalik (MIT, js/vendor/thinking-orbs/LICENSE).
 * window.YLOrb.mount(canvas, { size? }) -> { destroy() }. Fires `ylorb-ready`
 * on window once set, since chatbot.js (classic script) can run first.
 */
import { MODE_FRAMES, paintFrame, resolvePreset } from "./vendor/thinking-orbs/engine.es.js?v=2";

const PRESET_SIZE = 64;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

function pageIsDark() {
  const resolved = document.documentElement.getAttribute("data-resolved-theme");
  if (resolved === "dark") return true;
  if (resolved === "light") return false;
  return darkScheme.matches;
}

function parseRgb(raw) {
  const s = String(raw || "").trim();
  const triple = s.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
  if (triple) return { r: +triple[1], g: +triple[2], b: +triple[3] };
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const fn = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (fn) return { r: +fn[1], g: +fn[2], b: +fn[3] };
  return null;
}

function readTint(canvas) {
  const cs = getComputedStyle(canvas);
  return (
    parseRgb(cs.getPropertyValue("--chat-orange-rgb")) ||
    parseRgb(cs.getPropertyValue("--chat-orange")) || { r: 253, g: 88, b: 2 }
  );
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ size?: number }} [opts] CSS px edge; defaults to the canvas box.
 */
function mount(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { destroy() {} };
  const { mode, speed, opts: modeOpts } = resolvePreset("working", PRESET_SIZE);
  const frameFn = MODE_FRAMES[mode];
  let dark = pageIsDark();
  let tint = readTint(canvas);
  let cssSize = 0;
  let dpr = 1;

  const fit = () => {
    cssSize =
      Number(opts.size) ||
      Math.round(canvas.getBoundingClientRect().width) ||
      canvas.clientWidth ||
      40;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(cssSize * dpr);
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== px) canvas.height = px;
  };

  const draw = (tSec) => {
    const k = (dpr * cssSize) / PRESET_SIZE;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    paintFrame(ctx, frameFn(PRESET_SIZE, tSec, modeOpts), dark, tint);
  };

  const now = () => (performance.now() / 1000) * speed;

  let raf = 0;
  let running = false;
  let visible = true;
  let destroyed = false;

  const loop = () => {
    draw(now());
    if (running) raf = requestAnimationFrame(loop);
  };
  const start = () => {
    if (running || destroyed || reduceMotion.matches) return;
    running = true;
    raf = requestAnimationFrame(loop);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };
  const redraw = () => draw(reduceMotion.matches ? 0.6 : now());

  const onTheme = () => {
    dark = pageIsDark();
    // The tint var flips with the theme; read it after styles recalc.
    requestAnimationFrame(() => {
      if (destroyed) return;
      tint = readTint(canvas);
      redraw();
    });
  };
  const themeObserver = new MutationObserver(onTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-resolved-theme"],
  });
  darkScheme.addEventListener("change", onTheme);

  const io =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(([entry]) => {
          visible = Boolean(entry?.isIntersecting);
          if (visible && document.visibilityState !== "hidden") start();
          else stop();
        })
      : null;
  io?.observe(canvas);

  const onVis = () => {
    if (document.visibilityState === "hidden") stop();
    else if (visible) start();
  };
  document.addEventListener("visibilitychange", onVis);

  const onMotion = () => {
    if (reduceMotion.matches) stop();
    else if (visible) start();
    redraw();
  };
  reduceMotion.addEventListener("change", onMotion);

  fit();
  redraw();
  if (!io) start();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      io?.disconnect();
      themeObserver.disconnect();
      darkScheme.removeEventListener("change", onTheme);
      reduceMotion.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVis);
    },
  };
}

window.YLOrb = { mount };
window.dispatchEvent(new Event("ylorb-ready"));
