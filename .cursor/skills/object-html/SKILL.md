---
name: object-html
description: >-
  Create a self-contained static HTML file for an education object
  (todo, date, project, class, or user-level folder). Quotes.html lake/teal
  theme with light and dark palettes; desktop follows sunrise/sunset, phone
  follows the device. Class HTML is stored in that class's OneDrive folder.
  Todo / date / project HTML still sits next to todo.json / date.json /
  project.json. Not public yanylevin.com pages (that is yanylevin-webpage-create).
---

# Static HTML in an object

**One `.html` file. That is the whole page.** Inline `<style>` and `<script>`. No `styles.css`, no `theme.js`, no `sun-theme.js` sitting next to it, no `<link>` / `<script src>`. The dashboard opens a blob of that single file (web) or Quick Look (iOS). Sibling assets do not load.

Dropped next to `todo.json` / `date.json` / `project.json`, or in the class OneDrive folder only when the page is class-level (not a todo). No `/education/styles.css`, no liquid glass, no Karla, no YL orbs.

Public yanylevin.com pages are `.cursor/skills/yanylevin-webpage-create/SKILL.md`. Chat HTML fences are `.cursor/skills/chat-widgets/SKILL.md`. Copies of a live liquid-glass page into a project stay copies of that page.

**Canonical clone.** Copy chrome from these, do not invent a new look:

- Layout + light tokens: `$HOME/Documents/11th Grade/F. American Lit/.HW Sep 9 Summer Read/quotes.html`
- Dark tokens + optional good/bad marks: `$HOME/Documents/11th Grade/D. Spanish 4/.HW Sep 8 8-9 de septiembre CUESTIONARIO inicio de año/errores.html`

Do not run the frontend-design unique-aesthetic playbook. No Inter, no purple, no new display font.

Apply Unslop to headings and agent-written copy. Quoted source text can keep the book's punctuation.

## 1. Where it lives

| Ask | File |
|---|---|
| Quotes on a class todo | that class’s OneDrive Finder folder `/quotes.html` (`HW Sep 15 Title/quotes.html`) |
| Errors on a class todo | `…/<Finder name>/errores.html` (or `errors.html`) |
| Notes on a project | `education/<email>/projects/<id>/notes.html` |
| Anything on a **class** page | the visible class OneDrive folder (e.g. `…/11th Grade/H. Physics/quotes.html`). Not `.education/`, not `education/<email>/classes/`. |

Todo / date / project HTML still sits beside the properties JSON. Class HTML shows in the class file tiles from OneDrive (live). Basename the user would tap. Show in the file tiles unless they asked to hide (`hiddenFiles`).

Images that must work in a blob are data URIs. No Google Fonts.

Class OneDrive writes are not git education data. Do not `npm run deploy:web`. Do not restart the Express API. The SSE watcher on the grade folder refreshes the class page.

## 2. Theme

Both palettes live in the same `<style>` block. Solar math lives in the same file's `<script>`. Duplicate that script into every page. Do **not** bake a single theme from the clock at generation time.

| Surface | How it picks light vs dark |
|---|---|
| Phone, iOS Quick Look, no JS | `@media (prefers-color-scheme: dark)` |
| Desktop browser (hover + fine pointer) | Sunrise → sunset light, else dark. Same lat/lng and solar math as `yan-sun-theme.js` |

That matches `/education`: desktop follows the sun, phone stays on the device.

**Light vs dark may change colors only.** The dark block retints the custom properties below. It must not change `font-family`, font size, weight, line-height, letter-spacing, `border-radius`, padding, margin, max-width, or `text-transform`.

### Tokens

Light (`:root`) from quotes.html. Dark from errores.html. The `--accent` and `--ok` values come from `brand/palette.mjs` (personal) through `npm run brand`. Copy whatever this block says today. Files you already wrote keep their colors.

<!-- brand:object-html-personal -->
```css
:root {
  color-scheme: light dark;
  --bg: #e8edf2;
  --fg: #14181d;
  --muted: #5a6470;
  --accent: #1b7d8a;
  --card: rgba(255, 255, 255, 0.72);
  --line: rgba(20, 24, 29, 0.12);
  --bad: #b42318;
  --bad-bg: rgba(180, 35, 24, 0.12);
  --good: #0f7a45;
  --good-bg: rgba(15, 122, 69, 0.12);
  --ok: #1b7d8a;
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-resolved-theme="light"]) {
    --bg: #12161b;
    --fg: #e8edf2;
    --muted: #9aa3ad;
    --accent: #71c4c2;
    --card: rgba(28, 34, 41, 0.88);
    --line: rgba(232, 237, 242, 0.1);
    --bad: #ff7a72;
    --bad-bg: rgba(255, 122, 114, 0.16);
    --good: #5dcc8a;
    --good-bg: rgba(93, 204, 138, 0.14);
    --ok: #71c4c2;
  }
}
html[data-resolved-theme="dark"] {
  --bg: #12161b;
  --fg: #e8edf2;
  --muted: #9aa3ad;
  --accent: #71c4c2;
  --card: rgba(28, 34, 41, 0.88);
  --line: rgba(232, 237, 242, 0.1);
  --bad: #ff7a72;
  --bad-bg: rgba(255, 122, 114, 0.16);
  --good: #5dcc8a;
  --good-bg: rgba(93, 204, 138, 0.14);
  --ok: #71c4c2;
}
```
<!-- brand:end -->

`--bad` / `--good` / `--ok` are for marked-up corrections. A quotes page can omit using them. Do not invent a second teal.

Need both the media query **and** `html[data-resolved-theme="dark"]`. Desktop night with OS set to light only hits the attribute. Desktop day with OS set to dark is why the media query is `:not([data-resolved-theme="light"])`.

**JYPE objects** (`education/projects/jype/…`) use the same layout with the red wash from `/jype/styles.css`, not lake/teal. Accent values come from `brand/palette.mjs` (jype):

<!-- brand:object-html-jype -->
```css
:root {
  --bg: #f2e7e8;
  --accent: #c2273a;
  --ok: #c2273a;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-resolved-theme="light"]) {
    --bg: #160c0f;
    --accent: #e07a82;
    --ok: #e07a82;
    --card: rgba(40, 22, 26, 0.88);
  }
}
html[data-resolved-theme="dark"] {
  --bg: #160c0f;
  --accent: #e07a82;
  --ok: #e07a82;
  --card: rgba(40, 22, 26, 0.88);
}
```
<!-- brand:end -->

`--fg`, `--muted`, `--line`, `--bad`, `--good` stay as above. Do not mix teal onto a JYPE page.

### Layout defaults (quotes.html)

Keep these on every page. Dark mode does not restyle them.

- `body`: `margin: 0; padding: 28px 20px 64px; background: var(--bg); color: var(--fg); font: 17px/1.45 var(--font);`
- `main`: `max-width: 40rem; margin: 0 auto;`
- `h1`: `28px`, weight `650`, `letter-spacing: -0.02em`
- `.sub`: `15px`, `color: var(--muted)`
- Section `h2`: `13px`, weight `650`, `letter-spacing: 0.06em`, uppercase, `color: var(--accent)`
- Cards (`blockquote`, `article`, or equivalent): `background: var(--card); border: 1px solid var(--line); border-radius: 12px;`

A corrections page may use `del` / `ins` / `.fix` like errores.html. Radius and type stay as above. errores.html's 14px cards were the old one-off; new files use 12px.

## 3. Skeleton

Copy this into the new file, then fill in title and `<main>`. The second `<script>` is the solar math. Leave it intact. Do not move it to another file.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <script>
    (function () {
      try {
        var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        var r = document.documentElement;
        r.dataset.theme = "system";
        r.dataset.resolvedTheme = dark ? "dark" : "light";
        r.style.colorScheme = dark ? "dark" : "light";
      } catch (e) {}
    })();
  </script>
  <script>
    (() => {
      const LAT = 47.6815;
      const LNG = -122.2087;
      const PI = Math.PI;
      const rad = PI / 180;
      const dayMs = 864e5;
      const J1970 = 2440588;
      const J2000 = 2451545;
      const e = rad * 23.4397;
      const J0 = 0.0009;
      const SUNSET_ANGLE = -0.833 * rad;
      let timer = 0;
      function toJulian(date) { return date.valueOf() / dayMs - 0.5 + J1970; }
      function fromJulian(j) { return new Date((j + 0.5 - J1970) * dayMs); }
      function toDays(date) { return toJulian(date) - J2000; }
      function solarMeanAnomaly(d) { return rad * (357.5291 + 0.98560028 * d); }
      function eclipticLongitude(M) {
        const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
        return M + C + rad * 102.9372 + PI;
      }
      function declination(l) { return Math.asin(Math.sin(l) * Math.sin(e)); }
      function julianCycle(d, lw) { return Math.round(d - J0 - lw / (2 * PI)); }
      function approxTransit(Ht, lw, n) { return J0 + (Ht + lw) / (2 * PI) + n; }
      function solarTransitJ(ds, M, L) {
        return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
      }
      function hourAngle(h, phi, dec) {
        return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
      }
      function getTimes(date) {
        const lw = rad * -LNG;
        const phi = rad * LAT;
        const d = toDays(date);
        const n = julianCycle(d, lw);
        const ds = approxTransit(0, lw, n);
        const M = solarMeanAnomaly(ds);
        const L = eclipticLongitude(M);
        const dec = declination(L);
        const Jnoon = solarTransitJ(ds, M, L);
        const w = hourAngle(SUNSET_ANGLE, phi, dec);
        const a = approxTransit(w, lw, n);
        const Jset = solarTransitJ(a, M, L);
        const Jrise = Jnoon - (Jset - Jnoon);
        return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset) };
      }
      function isDay(now = Date.now()) {
        const { sunrise, sunset } = getTimes(new Date(now));
        return now >= sunrise.getTime() && now < sunset.getTime();
      }
      function nextFlipMs(now = Date.now()) {
        const { sunrise, sunset } = getTimes(new Date(now));
        if (now < sunrise.getTime()) return sunrise.getTime() - now;
        if (now < sunset.getTime()) return sunset.getTime() - now;
        return Math.max(1000, getTimes(new Date(now + dayMs)).sunrise.getTime() - now);
      }
      function isDesktopWeb() {
        return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
      }
      function osResolved() {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
      function resolvedSystem() {
        if (!isDesktopWeb()) return osResolved();
        return isDay() ? "light" : "dark";
      }
      function paint(resolved) {
        const html = document.documentElement;
        if ((html.getAttribute("data-theme") || "system") !== "system") return;
        html.setAttribute("data-resolved-theme", resolved);
        html.style.colorScheme = resolved;
      }
      function refresh() { paint(resolvedSystem()); }
      function schedule() {
        clearTimeout(timer);
        if (!isDesktopWeb()) return;
        const wait = Math.min(Math.max(nextFlipMs() + 400, 1000), 6 * 60 * 60 * 1000);
        timer = window.setTimeout(() => { refresh(); schedule(); }, wait);
      }
      refresh();
      schedule();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        refresh();
        schedule();
      });
      const desktopQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
      const onDesktopChange = () => { refresh(); schedule(); };
      if (typeof desktopQuery.addEventListener === "function") desktopQuery.addEventListener("change", onDesktopChange);
      else if (typeof desktopQuery.addListener === "function") desktopQuery.addListener(onDesktopChange);
    })();
  </script>
  <title>…</title>
  <style>
    /* tokens from section 2, then layout */
  </style>
</head>
<body>
  <main>
    <h1>…</h1>
    <p class="sub">…</p>
  </main>
</body>
</html>
```

If JS never runs, the media query still switches. If the sun script never runs, the boot + media query still follow the device. Hardcoding light or dark at write time is a stuck file. Do not do that.

## 4. Content

1. `h1` + one `.sub` line
2. Sentence-case headings
3. Cards for each chunk (quote, question, note)
4. Write like a person. No "Additionally", no emoji in headings

## Checklist

- [ ] Class pages: one `.html` in the class OneDrive folder. Todo / date / project: one `.html` beside the JSON. No sibling `.css` / `.js`
- [ ] No `<link rel="stylesheet">`, no `<script src>`
- [ ] Both palettes; dark block is colors only
- [ ] Boot script + solar math inlined in `<head>`
- [ ] System font stack from `--font`, not Karla
- [ ] No liquid glass / orbs / Vercel deploy
