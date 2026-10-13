---
name: create-celebration-website
description: >-
  Build a large one-off celebration site on yanylevin.com for finishing
  a book, an MA, a test, or a project. Each site gets its own
  theme, colors, layout, and pages, with none of the yanylevin or JYPE
  chrome. Deploy it, withhold the URL until the event is over, and
  schedule a future agent to send the link only when a todo, calendar
  end, or bell gives a real clock time. Use when someone asks for a
  celebration site, a done-with page, or a secret page for after an MA,
  test, unit, or project.
---

# Create a celebration website

A public static site for one accomplishment. Study guides use `.cursor/skills/yanylevin-webpage-create/SKILL.md`. This skill leaves that chrome behind.

Yan and the JYPE agent write the public folder. Alex's personal agent stays inside `education/you@example.com/`.

## Size

The Death of a Salesman celebration is the floor. Find it by listing repo-root folders whose names are 24 hex characters and opening the one about that play. Count its pages. Match that spread or go past it. One landing page is too small. A long page split into same-looking chapters is too small.

Every page is finished. Real copy about this accomplishment, its own layout, and at least one thing you can do on the page. A "coming soon" stub does not count. Pages link to each other so you can wander. A front door lists them.

Open that older folder for scale only. Leave its curtains, receipt, type, and palette there.

## Look

Invent the world from the thing being celebrated. A Spanish escrito is a different world from a physics quiz, and both are different from the salesman site. Before you pick colors and type, open the last celebration folder and choose a world that does not resemble it.

Leave these off every page:

- `/education/styles.css`, `/jype/styles.css`, `liquid-glass.js`, `theme-orb.js`, `yl-home-link.js`
- Karla, the YL squircle, the theme orb, lake teal, the JYPE red wash, `.sheet` glass cards
- Dashboard, electives, privacy, and estore chrome
- `/favicon.svg`. Use a data-URI icon in the page's own colors
- Breadcrumbs back to Home, Notes, or a class
- Inter on white, or a purple gradient, as the default look

Each page is its own `index.html` with its own CSS. A shared reset is fine. A shared theme file that makes every page the same card stack is a miss. Different type, different color, different structure, on purpose. Motifs come from the accomplishment. The reading, the shape of the test, the jokes in the chat.

Pile on motion, color, and toys. Confetti, canvas, click effects, whatever fits this theme. Put sound behind a button so a phone in class stays quiet. Honor `prefers-reduced-motion`. The page has to work on a phone. Hover cannot be the only way to use it.

Copy is specific. Names, the assignment, what actually happened. Apply unslop. `noindex, nofollow` on every page.

## URL

```bash
openssl rand -hex 12
```

That is the folder name, 24 hex characters, at the repo root. `<hex>/index.html` and `<hex>/<page>/index.html`. A readable slug like `/spanish-ma-done/` will get opened early. So will a path under `/jype/`, a class folder, or `education/`.

Add a trailing-slash redirect in `vercel.json` for the root, and for a hub path if you add one:

```json
{ "source": "/<hex>", "destination": "/<hex>/", "permanent": true }
```

Link with trailing slashes. Skip a redirect per inner page.

No `sites[]` tile. No notes hub row. No class index link.

## The link

Build and deploy in this turn either way.

**Already over.** They are celebrating something that happened, or they asked for the link. Reply with the live URL. If a future agent is still pending for that send, cancel it so the link does not go out twice.

**Still ahead.** Leave the URL out of the reply, Teams, iMessage, email, and any tile. Say the site is ready. Say when the link will show up, as a clock time, or say they can ask for it. No path and no hex.

Schedule a future agent only when you can name one clock time from a record.

Confident:

- The assessment todo has `dueDate` and `dueTime`, and you have checked whether that time is the start or the end. In-class work often stores the period start. The Spanish 4 escrito todo is due 2026-10-13 at 08:30 because period D starts then. Open `.cursor/skills/class-schedule/SKILL.md` and that person's `education/<email>/schedule.json`, including `dayOverrides`. The send is 5 minutes before the period ends.
- A calendar event with a real end, or a bell you resolved for a named class on a named date. Same 5-minute buffer.
- A timed exam whose end you calculated from a known duration. Send 5 minutes before that end.

A guess does not get a future agent. "When we finish the book", "after the unit", a date with no time, or two possible periods. Tell them the site is ready and they can ask for the link. Still no URL.

Read `.cursor/skills/future-agents/SKILL.md`. In Personal Agent or JYPE chat, call `schedule_future_agent`. On Cursor Desktop, from the repo root:

```bash
node server/future-agents.js schedule --at "2026-10-13T09:35:00-07:00" --prompt "Send the celebration link in this chat. The URL is in your context. Send that URL and stop." --context "Live URL https://yanylevin.com/<hex>/. Already deployed. Who asked, and which chat." --workspace jype --email you@example.com --teams-chat "<id>"
```

The prompt is the visible bubble, so the URL stays in `context`. Pass `--teams-chat` or `--imessage-to` when the reply has to leave the app. The in-chat tool copies the chat on its own. If `pending` already has this send, cancel the old one. Tell them the clock time you picked. Leave the URL out of that reply.

The future agent's only job is to send the link. It does not rebuild the site.

## Ship

Stay on `main`. Commit the new folder and the `vercel.json` redirect. Leave unrelated dirty files unstaged. `git push origin main`, then `npm run deploy:web`. Curl the live URL until it is 200 with your title, and curl two inner pages. Static files. Do not restart Express for the site.

If `npx vercel whoami` fails, or this machine is not the Mac Studio, say the deploy did not run. Do not pretend the URL is live.

After a future-event deploy, the curl is for you. The reply still omits the URL.

## Checklist

- [ ] New 24-hex folder, a different one from the salesman site
- [ ] House CSS, fonts, orbs, and glass left off
- [ ] Pages differ from each other and from the last celebration
- [ ] Each page has real content and an interaction, and works on a phone
- [ ] `noindex`, data-URI favicon, reduced motion
- [ ] `vercel.json` redirect, no `sites[]` tile
- [ ] Pushed and deployed, live 200
- [ ] URL withheld while the event is still ahead
- [ ] Future agent only if the end time came from a todo, calendar, or bell
