---
name: past-chats
description: >-
  Search this user's past Personal Agent chat transcripts under
  education/<email>/.chat-history/. Use when earlier threads could matter
  (callbacks, last time, decisions, unfinished work, preferences).
disable-model-invocation: true
---

# Past chats

Text transcripts of every web / iOS Personal Agent thread are kept forever under `education/<email>/.chat-history/<sessionId>.md`. The chat UI lists those threads (iOS swipe-in drawer, web shift-click send or the collapsed plus) and can reopen them.

Each file header has `visibility: showing` or `visibility: hidden`. Missing means showing. When the user asks to hide a thread (this chat, that chat, a named past chat), set `visibility: hidden` in that file's header. Add the line after `title:` (or `updated:` if there is no title) if it is missing. Do **not** delete the file or the messages. Hidden threads stay on disk and in Grep/Read; they are omitted from the iOS/web history list. Set `visibility: showing` to put a thread back in the list.

Starting a new chat does **not** stop the previous thread. Queued messages on that thread still run one by one in the background, and the finished reply is written into that session's markdown so it shows up when the user reopens it. Unsaved uploads in `.chat-uploads/` still expire with the in-memory session (1 hour idle after the last turn). Transcripts do not.

When earlier chats could matter, **Grep and Read** that folder. Only this user’s `.chat-history/`. Hidden threads count. Do not recap old chats unprompted. Do not treat those files as education dashboard objects (no todos/dates there). Do not tell the user you are searching files unless they ask.

**Alex:** never read Yan’s `.chat-history/`.
