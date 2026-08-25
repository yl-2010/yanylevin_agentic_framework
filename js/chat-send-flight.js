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
      onUpdate(x);
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

  /**
   * @param {{
   *   destEl: HTMLElement,
   *   originRect: DOMRect,
   *   root: HTMLElement,
   *   reduceMotion?: boolean,
   * }} opts
   */
  window.yanChatSendFlight = function yanChatSendFlight(opts) {
    const destEl = opts.destEl;
    const originRect = opts.originRect;
    const root = opts.root;
    if (active) {
      active.cancel();
      active = null;
    }
    if (!destEl || !originRect || !root) {
      root?.classList.remove("is-send-flight");
      return;
    }
    if (opts.reduceMotion || originRect.width < 2 || originRect.height < 2) {
      root.classList.remove("is-send-flight");
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
    };
    active = { cancel };

    const start = () => {
      if (cancelled) return;
      const dest = destEl.getBoundingClientRect();
      if (dest.width < 2 || dest.height < 2) {
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
      clone.style.left = `${dest.left}px`;
      clone.style.top = `${dest.top}px`;
      clone.style.width = `${dest.width}px`;
      clone.style.margin = "0";
      clone.style.transformOrigin = "bottom right";
      clone.style.pointerEvents = "none";
      clone.style.zIndex = "96";
      clone.style.alignSelf = "auto";

      const startScale = Math.min(0.92, originRect.height / Math.max(dest.height, 1));
      const tx = originRect.right - dest.right;
      const ty = originRect.bottom - dest.bottom;
      const apply = (t) => {
        const x = tx * (1 - t);
        const y = ty * (1 - t);
        const s = startScale + (1 - startScale) * t;
        clone.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
      };
      apply(0);

      timeout = window.setTimeout(cancel, TIMEOUT_MS);
      stopSpring = springFrame(apply, () => {
        window.clearTimeout(timeout);
        if (cancelled) return;
        finish(destEl, overlay, root);
        overlay = null;
        if (active && active.cancel === cancel) active = null;
      });
    };

    requestAnimationFrame(() => requestAnimationFrame(start));
  };
})();
