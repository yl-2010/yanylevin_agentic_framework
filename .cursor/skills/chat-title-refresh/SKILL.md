---
name: chat-title-refresh
description: >-
  Nightly Composer 2.5 job: retitle Personal Agent chats from the full
  transcript in short keyword style for the narrow past-chats list.
  Also used for a one-shot historical backfill. Not live first-message titles.
disable-model-invocation: true
---

# Chat title refresh

**Gate:** local Cursor agent only. Never spawn a cloud agent. Only rewrite `title:` lines in listed `education/<email>/.chat-history/<sessionId>.md` files. Do not edit messages, widgets, or other users' folders that were not listed.

Model: **composer-2.5** (fast=false).

You run **after** the 01:00 nightly agents. Default slot is **01:30** (`chatTitleRefreshLocalTime` in `education/you@example.com/daily-briefing/meta.json`). Context synthesis is later (02:30). Daily briefing is 06:00.

The live first-message title agent is a different, faster pass. You see the **whole** thread and overwrite that first guess.

## Title style

Keyword-style chat list title, not a sentence.
2 to 5 words, about 24-36 characters. Distinctive nouns: people, places, tasks.
No filler (hi, greeting, simple, nearby places to eat clones).
No quotes. No trailing punctuation. No em dashes. No explanation.

The iOS/web past-chats drawer is a **narrow single line** with ellipsis. Front-load the words Yan would scan for.

Examples:

- `Calculate Exact API Cost` → `API cost vs plan`
- `Simple Hello Greeting` → `hi`
- `Robotaxi rides from email plates` → `robotaxi email plates`
- `Example Friend not Jeffrey` → `Example Friend spelling`

## Steps

1. Use only the file list in the prompt (path + current title). Do not glob `.chat-history/`.
2. For each listed file: Read the full markdown. Infer a title from the entire User/Assistant conversation, not the first message alone.
3. Rewrite only the `title: …` line (add it after `updated:` if missing). Keep session, email, started, updated, visibility, and every `## User` / `## Assistant` block unchanged.
4. If the thread is empty or only "hi" with no topic, a tiny keyword (`hi`) is fine. Do not invent a topic that is not in the transcript.
5. Stop when every listed file has a keyword title. Do not git commit (the Node wrapper does that).
