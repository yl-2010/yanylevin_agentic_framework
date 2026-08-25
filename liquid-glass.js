/**
 * Apple Liquid Glass orbs — faithful port of archisvaze/liquid-glass.
 * Source: https://github.com/archisvaze/liquid-glass
 *
 * Desktop:
 *   Chromium → physics displacement via backdrop-filter: url(#filter)
 *   Other    → lucasromerodb turbulence displacement fallback (filter:url)
 *
 * Mobile (only):
 *   Plain frosted glass (CSS backdrop blur + tint) — same look as the main
 *   chatbot UI on mobile. No WebGL / SVG refraction. Desktop path untouched.
 */
(() => {
  // Defaults from archisvaze/liquid-glass control panel (index.html sliders).
  // Circle uses the same engine with milder refraction — a full-disk lens at
  // IOR 3 / scale 1 reads as a chrome marble; Apple circular glass is subtler.
  const ARCHIS = {
    glassThickness: 80,
    bezelWidth: 60,
    ior: 3.0,
    scaleRatio: 1.0,
    blurAmt: 0.3,
    specOpacity: 0.5,
    specSat: 4,
    tintOpacity: 0.06,
    shadowBlur: 20,
    shadowSpread: -5,
    shadowColor: "rgba(255, 255, 255, 0.45)",
    outerShadowBlur: 24,
  };

  const SHAPE_TUNE = {
    squircle: { ior: 3.0, scaleRatio: 1.0, bezelFrac: 0.52, specOpacity: 0.5 },
    // Same refraction profile as squircle, but radius comes from CSS / data-lg-radius
    rounded: { ior: 3.0, scaleRatio: 1.0, bezelFrac: 0.52, specOpacity: 0.5 },
    circle: { ior: 1.85, scaleRatio: 0.55, bezelFrac: 0.38, specOpacity: 0.38 },
  };

  // iOS dark Liquid Glass: deeper frost, softer specular luminance
  const DARK_GLASS = {
    blurAmt: 0.55,
    specOpacityMul: 0.72,
    specSat: 2.5,
  };

  // WebGL path defaults (archis webgl.html control panel)
  const WEBGL_LOOK = {
    thickness: 50,
    bezel: 60,
    blur: 1.5,
    shadow: 0.5,
  };

  function isDarkMode() {
    const resolved = document.documentElement.dataset.resolvedTheme;
    if (resolved === "dark") return true;
    if (resolved === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  /** Mobile / touch devices only — desktop path must stay unchanged. */
  function isMobileLiquidGlass() {
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    // iPadOS 13+ can report as Macintosh with touch
    if (navigator.maxTouchPoints > 1 && /Mac/.test(ua)) return true;
    return window.matchMedia("(max-width: 768px) and (hover: none)").matches;
  }

  const SURFACE_FNS = {
    // verbatim from archisvaze/liquid-glass
    convex_squircle: (x) => Math.pow(1 - Math.pow(1 - x, 4), 0.25),
    convex_circle: (x) => Math.sqrt(1 - (1 - x) * (1 - x)),
  };

  function isChromiumSvgBackdrop() {
    const ua = navigator.userAgent;
    // SVG backdrop-filter:url(#…) only renders in Chromium today
    const isChromium = /Chrome|Chromium|Edg|OPR/i.test(ua);
    if (!isChromium) return false;
    const el = document.createElement("div");
    el.style.cssText = "backdrop-filter: url(#test)";
    return (
      el.style.backdropFilter === "url(#test)" ||
      el.style.backdropFilter === 'url("#test")'
    );
  }

  // --- archisvaze refraction math (verbatim) ---
  function calculateRefractionProfile(glassThickness, bezelWidth, heightFn, ior, samples) {
    samples = samples || 128;
    const eta = 1 / ior;
    function refract(nx, ny) {
      const dot = ny;
      const k = 1 - eta * eta * (1 - dot * dot);
      if (k < 0) return null;
      const sq = Math.sqrt(k);
      return [-(eta * dot + sq) * nx, eta - (eta * dot + sq) * ny];
    }
    const profile = new Float64Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = i / samples;
      const y = heightFn(x);
      const dx = x < 1 ? 0.0001 : -0.0001;
      const y2 = heightFn(x + dx);
      const deriv = (y2 - y) / dx;
      const mag = Math.sqrt(deriv * deriv + 1);
      const ref = refract(-deriv / mag, -1 / mag);
      if (!ref) {
        profile[i] = 0;
        continue;
      }
      profile[i] = ref[0] * ((y * bezelWidth + glassThickness) / ref[1]);
    }
    return profile;
  }

  function generateDisplacementMap(w, h, radius, bezelWidth, profile, maxDisp) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 128;
      d[i + 1] = 128;
      d[i + 2] = 0;
      d[i + 3] = 255;
    }

    const r = radius;
    const rSq = r * r;
    const r1Sq = (r + 1) ** 2;
    const rBSq = Math.max(r - bezelWidth, 0) ** 2;
    const wB = w - r * 2;
    const hB = h - r * 2;
    const S = profile.length;

    for (let y1 = 0; y1 < h; y1++) {
      for (let x1 = 0; x1 < w; x1++) {
        const x = x1 < r ? x1 - r : x1 >= w - r ? x1 - r - wB : 0;
        const y = y1 < r ? y1 - r : y1 >= h - r ? y1 - r - hB : 0;
        const dSq = x * x + y * y;
        if (dSq > r1Sq || dSq < rBSq) continue;
        const dist = Math.sqrt(dSq);
        const fromSide = r - dist;
        const op =
          dSq < rSq
            ? 1
            : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
        if (op <= 0 || dist === 0) continue;
        const cos = x / dist;
        const sin = y / dist;
        const bi = Math.min(((fromSide / bezelWidth) * S) | 0, S - 1);
        const disp = profile[bi] || 0;
        const dX = (-cos * disp) / maxDisp;
        const dY = (-sin * disp) / maxDisp;
        const idx = (y1 * w + x1) * 4;
        d[idx] = (128 + dX * 127 * op + 0.5) | 0;
        d[idx + 1] = (128 + dY * 127 * op + 0.5) | 0;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  function generateSpecularMap(w, h, radius, bezelWidth, angle) {
    angle = angle != null ? angle : Math.PI / 3;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const img = ctx.createImageData(w, h);
    const d = img.data;
    d.fill(0);

    const r = radius;
    const rSq = r * r;
    const r1Sq = (r + 1) ** 2;
    const rBSq = Math.max(r - bezelWidth, 0) ** 2;
    const wB = w - r * 2;
    const hB = h - r * 2;
    const sv = [Math.cos(angle), Math.sin(angle)];

    for (let y1 = 0; y1 < h; y1++) {
      for (let x1 = 0; x1 < w; x1++) {
        const x = x1 < r ? x1 - r : x1 >= w - r ? x1 - r - wB : 0;
        const y = y1 < r ? y1 - r : y1 >= h - r ? y1 - r - hB : 0;
        const dSq = x * x + y * y;
        if (dSq > r1Sq || dSq < rBSq) continue;
        const dist = Math.sqrt(dSq);
        const fromSide = r - dist;
        const op =
          dSq < rSq
            ? 1
            : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
        if (op <= 0 || dist === 0) continue;
        const cos = x / dist;
        const sin = -y / dist;
        const dot = Math.abs(cos * sv[0] + sin * sv[1]);
        // archis: edge = sqrt(max(0, 1 - (1 - fromSide)^2))  — note: not /bezelWidth
        const edge = Math.sqrt(Math.max(0, 1 - (1 - fromSide) ** 2));
        const coeff = dot * edge;
        const col = (255 * coeff) | 0;
        const alpha = (col * coeff * op) | 0;
        const idx = (y1 * w + x1) * 4;
        d[idx] = col;
        d[idx + 1] = col;
        d[idx + 2] = col;
        d[idx + 3] = alpha;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  function ensureLucasFallbackFilter(defs) {
    // From lucasromerodb/liquid-glass-effect-macos
    if (document.getElementById("lg-lucas-distort")) return;
    const svgNS = "http://www.w3.org/2000/svg";
    const filter = document.createElementNS(svgNS, "filter");
    filter.setAttribute("id", "lg-lucas-distort");
    filter.setAttribute("x", "0%");
    filter.setAttribute("y", "0%");
    filter.setAttribute("width", "100%");
    filter.setAttribute("height", "100%");
    filter.setAttribute("filterUnits", "objectBoundingBox");
    filter.innerHTML = `
      <feTurbulence type="fractalNoise" baseFrequency="0.01 0.01"
        numOctaves="1" seed="5" result="turbulence" />
      <feComponentTransfer in="turbulence" result="mapped">
        <feFuncR type="gamma" amplitude="1" exponent="10" offset="0.5" />
        <feFuncG type="gamma" amplitude="0" exponent="1" offset="0" />
        <feFuncB type="gamma" amplitude="0" exponent="1" offset="0.5" />
      </feComponentTransfer>
      <feGaussianBlur in="turbulence" stdDeviation="3" result="softMap" />
      <feSpecularLighting in="softMap" surfaceScale="5" specularConstant="1"
        specularExponent="100" lighting-color="white" result="specLight">
        <fePointLight x="-200" y="-200" z="300" />
      </feSpecularLighting>
      <feComposite in="specLight" operator="arithmetic"
        k1="0" k2="1" k3="1" k4="0" result="litImage" />
      <feDisplacementMap in="SourceGraphic" in2="softMap"
        scale="150" xChannelSelector="R" yChannelSelector="G" />
    `;
    defs.appendChild(filter);
  }

  function setFilterMarkup(defs, id, markup) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    // Parse inside an SVG document so primitives are SVG-namespaced
    // (same end result as archis inserting into an xmlns SVG <defs>)
    const svgNS = "http://www.w3.org/2000/svg";
    const holder = document.createElementNS(svgNS, "svg");
    holder.setAttribute("xmlns", svgNS);
    holder.innerHTML = markup;
    const node = holder.querySelector("filter");
    if (node) defs.appendChild(node);
  }

  function buildArchisFilter(id, w, h, dispUrl, specUrl, blurAmt, scale, specOpacity, specSat) {
    // Filter graph verbatim from archisvaze/liquid-glass rebuildFilter()
    return `
      <filter id="${id}" x="0%" y="0%" width="100%" height="100%"
        color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="${blurAmt}" result="blurred_source" />
        <feImage href="${dispUrl}" x="0" y="0" width="${w}" height="${h}" result="disp_map" />
        <feDisplacementMap in="blurred_source" in2="disp_map"
          scale="${scale}" xChannelSelector="R" yChannelSelector="G"
          result="displaced" />
        <feColorMatrix in="displaced" type="saturate" values="${specSat}" result="displaced_sat" />
        <feImage href="${specUrl}" x="0" y="0" width="${w}" height="${h}" result="spec_layer" />
        <feComposite in="displaced_sat" in2="spec_layer" operator="in" result="spec_masked" />
        <feComponentTransfer in="spec_layer" result="spec_faded">
          <feFuncA type="linear" slope="${specOpacity}" />
        </feComponentTransfer>
        <feBlend in="spec_masked" in2="displaced" mode="normal" result="with_sat" />
        <feBlend in="spec_faded" in2="with_sat" mode="normal" />
      </filter>`;
  }

  /** Parse data-lg-radius: number (px), "24", "24px", "1.5rem", "50%". */
  function parseRadiusAttr(raw, el, w, h) {
    const s = String(raw).trim();
    if (!s) return null;
    const ref = Math.min(w, h);
    if (s.endsWith("%")) {
      const pct = parseFloat(s);
      return Number.isFinite(pct) ? (pct / 100) * ref : null;
    }
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return null;
    if (s.endsWith("rem")) {
      const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
      return n * fs;
    }
    // bare number or px (and other absolute units already computed-like)
    return n;
  }

  function clampRadius(r, w, h) {
    const max = Math.min(w, h) / 2;
    return Math.max(0, Math.min(r, max));
  }

  /**
   * Corner radius for the displacement map:
   * 1) data-lg-radius if set
   * 2) circle → half the short side
   * 3) rounded → computed CSS border-radius (arbitrary)
   * 4) squircle → ~35% of short side (legacy Apple-ish default)
   */
  function resolveCornerRadius(el, shape, w, h) {
    const data = el.getAttribute("data-lg-radius");
    if (data != null && String(data).trim() !== "") {
      const parsed = parseRadiusAttr(data, el, w, h);
      if (parsed != null) return clampRadius(parsed, w, h);
    }

    if (shape === "circle") return Math.min(w, h) / 2;

    if (shape === "rounded") {
      const computed = parseFloat(getComputedStyle(el).borderTopLeftRadius);
      if (Number.isFinite(computed)) return clampRadius(computed, w, h);
    }

    return Math.min(w, h) * 0.35;
  }

  // Chromium desktop only — Safari / mobile paths never touch these.
  const chromeFilterCache = new Map();
  const chromeSpecCache = new Map();
  const chromeOrbSig = new WeakMap();
  const chromeObserved = new Set();
  let chromeGlassObserver = null;
  let chromeScrollBound = false;
  let chromeScrollIdle = 0;
  let chromeReinitLock = 0;
  const lastPtr = { x: 0, y: 0, has: false };
  const reduceMotionGlow = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let glowRaf = 0;

  function isStaticContentBox(el) {
    return (
      el.classList.contains("edu-panel") ||
      el.classList.contains("edu-file-tile") ||
      el.classList.contains("dash-login") ||
      el.classList.contains("dash-entry") ||
      el.classList.contains("dash-agent") ||
      el.classList.contains("yan-chat-widget") ||
      el.classList.contains("yan-chat-map-ios") ||
      el.classList.contains("yan-chat-bubble") ||
      el.classList.contains("sheet")
    );
  }

  const STATIC_BOX_SEL =
    ".edu-panel.lg-static, .edu-file-tile.lg-static, .dash-login.lg-static, .dash-entry.lg-static, .dash-agent.lg-static, .yan-chat-widget.lg-static, .yan-chat-map-ios.lg-static, .yan-chat-bubble.lg-static, .sheet.lg-static";

  const STATIC_BOX_MAG_SCALE = 0.6;

  function bindStaticBoxMagnetic(el) {
    if (!el || !document.documentElement.classList.contains("lg-chrome")) return;
    bindMagnetic(el, 0.28 * STATIC_BOX_MAG_SCALE, { clamp: true });
  }

  function unobserveChromeGlass(el) {
    if (!chromeGlassObserver || !chromeObserved.has(el)) return;
    chromeGlassObserver.unobserve(el);
    chromeObserved.delete(el);
  }

  function isGlassPainted(el) {
    if (!el.isConnected) return false;
    if (el.hidden) return false;
    if (el.closest("[hidden]")) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (el.offsetWidth < 2 || el.offsetHeight < 2) return false;
    return true;
  }

  function ensureChromePerfStyles() {
    if (document.getElementById("lg-chrome-perf-styles")) return;
    const style = document.createElement("style");
    style.id = "lg-chrome-perf-styles";
    style.textContent = `
      html.lg-chrome #lg-chrome-wash {
        position: fixed;
        inset: 0;
        z-index: -1;
        pointer-events: none;
      }
      html.lg-chrome [data-liquid-glass].lg-paused.lg-refraction::after {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureChromeWash() {
    if (document.getElementById("lg-chrome-wash")) return;
    const wash = document.createElement("div");
    wash.id = "lg-chrome-wash";
    wash.setAttribute("aria-hidden", "true");
    document.body.insertBefore(wash, document.body.firstChild);
  }

  function bindChromeScrollPerf() {
    if (chromeScrollBound) return;
    chromeScrollBound = true;
    window.addEventListener(
      "scroll",
      () => {
        document.documentElement.classList.add("lg-scrolling");
        clearTimeout(chromeScrollIdle);
        chromeScrollIdle = setTimeout(() => {
          document.documentElement.classList.remove("lg-scrolling");
        }, 120);
      },
      { passive: true }
    );
  }

  function ensureChromeGlassObserver() {
    if (chromeGlassObserver) return;
    chromeGlassObserver = new IntersectionObserver(
      (entries) => {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (entry.isIntersecting) entry.target.classList.remove("lg-paused");
          else entry.target.classList.add("lg-paused");
        }
      },
      { root: null, rootMargin: "40% 25%", threshold: 0 }
    );
  }

  function observeChromeGlass(el) {
    ensureChromeGlassObserver();
    chromeObserved.forEach((node) => {
      if (node.isConnected) return;
      chromeGlassObserver.unobserve(node);
      chromeObserved.delete(node);
    });
    if (chromeObserved.has(el)) return;
    chromeObserved.add(el);
    chromeGlassObserver.observe(el);
  }

  function initStaticChromeBox(el, shape, w, h, radius) {
    unobserveChromeGlass(el);

    const tune = SHAPE_TUNE[shape] || SHAPE_TUNE.circle;
    const dark = isDarkMode();
    const targetBezel = Math.max(12, Math.round(radius * tune.bezelFrac));
    const clampedBezel = Math.min(
      targetBezel,
      ARCHIS.bezelWidth,
      Math.max(2, radius - 1),
      Math.min(w, h) / 2 - 1
    );

    const sig = [
      "spec",
      shape,
      w,
      h,
      Math.round(radius),
      clampedBezel,
      dark ? 1 : 0,
    ].join("|");

    if (chromeOrbSig.get(el) === sig && el.classList.contains("lg-static")) {
      el.classList.remove("lg-paused");
      bindStaticBoxMagnetic(el);
      return;
    }

    let specUrl = chromeSpecCache.get(sig);
    if (!specUrl) {
      const mapScale = 2;
      specUrl = generateSpecularMap(
        w * mapScale,
        h * mapScale,
        radius * mapScale,
        clampedBezel * mapScale * 2.5
      );
      chromeSpecCache.set(sig, specUrl);
    }

    const specOpacity =
      tune.specOpacity * (dark ? DARK_GLASS.specOpacityMul : 1);

    chromeOrbSig.set(el, sig);
    el.classList.add("lg-refraction", "lg-static");
    el.classList.remove("lg-fallback", "lg-paused");
    el.style.setProperty("--lg-filter", "none");
    el.style.setProperty("--lg-spec", `url("${specUrl}")`);
    el.style.setProperty("--lg-spec-opacity", String(specOpacity));
    bindStaticBoxMagnetic(el);
  }

  function initOrb(el, useSvgBackdrop) {
    const shape = el.getAttribute("data-liquid-glass") || "circle";
    const w = Math.max(2, Math.round(el.offsetWidth));
    const h = Math.max(2, Math.round(el.offsetHeight));

    const radius = resolveCornerRadius(el, shape, w, h);
    el.style.setProperty("--lg-radius", `${radius}px`);

    const defs = document.getElementById("liquid-glass-defs");
    if (!defs) return;

    if (!useSvgBackdrop) {
      el.classList.add("lg-fallback");
      el.classList.remove("lg-refraction", "lg-static");
      el.style.removeProperty("--lg-spec");
      el.style.removeProperty("--lg-spec-opacity");
      ensureLucasFallbackFilter(defs);
      return;
    }

    if (!isGlassPainted(el)) {
      el.classList.add("lg-paused");
      return;
    }

    if (isStaticContentBox(el)) {
      initStaticChromeBox(el, shape, w, h, radius);
      return;
    }

    const tune = SHAPE_TUNE[shape] || SHAPE_TUNE.circle;
    const dark = isDarkMode();
    const heightFn =
      shape === "circle" ? SURFACE_FNS.convex_circle : SURFACE_FNS.convex_squircle;
    // Archis defaults use bezel≈radius on large panes. On small orbs that would
    // erase the flat glass center — keep a fraction of radius so the rim lens reads.
    const targetBezel = Math.max(12, Math.round(radius * tune.bezelFrac));
    const clampedBezel = Math.min(
      targetBezel,
      ARCHIS.bezelWidth,
      Math.max(2, radius - 1),
      Math.min(w, h) / 2 - 1
    );

    const sig = [
      shape,
      w,
      h,
      Math.round(radius),
      clampedBezel,
      dark ? 1 : 0,
      tune.ior,
      tune.scaleRatio,
    ].join("|");

    if (chromeOrbSig.get(el) === sig && el.classList.contains("lg-refraction") && !el.classList.contains("lg-static")) {
      el.classList.remove("lg-paused");
      observeChromeGlass(el);
      return;
    }

    let filterId = chromeFilterCache.get(sig);
    if (!filterId) {
      // Render maps at 2× so rim refraction stays sharp on retina / small orbs
      const mapScale = 2;
      const mw = w * mapScale;
      const mh = h * mapScale;
      const mRadius = radius * mapScale;
      const mBezel = clampedBezel * mapScale;

      const profile = calculateRefractionProfile(
        ARCHIS.glassThickness * mapScale,
        mBezel,
        heightFn,
        tune.ior,
        128
      );
      let maxDisp = 1;
      for (let i = 0; i < profile.length; i++) {
        const a = Math.abs(profile[i]);
        if (a > maxDisp) maxDisp = a;
      }
      const dispUrl = generateDisplacementMap(
        mw,
        mh,
        mRadius,
        mBezel,
        profile,
        maxDisp
      );
      const specUrl = generateSpecularMap(mw, mh, mRadius, mBezel * 2.5);
      // feDisplacementMap scale is in filter primitive units (= element CSS px)
      const scale = (maxDisp / mapScale) * tune.scaleRatio;
      const blurAmt = dark ? DARK_GLASS.blurAmt : ARCHIS.blurAmt;
      const specOpacity =
        tune.specOpacity * (dark ? DARK_GLASS.specOpacityMul : 1);
      const specSat = dark ? DARK_GLASS.specSat : ARCHIS.specSat;

      filterId = `lg-s-${chromeFilterCache.size}-${shape}-${w}x${h}`;
      setFilterMarkup(
        defs,
        filterId,
        buildArchisFilter(
          filterId,
          w,
          h,
          dispUrl,
          specUrl,
          blurAmt,
          scale,
          specOpacity,
          specSat
        )
      );
      chromeFilterCache.set(sig, filterId);
    }

    chromeOrbSig.set(el, sig);
    el.classList.add("lg-refraction");
    el.classList.remove("lg-fallback", "lg-paused", "lg-static");
    el.style.removeProperty("--lg-spec");
    el.style.removeProperty("--lg-spec-opacity");
    // Archis applies ONLY url(#filter) — blur lives inside the SVG graph
    el.style.setProperty("--lg-filter", `url(#${filterId})`);
    observeChromeGlass(el);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Mobile WebGL path — archisvaze/liquid-glass webgl.html shader, live snapshot
  // Stability: CSS frost first, never hide live DOM, idle/low-cost capture,
  // event-driven renders (no perpetual rAF), scroll-end snapshots only.
  // ═══════════════════════════════════════════════════════════════════════════

  const webgl = {
    active: false,
    gl: null,
    glCanvas: null,
    program: null,
    uniforms: null,
    buffers: null,
    bgTex: null,
    hasBg: false,
    surfaces: [], // { el, canvas, ctx2d, shape }
    captureTimer: 0,
    scrollIdleTimer: 0,
    pointerTimer: 0,
    raf: 0,
    capturing: false,
    captureGen: 0,
    html2canvas: null,
    listenersBound: false,
    scrolling: false,
  };

  const WEBGL_VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  // Port of archisvaze/liquid-glass webgl.html fragment shader.
  // Adapted to per-orb canvases: glass fills the canvas; samples viewport snapshot.
  const WEBGL_FRAG = `
precision highp float;
varying vec2 vUv;

uniform vec2 uResolution;
uniform vec2 uOrbOrigin;
uniform vec2 uGlassSize;
uniform float uRadius;
uniform float uBezel;
uniform float uThickness;
uniform float uIOR;
uniform float uBlur;
uniform float uSpecular;
uniform float uTint;
uniform vec3 uTintColor;
uniform float uShadow;
uniform sampler2D uBgTex;
uniform float uHasBg;

float sdRoundedRect(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float surfaceHeight(float t) {
  float s = 1.0 - t;
  return pow(1.0 - s*s*s*s, 0.25);
}

vec3 sampleBg(vec2 screenUV) {
  // screenUV is CSS/y-down; texture is uploaded with UNPACK_FLIP_Y (v=0 at bottom),
  // same as archis webgl.html — flip V so content lines up with what's under the glass.
  vec2 uv = clamp(screenUV, vec2(0.001), vec2(0.999));
  uv.y = 1.0 - uv.y;
  return texture2D(uBgTex, uv).rgb;
}

vec3 sampleBgBlurred(vec2 uv, float radius) {
  if (radius < 0.35) return sampleBg(uv);
  // 8-tap poisson — cheaper/stabler on mobile GPUs than the 16-tap demo
  vec3 sum = vec3(0.0);
  vec2 px = radius / uResolution;
  sum += sampleBg(uv + vec2(-0.94201, -0.39906) * px);
  sum += sampleBg(uv + vec2( 0.94558, -0.76890) * px);
  sum += sampleBg(uv + vec2(-0.09418, -0.92938) * px);
  sum += sampleBg(uv + vec2( 0.34495,  0.29387) * px);
  sum += sampleBg(uv + vec2(-0.91588,  0.45771) * px);
  sum += sampleBg(uv + vec2( 0.81544,  0.48568) * px);
  sum += sampleBg(uv + vec2(-0.38277, -0.56071) * px);
  sum += sampleBg(uv + vec2( 0.12675,  0.84686) * px);
  return sum / 8.0;
}

void main() {
  // Local pixel with y-down (CSS / getBoundingClientRect space)
  vec2 localPx = vec2(vUv.x, 1.0 - vUv.y) * uGlassSize;
  vec2 p = localPx - uGlassSize * 0.5;
  vec2 halfSize = uGlassSize * 0.5;

  float sd = sdRoundedRect(p, halfSize, uRadius);

  if (sd > 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float distFromEdge = -sd;
  float bezel = min(uBezel, min(uRadius, min(halfSize.x, halfSize.y)) - 1.0);
  bezel = max(bezel, 1.0);
  float t = clamp(distFromEdge / bezel, 0.0, 1.0);

  float h = surfaceHeight(t);
  float dt = 0.001;
  float h2 = surfaceHeight(min(t + dt, 1.0));
  float dh = (h2 - h) / dt;

  float slopeAngle = atan(dh * (uThickness / bezel));
  float sinR = sin(slopeAngle) / uIOR;
  sinR = clamp(sinR, -1.0, 1.0);
  float thetaR = asin(sinR);
  float displacement = h * uThickness * (tan(slopeAngle) - tan(thetaR));

  vec2 grad;
  float eps = 0.5;
  grad.x = sdRoundedRect(p + vec2(eps, 0.0), halfSize, uRadius) - sd;
  grad.y = sdRoundedRect(p + vec2(0.0, eps), halfSize, uRadius) - sd;
  float gLen = length(grad);
  grad = gLen > 0.0 ? grad / gLen : vec2(0.0, 1.0);

  vec2 offset = -grad * displacement / uResolution;

  vec2 screenPx = uOrbOrigin + localPx;
  vec2 screenUV = screenPx / uResolution;
  vec2 refractedUV = screenUV + offset;

  // No background yet → fully transparent (CSS frost shows through)
  if (uHasBg < 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec3 color = sampleBgBlurred(refractedUV, uBlur);

  vec2 lightDir = normalize(vec2(0.5, -0.7));
  float rimDot = abs(dot(grad, lightDir));
  float rimFalloff = 1.0 - smoothstep(0.0, bezel * 0.4, distFromEdge);
  float specHighlight = pow(rimDot * rimFalloff, 1.5);
  color += vec3(specHighlight * uSpecular);

  float innerShadow = 1.0 - smoothstep(0.0, bezel * 0.6, distFromEdge);
  color *= mix(1.0, 0.7, innerShadow * 0.3);

  float innerRim = smoothstep(0.0, 2.0, distFromEdge) * (1.0 - smoothstep(2.0, 5.0, distFromEdge));
  color += vec3(innerRim * 0.15 * uSpecular);

  color = mix(color, uTintColor, uTint);

  float alpha = smoothstep(0.0, 1.5, distFromEdge);
  gl_FragColor = vec4(color, alpha);
}`;

  function ensureWebGLStyles() {
    if (document.getElementById("lg-webgl-styles")) return;
    const style = document.createElement("style");
    style.id = "lg-webgl-styles";
    style.textContent = `
      /* Progressive: live CSS frost always on; WebGL canvas layers refraction on top */
      html.lg-mobile-webgl [data-liquid-glass].lg-webgl {
        background-color: rgba(var(--lg-tint-rgb), var(--lg-fallback-tint)) !important;
        backdrop-filter: blur(10px) saturate(1.45) !important;
        -webkit-backdrop-filter: blur(10px) saturate(1.45) !important;
      }
      html.lg-mobile-webgl [data-liquid-glass].lg-webgl::after {
        display: none !important;
      }
      html.lg-mobile-webgl [data-liquid-glass].lg-webgl::before {
        background-color: rgba(var(--lg-tint-rgb), calc(var(--lg-tint-opacity) * 0.55));
      }
      html.lg-mobile-webgl.lg-webgl-ready [data-liquid-glass].lg-webgl {
        /* Once refraction texture is live, dial back milky frost so the lens reads */
        background-color: rgba(var(--lg-tint-rgb), calc(var(--lg-fallback-tint) * 0.35)) !important;
        backdrop-filter: blur(3px) saturate(1.2) !important;
        -webkit-backdrop-filter: blur(3px) saturate(1.2) !important;
      }
      html.lg-mobile-webgl canvas.lg-webgl-surface {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border-radius: inherit;
        z-index: 0;
        pointer-events: none;
        display: block;
      }
    `;
    document.head.appendChild(style);
  }

  function compileShader(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn("[liquid-glass] shader compile failed", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function createWebGLProgram(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, WEBGL_VERT);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, WEBGL_FRAG);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[liquid-glass] program link failed", gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  function initSharedGL() {
    if (webgl.gl) return true;
    const canvas = document.createElement("canvas");
    canvas.id = "lg-webgl-master";
    canvas.setAttribute("aria-hidden", "true");
    canvas.width = 4;
    canvas.height = 4;
    canvas.style.cssText =
      "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
    document.body.appendChild(canvas);
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: true,
    });
    if (!gl) return false;
    const program = createWebGLProgram(gl);
    if (!program) return false;

    const aPos = gl.getAttribLocation(program, "aPos");
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const names = [
      "uResolution",
      "uOrbOrigin",
      "uGlassSize",
      "uRadius",
      "uBezel",
      "uThickness",
      "uIOR",
      "uBlur",
      "uSpecular",
      "uTint",
      "uTintColor",
      "uShadow",
      "uBgTex",
      "uHasBg",
    ];
    const uniforms = {};
    names.forEach((n) => {
      uniforms[n] = gl.getUniformLocation(program, n);
    });

    const bgTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 1×1 placeholder
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([220, 224, 222, 255])
    );

    webgl.gl = gl;
    webgl.glCanvas = canvas;
    webgl.program = program;
    webgl.uniforms = uniforms;
    webgl.buffers = { aPos, buf };
    webgl.bgTex = bgTex;
    return true;
  }

  function resolveHtml2canvasUrl() {
    const scripts = document.querySelectorAll('script[src*="liquid-glass"]');
    const src =
      scripts[scripts.length - 1]?.src ||
      new URL("liquid-glass.js", window.location.href).href;
    return new URL("vendor/html2canvas.min.js", src).href;
  }

  function loadHtml2Canvas() {
    if (webgl.html2canvas) return Promise.resolve(webgl.html2canvas);
    if (typeof window.html2canvas === "function") {
      webgl.html2canvas = window.html2canvas;
      return Promise.resolve(webgl.html2canvas);
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = resolveHtml2canvasUrl();
      s.async = true;
      s.onload = () => {
        if (typeof window.html2canvas === "function") {
          webgl.html2canvas = window.html2canvas;
          resolve(webgl.html2canvas);
        } else {
          reject(new Error("html2canvas missing after load"));
        }
      };
      s.onerror = () => reject(new Error("html2canvas failed to load"));
      document.head.appendChild(s);
    });
  }

  function uploadBgTexture(sourceCanvas) {
    const gl = webgl.gl;
    if (!gl || !sourceCanvas || !sourceCanvas.width || !sourceCanvas.height) return;
    gl.bindTexture(gl.TEXTURE_2D, webgl.bgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      sourceCanvas
    );
    webgl.hasBg = true;
    document.documentElement.classList.add("lg-webgl-ready");
  }

  /** Instant, non-blocking backdrop so the first frame never freezes waiting on html2canvas. */
  function paintFastBackdrop() {
    const w = Math.max(2, window.innerWidth);
    const h = Math.max(2, window.innerHeight);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    const root = getComputedStyle(document.documentElement);
    const foam = root.getPropertyValue("--foam").trim() || "#f7f9f8";
    const mist = root.getPropertyValue("--mist").trim() || "#eef2f0";
    const mistDeep = root.getPropertyValue("--mist-deep").trim() || "#dce5e1";
    const lake = root.getPropertyValue("--bg-lake-glow").trim() || "rgba(47,95,90,0.12)";
    const burg = root.getPropertyValue("--bg-burgundy-glow").trim() || "rgba(122,36,50,0.08)";

    const base = ctx.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, foam);
    base.addColorStop(0.45, mist);
    base.addColorStop(1, mistDeep);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);

    const g1 = ctx.createRadialGradient(w * 0.1, 0, 0, w * 0.1, 0, Math.max(w, h) * 0.7);
    g1.addColorStop(0, lake);
    g1.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g1;
    ctx.fillRect(0, 0, w, h);

    const g2 = ctx.createRadialGradient(w, h * 0.2, 0, w, h * 0.2, Math.max(w, h) * 0.55);
    g2.addColorStop(0, burg);
    g2.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, w, h);

    // Draw in-view same-origin images (portrait, etc.) for richer first-frame refraction
    document.querySelectorAll("img").forEach((img) => {
      if (!img.complete || !img.naturalWidth) return;
      const r = img.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      if (r.bottom < 0 || r.right < 0 || r.top > h || r.left > w) return;
      try {
        ctx.drawImage(img, r.left, r.top, r.width, r.height);
      } catch (_) {
        /* tainted / not ready */
      }
    });
    return c;
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("capture timeout")), ms);
      promise.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  async function captureBackdrop() {
    if (!webgl.active || webgl.capturing || webgl.scrolling) return;
    webgl.capturing = true;
    const gen = ++webgl.captureGen;
    try {
      const h2c = await loadHtml2Canvas();
      if (!webgl.active || gen !== webgl.captureGen) return;

      // Low scale keeps iOS main-thread work bounded
      const scale = Math.min(1, window.devicePixelRatio || 1);
      const snap = await withTimeout(
        h2c(document.body, {
          scale,
          width: window.innerWidth,
          height: window.innerHeight,
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight,
          x: window.scrollX,
          y: window.scrollY,
          scrollX: -window.scrollX,
          scrollY: -window.scrollY,
          backgroundColor: null,
          useCORS: true,
          allowTaint: false,
          logging: false,
          imageTimeout: 1200,
          foreignObjectRendering: false,
          removeContainer: true,
          // Never touch the live DOM — only hide glass inside the clone
          onclone: (doc) => {
            doc
              .querySelectorAll(
                "[data-liquid-glass], canvas.lg-webgl-surface, #lg-webgl-master"
              )
              .forEach((el) => {
                el.style.visibility = "hidden";
              });
          },
          ignoreElements: (el) => {
            if (!el || !el.tagName) return false;
            if (el.id === "lg-webgl-master") return true;
            if (el.classList && el.classList.contains("lg-webgl-surface")) return true;
            return false;
          },
        }),
        2500
      );

      if (!webgl.active || gen !== webgl.captureGen) return;
      if (snap && snap.width > 1 && snap.height > 1) {
        uploadBgTexture(snap);
        scheduleRender();
      }
    } catch (err) {
      // Keep fast backdrop / CSS frost — do not tear down the whole path
      if (!webgl.hasBg) {
        uploadBgTexture(paintFastBackdrop());
        scheduleRender();
      }
    } finally {
      webgl.capturing = false;
    }
  }

  function scheduleCapture(delay) {
    clearTimeout(webgl.captureTimer);
    webgl.captureTimer = setTimeout(() => {
      const run = () => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => captureBackdrop(), { timeout: 600 });
        } else {
          captureBackdrop();
        }
      };
      run();
    }, delay == null ? 280 : delay);
  }

  function scheduleRender() {
    if (webgl.raf) return;
    webgl.raf = requestAnimationFrame(() => {
      webgl.raf = 0;
      renderAllWebGL();
    });
  }

  function tintUniforms() {
    const dark = isDarkMode();
    const cs = getComputedStyle(document.documentElement);
    const rgb = (cs.getPropertyValue("--lg-tint-rgb") || "255, 255, 255")
      .split(",")
      .map((n) => parseFloat(n.trim()) / 255);
    const opacity = parseFloat(cs.getPropertyValue("--lg-tint-opacity")) || ARCHIS.tintOpacity;
    return {
      tint: Math.min(0.35, (Number.isFinite(opacity) ? opacity : 0.06) * (dark ? 1.1 : 1)),
      tintColor: [
        Number.isFinite(rgb[0]) ? rgb[0] : dark ? 0.07 : 1,
        Number.isFinite(rgb[1]) ? rgb[1] : dark ? 0.09 : 1,
        Number.isFinite(rgb[2]) ? rgb[2] : dark ? 0.086 : 1,
      ],
    };
  }

  function clearSurface(surface) {
    const c = surface.canvas;
    if (!c.width || !c.height) return;
    surface.ctx2d.clearRect(0, 0, c.width, c.height);
  }

  function renderOrbWebGL(surface) {
    const gl = webgl.gl;
    const el = surface.el;
    if (!gl || !el.isConnected) return;

    if (
      el.hidden ||
      el.getAttribute("aria-hidden") === "true" ||
      !webgl.hasBg
    ) {
      clearSurface(surface);
      return;
    }

    const rect = el.getBoundingClientRect();
    const wCss = Math.max(2, Math.round(rect.width));
    const hCss = Math.max(2, Math.round(rect.height));
    if (wCss < 2 || hCss < 2 || rect.bottom < -2 || rect.top > window.innerHeight + 2) {
      clearSurface(surface);
      return;
    }

    // Cap DPR to keep mobile GPU / readback cost predictable
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(wCss * dpr));
    const h = Math.max(2, Math.round(hCss * dpr));

    const shape = el.getAttribute("data-liquid-glass") || surface.shape || "circle";
    const radius = resolveCornerRadius(el, shape, wCss, hCss);
    el.style.setProperty("--lg-radius", `${radius}px`);

    const tune = SHAPE_TUNE[shape] || SHAPE_TUNE.circle;
    const dark = isDarkMode();
    const targetBezel = Math.max(10, radius * tune.bezelFrac);
    const bezel = Math.min(
      targetBezel,
      WEBGL_LOOK.bezel,
      Math.max(2, radius - 1),
      Math.min(wCss, hCss) / 2 - 1
    );
    const { tint, tintColor } = tintUniforms();
    const specular =
      tune.specOpacity * (dark ? DARK_GLASS.specOpacityMul : 1) *
      (shape === "circle" ? 0.95 : 1.1);
    const blur = dark ? WEBGL_LOOK.blur * 1.05 : WEBGL_LOOK.blur * 0.9;

    const glCanvas = webgl.glCanvas;
    if (glCanvas.width !== w || glCanvas.height !== h) {
      glCanvas.width = w;
      glCanvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(webgl.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, webgl.buffers.buf);
    gl.enableVertexAttribArray(webgl.buffers.aPos);
    gl.vertexAttribPointer(webgl.buffers.aPos, 2, gl.FLOAT, false, 0, 0);

    const u = webgl.uniforms;
    gl.uniform2f(u.uResolution, window.innerWidth, window.innerHeight);
    gl.uniform2f(u.uOrbOrigin, rect.left, rect.top);
    gl.uniform2f(u.uGlassSize, wCss, hCss);
    gl.uniform1f(u.uRadius, radius);
    gl.uniform1f(u.uBezel, bezel);
    gl.uniform1f(u.uThickness, WEBGL_LOOK.thickness * (tune.scaleRatio || 1));
    gl.uniform1f(u.uIOR, tune.ior);
    gl.uniform1f(u.uBlur, blur);
    gl.uniform1f(u.uSpecular, specular);
    gl.uniform1f(u.uTint, tint);
    gl.uniform3f(u.uTintColor, tintColor[0], tintColor[1], tintColor[2]);
    gl.uniform1f(u.uShadow, WEBGL_LOOK.shadow);
    gl.uniform1f(u.uHasBg, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, webgl.bgTex);
    gl.uniform1i(u.uBgTex, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const out = surface.canvas;
    if (out.width !== w || out.height !== h) {
      out.width = w;
      out.height = h;
    }
    surface.ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    surface.ctx2d.clearRect(0, 0, w, h);
    surface.ctx2d.drawImage(glCanvas, 0, 0);
  }

  function renderAllWebGL() {
    if (!webgl.active || !webgl.gl) return;
    for (let i = 0; i < webgl.surfaces.length; i++) {
      try {
        renderOrbWebGL(webgl.surfaces[i]);
      } catch (_) {
        /* keep going — one bad orb must not freeze the rest */
      }
    }
  }

  function detachWebGLSurfaces() {
    webgl.surfaces.forEach((s) => {
      s.el.classList.remove("lg-webgl");
      if (s.canvas && s.canvas.parentNode) s.canvas.parentNode.removeChild(s.canvas);
    });
    webgl.surfaces = [];
  }

  function attachWebGLSurface(el) {
    el.classList.remove("lg-fallback", "lg-refraction");
    el.classList.add("lg-webgl");
    el.style.removeProperty("--lg-filter");

    let canvas = el.querySelector(":scope > canvas.lg-webgl-surface");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "lg-webgl-surface";
      canvas.setAttribute("aria-hidden", "true");
      el.insertBefore(canvas, el.firstChild);
    }
    const ctx2d = canvas.getContext("2d", { alpha: true });
    const shape = el.getAttribute("data-liquid-glass") || "circle";
    webgl.surfaces.push({ el, canvas, ctx2d, shape });
  }

  function syncWebGLSurfaces(orbs) {
    const keep = new Set();
    const byEl = new Map(webgl.surfaces.map((s) => [s.el, s]));
    const next = [];
    orbs.forEach((el) => {
      const w = Math.max(2, Math.round(el.offsetWidth));
      const h = Math.max(2, Math.round(el.offsetHeight));
      const shape = el.getAttribute("data-liquid-glass") || "circle";
      const radius = resolveCornerRadius(el, shape, w, h);
      el.style.setProperty("--lg-radius", `${radius}px`);

      let surface = byEl.get(el);
      if (surface) {
        el.classList.add("lg-webgl");
        el.classList.remove("lg-fallback", "lg-refraction");
        next.push(surface);
      } else {
        attachWebGLSurface(el);
        surface = webgl.surfaces[webgl.surfaces.length - 1];
        // attach pushed onto webgl.surfaces — move into next
        webgl.surfaces.pop();
        next.push(surface);
      }
      keep.add(el);
    });
    webgl.surfaces.forEach((s) => {
      if (keep.has(s.el)) return;
      s.el.classList.remove("lg-webgl");
      if (s.canvas && s.canvas.parentNode) s.canvas.parentNode.removeChild(s.canvas);
    });
    webgl.surfaces = next;
  }

  function onWebGLScroll() {
    if (!webgl.active) return;
    webgl.scrolling = true;
    // During scroll: keep last refraction frame; CSS frost stays live underneath.
    // Invalidate in-flight captures so they can't apply a mismatched snapshot mid-fling.
    webgl.captureGen++;
    clearTimeout(webgl.scrollIdleTimer);
    webgl.scrollIdleTimer = setTimeout(() => {
      webgl.scrolling = false;
      scheduleCapture(60);
    }, 180);
  }

  function onWebGLPointer() {
    if (!webgl.active) return;
    // Coalesce drag/magnetic moves — avoid a GL readback storm on every touch event
    clearTimeout(webgl.pointerTimer);
    webgl.pointerTimer = setTimeout(scheduleRender, 32);
  }

  function bindWebGLListeners() {
    if (webgl.listenersBound) return;
    webgl.listenersBound = true;
    window.addEventListener("scroll", onWebGLScroll, { passive: true });
    window.addEventListener("pointermove", onWebGLPointer, { passive: true });
    window.addEventListener("pointerup", onWebGLPointer, { passive: true });
  }

  function unbindWebGLListeners() {
    if (!webgl.listenersBound) return;
    webgl.listenersBound = false;
    window.removeEventListener("scroll", onWebGLScroll);
    window.removeEventListener("pointermove", onWebGLPointer);
    window.removeEventListener("pointerup", onWebGLPointer);
  }

  function teardownWebGL() {
    webgl.active = false;
    webgl.captureGen++;
    cancelAnimationFrame(webgl.raf);
    webgl.raf = 0;
    clearTimeout(webgl.captureTimer);
    clearTimeout(webgl.scrollIdleTimer);
    clearTimeout(webgl.pointerTimer);
    unbindWebGLListeners();
    detachWebGLSurfaces();
    webgl.hasBg = false;
    document.documentElement.classList.remove(
      "lg-mobile-webgl",
      "lg-webgl-ready",
      "lg-capturing"
    );
  }

  function fallbackMobileToLucas(orbs) {
    // Legacy WebGL failure path → same plain frost as primary mobile mode.
    initMobileFrosted(orbs);
  }

  function ensureMobileFrostStyles() {
    if (document.getElementById("lg-mobile-frost-styles")) return;
    const style = document.createElement("style");
    style.id = "lg-mobile-frost-styles";
    // Match main chatbot mobile frost: milky tint + blur(14px), no refraction.
    style.textContent = `
      html.lg-mobile-frost [data-liquid-glass].lg-fallback,
      html.lg-mobile-frost [data-liquid-glass] {
        background-color: rgba(var(--lg-tint-rgb), var(--lg-fallback-tint)) !important;
        backdrop-filter: blur(14px) saturate(1.5) !important;
        -webkit-backdrop-filter: blur(14px) saturate(1.5) !important;
      }
      html.lg-mobile-frost [data-liquid-glass]::after,
      html.lg-mobile-frost [data-liquid-glass].lg-refraction::after,
      html.lg-mobile-frost [data-liquid-glass].lg-fallback::after {
        display: none !important;
      }
      html.lg-mobile-frost [data-liquid-glass] canvas.lg-webgl-surface,
      html.lg-mobile-frost canvas.lg-webgl-surface {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  /** Mobile-only: plain frosted glass everywhere. Desktop Chromium path unchanged. */
  function initMobileFrosted(orbs) {
    ensureMobileFrostStyles();
    if (webgl.active) teardownWebGL();
    document.documentElement.classList.add("lg-mobile-frost");
    document.documentElement.classList.remove(
      "lg-chrome",
      "lg-mobile-webgl",
      "lg-webgl-ready",
      "lg-capturing"
    );

    orbs.forEach((el) => {
      const w = Math.max(2, Math.round(el.offsetWidth));
      const h = Math.max(2, Math.round(el.offsetHeight));
      const shape = el.getAttribute("data-liquid-glass") || "circle";
      const radius = resolveCornerRadius(el, shape, w, h);
      el.style.setProperty("--lg-radius", `${radius}px`);
      el.style.removeProperty("--lg-filter");

      el.classList.remove("lg-webgl", "lg-refraction");
      el.classList.add("lg-fallback");

      const canvas = el.querySelector(":scope > canvas.lg-webgl-surface");
      if (canvas) canvas.remove();
    });
  }

  function initWebGLAll(orbs) {
    // Kept for optional re-enable; mobile now uses initMobileFrosted.
    ensureWebGLStyles();
    document.documentElement.classList.add("lg-mobile-webgl");
    document.documentElement.classList.remove("lg-chrome", "lg-mobile-frost");

    if (!initSharedGL()) {
      fallbackMobileToLucas(orbs);
      return;
    }

    const already = webgl.active;
    // Soft sync reuses existing canvases — no GL teardown / flash on reinit
    syncWebGLSurfaces(orbs);
    webgl.active = true;
    bindWebGLListeners();

    // Instant first frame: cheap painted backdrop (never blocks on html2canvas)
    if (!webgl.hasBg) {
      uploadBgTexture(paintFastBackdrop());
    }
    scheduleRender();

    // Richer DOM snapshot when idle — scroll-end also refreshes
    scheduleCapture(already ? 220 : 450);
  }

  function initAll() {
    const orbs = document.querySelectorAll("[data-liquid-glass]");
    if (!orbs.length) return;

    const dark = isDarkMode();
    document.documentElement.classList.toggle("lg-dark", dark);

    // Mobile → plain frosted glass (chatbot look). Desktop unchanged below.
    if (isMobileLiquidGlass()) {
      if (chromeGlassObserver) {
        chromeObserved.forEach((el) => chromeGlassObserver.unobserve(el));
        chromeObserved.clear();
      }
      document.getElementById("lg-chrome-wash")?.remove();
      document.documentElement.classList.remove("lg-scrolling");
      initMobileFrosted(orbs);
      return;
    }

    // Leaving mobile: drop WebGL / mobile frost markers
    if (webgl.active) teardownWebGL();
    document.documentElement.classList.remove("lg-mobile-frost");

    const useSvgBackdrop = isChromiumSvgBackdrop();
    // Tint / rim / outer shadow come from CSS (light + prefers-color-scheme: dark).
    // JS only rebuilds the refraction filter graph for dark frosting/specular.
    document.documentElement.classList.toggle("lg-chrome", useSvgBackdrop);

    if (useSvgBackdrop) {
      ensureChromePerfStyles();
      ensureChromeWash();
      bindChromeScrollPerf();
    } else {
      document.getElementById("lg-chrome-wash")?.remove();
    }

    orbs.forEach((el) => {
      el.classList.remove("lg-webgl");
      const canvas = el.querySelector(":scope > canvas.lg-webgl-surface");
      if (canvas) canvas.remove();
      initOrb(el, useSvgBackdrop);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          initAll();
          initMagneticCorners();
        })
      );
    });
  } else {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        initAll();
        initMagneticCorners();
      })
    );
  }

  window.addEventListener(
    "resize",
    (() => {
      let t;
      return () => {
        clearTimeout(t);
        t = setTimeout(initAll, 150);
      };
    })()
  );

  // Rebuild glass when the OS / browser color scheme flips
  const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = () => requestAnimationFrame(() => requestAnimationFrame(initAll));
  if (typeof schemeQuery.addEventListener === "function") {
    schemeQuery.addEventListener("change", onSchemeChange);
  } else if (typeof schemeQuery.addListener === "function") {
    schemeQuery.addListener(onSchemeChange);
  }

  // Magnetic hover — logo / social / Google orbs follow the pointer slightly.
  // Shares _mx/_my/_bx/_by with page drag code (index.html applyT).
  function applyMagneticT(el) {
    const bx = el._bx || 0;
    const by = el._by || 0;
    const mx = el._mx || 0;
    const my = el._my || 0;
    const chrome = document.documentElement.classList.contains("lg-chrome");
    if (!chrome || el._drag) {
      el.style.transform = `translate(${bx + mx}px, ${by + my}px)`;
      return;
    }
    const along = el._lgAlong || 1;
    const perp = el._lgPerp || 1;
    const rot = el._lgRot || 0;
    const press = el._lgPress || 1;
    // Rectangles: axis-aligned scaleX/Y (90° corners). Orbs: rotate-squash.
    if (el._lgMagClamp || rot === 0) {
      el.style.transform =
        `translate(${bx + mx}px, ${by + my}px) scale(${along * press}, ${perp * press})`;
      return;
    }
    el.style.transform =
      `translate(${bx + mx}px, ${by + my}px) ` +
      `rotate(${rot}deg) scale(${along * press}, ${perp * press}) rotate(${-rot}deg)`;
  }
  window.__lgApplyTransform = applyMagneticT;

  function setLiquidSquish(el, clientX, clientY, rect, clamp) {
    const nx = Math.max(
      -1,
      Math.min(1, ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1)
    );
    const ny = Math.max(
      -1,
      Math.min(1, ((clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1)
    );
    const falloff = Math.min(1, Math.hypot(nx, ny));
    if (clamp) {
      // Axis-aligned squash/stretch: scaleX/scaleY independently so every
      // corner stays 90°. No rotation — that shears the long edges.
      const ax = Math.abs(nx);
      const ay = Math.abs(ny);
      const amount = 0.04;
      const maxGrowPx = 3;
      let sx = 1 + amount * ax - amount * 0.5 * ay;
      let sy = 1 + amount * ay - amount * 0.5 * ax;
      const cap = (s, size) => {
        const growPx = Math.abs(s - 1) * size * 0.5;
        if (growPx <= maxGrowPx) return s;
        const delta = (2 * maxGrowPx) / Math.max(size, 1);
        return s >= 1 ? 1 + delta : 1 - delta;
      };
      el._lgAlong = cap(sx, rect.width);
      el._lgPerp = cap(sy, rect.height);
      el._lgRot = 0;
      return;
    }
    // ~4% directional stretch, pixel-capped so orbs stay clear of neighbors.
    const maxGrowPx = 4;
    let along = 1 + 0.04 * falloff;
    const growPx = (along - 1) * Math.max(rect.width, rect.height) * 0.5;
    if (growPx > maxGrowPx) {
      along = 1 + (2 * maxGrowPx) / Math.max(rect.width, rect.height, 1);
    }
    el._lgAlong = along;
    el._lgPerp = 1 - (along - 1) * 0.5;
    el._lgRot = Math.atan2(ny, nx) * (180 / Math.PI);
  }

  function clearLiquidSquish(el) {
    el._lgAlong = 1;
    el._lgPerp = 1;
    el._lgRot = 0;
    el._lgPress = 1;
  }

  function trackPointer(e) {
    lastPtr.x = e.clientX;
    lastPtr.y = e.clientY;
    lastPtr.has = true;
    if (reduceMotionGlow) return;
    if (document.documentElement.classList.contains("lg-scrolling")) return;
    if (!glowRaf) {
      glowRaf = requestAnimationFrame(() => {
        glowRaf = 0;
        const root = document.documentElement;
        root.style.setProperty("--pointer-x", lastPtr.x + "px");
        root.style.setProperty("--pointer-y", lastPtr.y + "px");
      });
    }
  }
  document.addEventListener("pointermove", trackPointer, {
    passive: true,
    capture: true,
  });
  document.addEventListener("pointerdown", trackPointer, {
    passive: true,
    capture: true,
  });

  function updateMagnetic(el, clientX, clientY) {
    if (!el || !el._lgMagneticBound) return;
    if (el._drag) return;
    const chrome = document.documentElement.classList.contains("lg-chrome");
    if (chrome && document.documentElement.classList.contains("lg-scrolling")) {
      return;
    }
    const strength = el._lgMagStrength || 0.28;
    const clamp = !!el._lgMagClamp;
    const r = el.getBoundingClientRect();
    let mx = (clientX - r.left - r.width / 2) * strength;
    let my = (clientY - r.top - r.height / 2) * strength;
    if (clamp) {
      const lim = el._lgMagLim || computeMagneticLimits(el);
      el._lgMagLim = lim;
      mx = Math.max(-lim.l, Math.min(lim.r, mx));
      my = Math.max(-lim.t, Math.min(lim.b, my));
    }
    el._mx = mx;
    el._my = my;
    if (chrome) setLiquidSquish(el, clientX, clientY, r, clamp);
    applyMagneticT(el);
  }

  function syncMagneticFromPointer() {
    if (!lastPtr.has) return;
    const hit = document.elementFromPoint(lastPtr.x, lastPtr.y);
    if (!hit || typeof hit.closest !== "function") return;
    let node = hit;
    const seen = new Set();
    while (node && node !== document.documentElement) {
      if (node._lgMagneticBound && !seen.has(node)) {
        seen.add(node);
        updateMagnetic(node, lastPtr.x, lastPtr.y);
      }
      node = node.parentElement;
    }
  }

  function computeMagneticLimits(el) {
    const cap = 6 * STATIC_BOX_MAG_SCALE;
    const limits = { l: cap, r: cap, t: cap, b: cap };
    const r = el.getBoundingClientRect();
    const others = document.querySelectorAll(STATIC_BOX_SEL);
    for (let i = 0; i < others.length; i++) {
      const other = others[i];
      if (other === el) continue;
      const o = other.getBoundingClientRect();
      const overlapY = Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top);
      const overlapX = Math.min(r.right, o.right) - Math.max(r.left, o.left);
      if (overlapY > 4) {
        const gapRight = o.left - r.right;
        if (gapRight >= -1 && gapRight < 48) {
          limits.r = Math.min(
            limits.r,
            Math.max(0, (gapRight / 2 - 2) * STATIC_BOX_MAG_SCALE)
          );
        }
        const gapLeft = r.left - o.right;
        if (gapLeft >= -1 && gapLeft < 48) {
          limits.l = Math.min(
            limits.l,
            Math.max(0, (gapLeft / 2 - 2) * STATIC_BOX_MAG_SCALE)
          );
        }
      }
      if (overlapX > 4) {
        const gapBottom = o.top - r.bottom;
        if (gapBottom >= -1 && gapBottom < 48) {
          limits.b = Math.min(
            limits.b,
            Math.max(0, (gapBottom / 2 - 2) * STATIC_BOX_MAG_SCALE)
          );
        }
        const gapTop = r.top - o.bottom;
        if (gapTop >= -1 && gapTop < 48) {
          limits.t = Math.min(
            limits.t,
            Math.max(0, (gapTop / 2 - 2) * STATIC_BOX_MAG_SCALE)
          );
        }
      }
    }
    return limits;
  }

  function bindMagnetic(el, strength, opts) {
    if (!el || el._lgMagneticBound) return;
    el._lgMagneticBound = true;
    const clamp = !!(opts && opts.clamp);
    el._lgMagStrength = strength;
    el._lgMagClamp = clamp;
    el.addEventListener("pointerenter", () => {
      if (!el._lgMagClamp) return;
      el._lgMagLim = computeMagneticLimits(el);
    });
    el.addEventListener("pointermove", (e) => {
      el._lgPtrX = e.clientX;
      el._lgPtrY = e.clientY;
      const chrome = document.documentElement.classList.contains("lg-chrome");
      if (chrome) {
        if (el._lgMagRaf) return;
        el._lgMagRaf = requestAnimationFrame(() => {
          el._lgMagRaf = 0;
          updateMagnetic(el, el._lgPtrX, el._lgPtrY);
        });
        return;
      }
      updateMagnetic(el, e.clientX, e.clientY);
    });
    el.addEventListener("pointerdown", () => {
      if (!document.documentElement.classList.contains("lg-chrome")) return;
      if (el._drag) return;
      // Rectangles keep concentric bounds — no press squash. Orbs still flex.
      if (el._lgMagClamp) return;
      el._lgPress = 0.985;
      applyMagneticT(el);
    });
    el.addEventListener("pointerup", () => {
      if (!document.documentElement.classList.contains("lg-chrome")) return;
      if (el._lgMagClamp) return;
      el._lgPress = 1;
      applyMagneticT(el);
    });
    el.addEventListener("pointercancel", () => {
      if (!document.documentElement.classList.contains("lg-chrome")) return;
      if (el._lgMagClamp) return;
      el._lgPress = 1;
      applyMagneticT(el);
    });
    el.addEventListener("pointerleave", (e) => {
      if (el._drag) return;
      if (e.relatedTarget && el.contains(e.relatedTarget)) return;
      el._mx = 0;
      el._my = 0;
      el._lgMagLim = null;
      clearLiquidSquish(el);
      applyMagneticT(el);
    });
  }

  function initMagneticCorners() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document
      .querySelectorAll(".corner:not(.yan-chat-pill)")
      .forEach((el) => bindMagnetic(el, 0.28));
    document
      .querySelectorAll(".stat-tile")
      .forEach((el) => bindMagnetic(el, 0.28));
    document
      .querySelectorAll(".edu-vote")
      .forEach((el) => bindMagnetic(el, 0.28));
    document.querySelectorAll(".yan-chat-pill").forEach((el) => {
      bindMagnetic(el, 0.18);
      const chat = el.closest(".yan-chat");
      el._lgMagClamp = !!(chat && chat.classList.contains("is-open"));
    });
    document
      .querySelectorAll(".yan-chat-close")
      .forEach((el) => bindMagnetic(el, 0.28));
    document.querySelectorAll(".yan-chat-panel").forEach((el) => {
      bindMagnetic(el, 0.28 * STATIC_BOX_MAG_SCALE, { clamp: true });
    });
    if (document.documentElement.classList.contains("lg-chrome")) {
      document
        .querySelectorAll(STATIC_BOX_SEL)
        .forEach((el) =>
          bindMagnetic(el, 0.28 * STATIC_BOX_MAG_SCALE, { clamp: true })
        );
    }
    syncMagneticFromPointer();
  }

  // Allow chatbot (and other UI) to rebuild filters after size/shape changes.
  window.reinitLiquidGlass = () => {
    const finish = () => {
      chromeReinitLock = 0;
      initAll();
      initMagneticCorners();
    };
    if (document.documentElement.classList.contains("lg-chrome")) {
      if (chromeReinitLock) return;
      chromeReinitLock = 1;
      // Same turn as the DOM swap so the box never paints at identity.
      queueMicrotask(finish);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(finish));
  };
})();
