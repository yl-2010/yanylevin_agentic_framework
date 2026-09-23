---
name: jype-chat-title-refresh
description: >-
  Nightly Composer 2.5 job: retitle JYPE agent chats from the full
  transcript in short keyword style. Always keep who started the thread
  (Yan:, Alex:, Example Friend:, Example Neighbor:). The Node wrapper restores Name:
  after you rewrite the rest. Not Personal Agent / yanylevin history.
disable-model-invocation: true
---

# Chat title refresh (JYPE)

**Gate:** local Cursor agent only. Never spawn a cloud agent. Only rewrite `title:` lines in listed `education/projects/jype/.chat-history/<sessionId>.md` files. Do not edit messages, widgets, or personal `education/<email>/.chat-history/` files. Those use `.cursor/skills/chat-title-refresh/SKILL.md`. You will not be given those files.

Model: **composer-2.5** (fast=false).

Same 01:30 slot as Personal Agent title refresh (`chatTitleRefreshLocalTime`). The live first-message title agent is a different, faster pass. You see the **whole** thread and overwrite that first guess.

## Title style

Keyword-style chat list title, not a sentence.
2 to 5 words, about 24-36 characters. Distinctive nouns: people, places, tasks.
No filler (hi, greeting, simple, nearby places to eat clones).
No quotes. No trailing punctuation. No em dashes. No explanation.

The JYPE past-chats drawer is a **narrow single line** with ellipsis. Front-load the words people would scan for.

**Always keep who started the thread.** The file has `starter: Yan` / `Alex` / `Example Friend` / `Example Neighbor` (or that prefix already on `title:`). Keep the `starter:` line. Do not write `Name:` yourself. The Node wrapper puts `Name:` back so titles stay `Yan: …` / `Alex: …` even when you change the rest.

Examples:

- `Yan: Calculate Exact API Cost` → rewrite rest as `API cost vs plan` (wrapper keeps `Yan:`)
- `Alex: Alex English homework BS` → rewrite rest as `English homework BS`
- `Example Neighbor caber hard verb` with `starter: Example Neighbor` → `caber hard verb` (wrapper adds `Example Neighbor:`)

## Steps

1. Use only the file list in the prompt (path + current title + starter). Do not glob `.chat-history/`.
2. For each listed file: Read the full markdown. Infer a title from the entire User/Assistant conversation, not the first message alone.
3. Rewrite only the `title: …` line (add it after `updated:` if missing). Keep session, email, started, updated, visibility, ephemeral, starter, workspace, and every `## User` / `## Assistant` block unchanged.
4. If the thread is empty or only "hi" with no topic, a tiny keyword (`hi`) is fine. Do not invent a topic that is not in the transcript.
5. Stop when every listed file has a keyword title. Do not git commit (the Node wrapper does that).
