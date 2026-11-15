/**
 * iMessage-style send: clone of the user bubble springs from the composer
 * into the transcript. Scale and position only (ChatSendFlight.swift).
 */
(() => {
  const RESPONSE = 0.35;
  const DAMPING = 0.72;
  const TIMEOUT_MS = 1200;

  /** @type {{ cancel: () => void } | null} */
  let active = null;

  function springFrame(onUpdate, onDone) {
    const stiffness = (2 * Math.PI / RESPONSE) ** 2;
    const damp = 2 * DAMPING * Math.sqrt(stiffness);
    let x = 0;
    let v = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (now) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      v += (stiffness * (1 - x) - damp * v) * dt;
      x += v * dt;
      if (onUpdate(x) === false) return;
      if (Math.abs(1 - x) < 0.001 && Math.abs(v) < 0.01) {
        onUpdate(1);
        onDone();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }

  function finish(destEl, overlay, root) {
    destEl?.classList.remove("is-flying");
    overlay?.remove();
    root?.classList.remove("is-send-flight");
  }

  /** Opacity the bubble really paints at: its own ancestors up to the chat root. */
  function paintedOpacity(el, root) {
    let o = 1;
    for (let n = el?.parentElement; n && n !== root; n = n.parentElement) {
      const v = parseFloat(getComputedStyle(n).opacity);
      if (Number.isFinite(v)) o *= v;
    }
    return o;
  }

  /**
   * @param {{
   *   destEl: HTMLElement,
   *   originRect: DOMRect,
   *   root: HTMLElement,
   *   reduceMotion?: boolean,
   *   onDone?: () => void,
   * }} opts
   */
  window.yanChatSendFlight = function yanChatSendFlight(opts) {
    const destEl = opts.destEl;
    const originRect = opts.originRect;
    const root = opts.root;
    let doneCalled = false;
    const done = () => {
      if (doneCalled) return;
      doneCalled = true;
      try {
        opts.onDone?.();
      } catch {
        /* ignore */
      }
    };
    if (active) {
      active.cancel();
      active = null;
    }
    if (!destEl || !originRect || !root) {
      root?.classList.remove("is-send-flight");
      done();
      return;
    }
    if (opts.reduceMotion || originRect.width < 2 || originRect.height < 2) {
      root.classList.remove("is-send-flight");
      done();
      return;
    }

    destEl.classList.add("is-flying");

    let cancelled = false;
    let stopSpring = () => {};
    let timeout = 0;
    /** @type {HTMLElement | null} */
    let overlay = null;

    const cancel = () => {
      cancelled = true;
      stopSpring();
      window.clearTimeout(timeout);
      finish(destEl, overlay, root);
      if (active && active.cancel === cancel) active = null;
      done();
    };
    active = { cancel };

    const start = () => {
      if (cancelled) return;
      // Layout size, not the painted box: the panel may still be scaling in.
      const w = destEl.offsetWidth;
      const h = destEl.offsetHeight;
      if (!destEl.isConnected || w < 2 || h < 2) {
        cancel();
        return;
      }

      overlay = document.createElement("div");
      overlay.className = "yan-chat-flight";
      overlay.setAttribute("aria-hidden", "true");
      const clone = destEl.cloneNode(true);
      clone.classList.remove("is-flying");
      clone.classList.add("yan-chat-bubble--flight");
      clone.removeAttribute("data-liquid-glass");
      clone.removeAttribute("data-filter-id");
      clone.querySelectorAll("canvas").forEach((el) => el.remove());
      const spec = destEl.style.getPropertyValue("--lg-spec");
      const specOp = destEl.style.getPropertyValue("--lg-spec-opacity");
      if (spec) clone.style.setProperty("--lg-spec", spec);
      if (specOp) clone.style.setProperty("--lg-spec-opacity", specOp);
      overlay.appendChild(clone);
      root.appendChild(overlay);

      clone.style.position = "fixed";
      clone.style.left = "0px";
      clone.style.top = "0px";
      clone.style.width = `${w}px`;
      clone.style.margin = "0";
      clone.style.transformOrigin = "0 0";
      clone.style.pointerEvents = "none";
      clone.style.zIndex = "96";
      clone.style.alignSelf = "auto";
      clone.style.willChange = "transform, opacity";

      const startScale = Math.min(0.92, originRect.height / Math.max(h, 1));
      // The panel can spring in (or the list scroll) under the bubble. Aim at
      // where it is this frame, not where it was when the flight started.
      const apply = (t) => {
        if (!destEl.isConnected) {
          cancel();
          return false;
        }
        const dest = destEl.getBoundingClientRect();
        const destScale = dest.width / Math.max(w, 1);
        const s = startScale + (destScale - startScale) * t;
        const right = originRect.right + (dest.right - originRect.right) * t;
        const bottom = originRect.bottom + (dest.bottom - originRect.bottom) * t;
        clone.style.transform = `translate(${right - w * s}px, ${bottom - h * s}px) scale(${s})`;
        // Leave the composer opaque, land at whatever the turn paints (pending fade, panel fade-in).
        const landing = Math.min(1, Math.max(0, t));
        const target = paintedOpacity(destEl, root);
        clone.style.opacity = String(1 + (target - 1) * landing);
        return true;
      };
      if (apply(0) === false) return;

      timeout = window.setTimeout(cancel, TIMEOUT_MS);
      stopSpring = springFrame(apply, () => {
        window.clearTimeout(timeout);
        if (cancelled) return;
        finish(destEl, overlay, root);
        overlay = null;
        if (active && active.cancel === cancel) active = null;
        done();
      });
    };

    requestAnimationFrame(() => requestAnimationFrame(start));
  };
})();
