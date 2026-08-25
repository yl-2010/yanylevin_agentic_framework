# Fitness data

Per-user gym logs live here (same pattern as `education/<email>/`).

Default template: `you@example.com/`. Rename to match `OWNER_EMAIL`.

Each machine: `machines/<id>/machine.json` + `entries.json`.
`machine.json` fields: `id`, `name`, `order`, `color` (`#rrggbb`, unique per user).
Sessions are calendar dates of each entry’s `at` timestamp.
