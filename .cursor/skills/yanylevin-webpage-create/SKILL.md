---
name: yanylevin-webpage-create
description: >-
  Create a static liquid-glass page on yanylevin.com from a URL the user
  gives (folder + index.html, site chrome, wiggly .sheet cards). Use when
  the user asks for a page at yanylevin.com/..., a liquid-glass report, or
  a site that should match privacy / dashboard chrome.
---

# Create a yanylevin.com page

Repo: `$HOME/yanylevin_agentic_framework` (this repo). Static HTML on Vercel. Filesystem path is the URL.

User gives a URL like `example.com/your-page`. You ship a page that looks like that LinkedIn note: lake/teal glass, Karla, corner YL + theme orb, wiggly content cards.

**Canonical clone.** Copy chrome and card CSS from these, do not invent a new look:

- Layout + cards: `privacy/`
- Wiggly rectangular glass: `dashboard/styles.css` (`.dash-entry` chat cards) + `dashboard/app.js`
- Chrome siblings: `privacy/index.html`, `dashboard/index.html`

Do not run the frontend-design "unique aesthetic" playbook. This is the existing site. No Inter, no purple gradients, no new display font.

Apply Unslop to every heading and sentence on the page. No em dashes.

## 1. Map the URL

| User URL | Files |
|---|---|
| `yanylevin.com/foo/bar` | `foo/bar/index.html` + `foo/bar/styles.css` |
| Live | `https://yanylevin.com/foo/bar/` |

Prefer **folder + `index.html`**, never a lone `foo/bar.html` at the repo root.

Add a trailing-slash redirect in `vercel.json` next to the other app redirects:

```json
{
  "source": "/foo/bar",
  "destination": "/foo/bar/",
  "permanent": true
}
```

Git does **not** auto-deploy. After push, run `npm run deploy:web` or the page stays on GitHub only. `scripts/vercel-ignore.sh` is a leftover skip-build safety net; ignored builds still burned Hobby quota, which is why auto-deploy is off. A public page must live **outside** `education/<email>/`, `fitness/<email>/`, chat/login logs, and `ios/` or it is not a site deploy.

## 2. Page chrome (required)

Copy query-string versions from the newest sibling (`privacy/index.html` or the LinkedIn report). Do not invent new `?v=` tags unless you changed that file.

Every page needs:

1. Theme boot script (sets `data-theme` / `data-resolved-theme` before paint)
2. Favicons `/favicon.svg` + `/favicon-dark.svg`
3. Karla from Google Fonts
4. `/education/styles.css` (tokens, body wash, corner orbs)
5. A page CSS file for layout + `.sheet`
6. Top-left YL squircle linking to `https://yanylevin.com/`
7. Top-right empty circle, `aria-label="Toggle theme"`, `draggable="false"`
8. Hidden SVG `<defs id="liquid-glass-defs">`
9. Scripts, in this order: `/liquid-glass.js`, `/theme-orb.js`, `/yl-home-link.js`

Skeleton (keep the YL path exactly):

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <meta name="robots" content="noindex, nofollow" />
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
    <title>…</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" media="(prefers-color-scheme: light)" />
    <link rel="icon" href="/favicon-dark.svg" type="image/svg+xml" media="(prefers-color-scheme: dark)" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Karla:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/education/styles.css?v=chrome-perf6" />
    <link rel="stylesheet" href="/YOUR/PATH/styles.css" />
  </head>
  <body>
    <a class="corner c-tl squircle" data-liquid-glass="squircle" data-filter-id="lg-tl" href="https://yanylevin.com/" aria-label="Yan Levin home">
      <svg viewBox="0 0 252 252" aria-hidden="true"><path fill="currentColor" d="M229.4,214.58c0,11.34-9.21,20.52-20.55,20.51l-117.33-.11c-2.66-.02-5.21-.49-7.64-1.48-9.37-3.58-14.91-14.5-12.23-24.2.17-.64.37-1.29.61-1.92,0,0,22.86-63.64,22.86-63.64L26.54,49.57c-6.68-9.17-4.66-22.01,4.51-28.69,9.17-6.67,22.01-4.65,28.68,4.51l52.17,71.64,23.93-66.63c3.8-10.58,15.47-16.08,26.05-12.28,10.59,3.81,16.09,15.47,12.28,26.05l-53.8,149.78,88.53.08c11.34.01,20.53,9.21,20.51,20.55Z"/></svg>
    </a>
    <button type="button" class="corner c-tr circle" data-liquid-glass="circle" data-filter-id="lg-tr" aria-label="Toggle theme" draggable="false"></button>

    <main class="report">…</main>

    <svg class="liquid-glass-svg" xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false" color-interpolation-filters="sRGB" style="position:absolute;width:0;height:0;overflow:hidden;pointer-events:none">
      <defs id="liquid-glass-defs"></defs>
    </svg>
    <script src="/liquid-glass.js?v=chrome-perf9"></script>
    <script src="/theme-orb.js?v=chrome-perf5"></script>
    <script src="/yl-home-link.js"></script>
  </body>
</html>
```

Default `noindex`. Drop it only if the user wants the page in search.

`data-filter-id` must be unique per glass node (`lg-tl`, `lg-tr`, then `lg-summary`, `lg-2`, …).

## 3. Wiggly content cards

The working model is dashboard chat history: `.dash-entry` in `dashboard/styles.css` / `dashboard/app.js`. After Chromium init, `liquid-glass.js` adds `lg-static` and magnetic-squashes the box on pointer move.

Public report cards use class `sheet` (already in `isStaticContentBox` + `STATIC_BOX_SEL`). Markup:

```html
<article class="sheet" data-liquid-glass="rounded" data-filter-id="lg-summary" data-lg-radius="22">
  …
</article>
```

Copy glass CSS from the LinkedIn report (which matches `.dash-entry`): frosted base, `::before` tint, `.lg-refraction` clears the frost, `::after` refraction / specular, `html.lg-chrome .sheet.lg-static { transition: transform 0.3s var(--ease); }`.

**Never animate `transform` on `.sheet`.** Magnetic hover writes `el.style.transform`. A CSS animation with `fill-mode: both` or `forwards` that sets `transform: none` wins over that inline style, so the card sits still. Dashboard chat cards fade **opacity only** (`dash-fade`, `backwards`). Login chips that must slide use `backwards` (not `both`) so transform is free after the intro. Hero titles may still use a transform rise. Cards may not.

Do **not** invent `glass-card` / `panel` / `edu-panel` on a public page. A new class sits still until you add it to `isStaticContentBox()` and `STATIC_BOX_SEL` in `liquid-glass.js`.

Corner orbs (`.corner`) are already magnetic. Do not add `sheet` to them.

Copy the rest of the report CSS as needed: `.report` width `min(42rem, calc(100% - 2rem))`, top padding `clamp(7.5rem, 14vh, 9rem)` so copy clears the orbs, `.report-hero` / `.report-meta`, staggered **opacity** delays on sheets, `prefers-reduced-motion`.

Tokens come from `/education/styles.css`: `--fg`, `--muted`, `--accent`, `--hairline`, `--display`, `--ease`, `--lg-*`.

## 4. Content shape

For a note or report:

1. `h1` + one-line meta (`Month D, YYYY · topic`)
2. First `.sheet` is the answer (short). A huge verdict word is fine when the answer is one word.
3. Later sheets are the detail. Sentence-case `h2`.
4. Optional comparison rows (`.matrix` / `.matrix-row` from the LinkedIn CSS)
5. Sources as real links
6. Quiet footer line

Write like a person. Short sentences mixed with longer ones. No "Additionally", no title-case headings, no emoji in headings.

## 5. Education copy (only if asked)

Public URL is not the education dashboard. Putting HTML only under `education/<email>/...` does not publish it.

If the user wants a copy on a project:

1. `cp` the same `index.html` to `education/you@example.com/projects/<id>/<basename>.html`
2. Add that **exact basename** to `hiddenFiles` on `project.json` if they asked to hide it from the UI. Skip this for `CONTEXT.md` / `context.md` (already hidden).

```json
{
  "name": "ExampleCo",
  "order": 2,
  "hiddenFiles": ["linkedin-report-08-24-2026.html"]
}
```

Use absolute site paths (`/education/styles.css`, `/liquid-glass.js`, `/your/page/styles.css`) so a blob open from the dashboard still themes. Do not rename to a dotfile. LaunchAgent `com.personalagent.education-sync` often commits the education tree on its own. You still commit the **public** `foo/bar/` files.

ExampleCo's project folder: `education/you@example.com/projects/sockethr/`.

## 6. Ship

Work on `main`. Commit only your files. `git push origin main`. Then `npm run deploy:web` (this **is** a public page, so it needs a Vercel production deploy). No PR, no feature branch. See `AGENTS.md`.

This is a static page. Do not restart the Express API.

Do not stage unrelated dirty files (other skills, `server/brain-*.js`, user data you did not touch).

Preview from the repo root (`python3 -m http.server`), then after `npm run deploy:web` poll the live URL until it is 200 with your `<title>`. Confirm `/your/page/styles.css` is 200 too.

Headless check that cards became static glass:

```bash
# after JS: class="sheet lg-refraction lg-static"
```

If they stay `class="sheet"` only, `liquid-glass.js` did not treat them as static boxes. If they have `lg-static` but still do not move, a CSS `transform` animation is almost certainly pinning them. Check `animation-fill-mode`.

## Checklist

- [ ] Folder `path/index.html` matches the URL the user gave
- [ ] `vercel.json` trailing-slash redirect
- [ ] Public files not only under `education/<email>/`
- [ ] YL squircle, theme orb, Karla, education CSS, page CSS, three scripts, `liquid-glass-defs`
- [ ] Content cards are `.sheet` with unique `data-filter-id`
- [ ] Card enter animation is opacity only (no `transform`, no `both` fill)
- [ ] Unslop on all copy
- [ ] Pushed `main`, `npm run deploy:web`, live URL 200
- [ ] Education copy + `hiddenFiles` only when asked
