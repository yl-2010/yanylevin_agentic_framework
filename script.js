(() => {
  const header = document.querySelector(".site-header");
  const reveals = document.querySelectorAll(".reveal");
  const portrait = document.querySelector(".hero-portrait");
  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const onScroll = () => {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 12);
  };

  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  // Ambient pointer glow + portrait light
  if (!reduceMotion) {
    let rafId = 0;
    let nextX = window.innerWidth * 0.5;
    let nextY = window.innerHeight * 0.35;

    const flushPointer = () => {
      rafId = 0;
      root.style.setProperty("--pointer-x", `${(nextX / window.innerWidth) * 100}%`);
      root.style.setProperty("--pointer-y", `${(nextY / window.innerHeight) * 100}%`);
    };

    window.addEventListener(
      "pointermove",
      (event) => {
        nextX = event.clientX;
        nextY = event.clientY;
        if (!rafId) rafId = requestAnimationFrame(flushPointer);
      },
      { passive: true }
    );
  }

  // Soft interactive tilt / spotlight on the portrait
  if (portrait && !reduceMotion) {
    const img = portrait.querySelector("img");

    const resetPortrait = () => {
      portrait.style.transform = "";
      portrait.style.setProperty("--portrait-x", "50%");
      portrait.style.setProperty("--portrait-y", "30%");
    };

    portrait.addEventListener("pointermove", (event) => {
      const rect = portrait.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      const tiltX = (0.5 - y) * 6;
      const tiltY = (x - 0.5) * 6;

      portrait.style.setProperty("--portrait-x", `${x * 100}%`);
      portrait.style.setProperty("--portrait-y", `${y * 100}%`);
      portrait.style.transform = `translateY(-4px) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`;

      if (img) {
        img.style.transform = `scale(1.05) translate(${(x - 0.5) * -4}px, ${(y - 0.5) * -4}px)`;
      }
    });

    portrait.addEventListener("pointerleave", () => {
      resetPortrait();
      if (img) img.style.transform = "";
    });

    // Perspective parent for tilt
    const hero = document.querySelector(".hero");
    if (hero) hero.style.perspective = "900px";
  }

  // Count-up for academic metrics when they enter view
  const metricValues = document.querySelectorAll(".metric-value");

  const animateCount = (el) => {
    const raw = el.textContent.trim();
    const isDecimal = raw.includes(".");
    const target = Number(raw);
    if (!Number.isFinite(target)) return;

    if (reduceMotion) {
      el.textContent = raw;
      return;
    }

    const duration = 1100;
    const start = performance.now();

    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = target * eased;
      el.textContent = isDecimal ? current.toFixed(2) : String(Math.round(current));
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = raw;
    };

    el.textContent = isDecimal ? "0.00" : "0";
    requestAnimationFrame(tick);
  };

  if (!("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("is-visible"));
    metricValues.forEach(animateCount);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");

        if (entry.target.classList.contains("metric-value") || entry.target.querySelector?.(".metric-value")) {
          const value = entry.target.classList.contains("metric-value")
            ? entry.target
            : entry.target.querySelector(".metric-value");
          if (value && !value.dataset.counted) {
            value.dataset.counted = "1";
            animateCount(value);
          }
        }

        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
  );

  reveals.forEach((el) => observer.observe(el));

  // Also observe metric items specifically for count-up
  document.querySelectorAll(".metrics li").forEach((li) => observer.observe(li));

  // Magnetic pull on primary CTAs: subtle
  if (!reduceMotion) {
    document.querySelectorAll(".btn").forEach((btn) => {
      btn.addEventListener("pointermove", (event) => {
        const rect = btn.getBoundingClientRect();
        const x = event.clientX - rect.left - rect.width / 2;
        const y = event.clientY - rect.top - rect.height / 2;
        btn.style.transform = `translate(${x * 0.12}px, ${y * 0.18 - 2}px)`;
      });

      btn.addEventListener("pointerleave", () => {
        btn.style.transform = "";
      });
    });
  }
})();
