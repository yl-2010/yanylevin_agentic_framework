/**
 * Canvas pages, modules, course files, and submission comments.
 * Agent-only dumps under education/<yan>/.canvas/. Not education UI.
 * Full (nightly / --fetch-only) snapshot pulls these. Hourly light does not.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canvasFetch,
  canvasGetAll,
  clip,
  stripHtml,
} from "./canvas-sync.js";

const PAGE_BODY_MAX = 4000;
const COMMENT_MAX = 2000;
const MAX_PAGE_BODIES = 25;
const MAX_FILES_PER_COURSE = 200;

/**
 * @param {unknown} raw
 * @param {number} [max]
 */
export function commentRow(raw, extra = {}) {
  const id = Number(raw?.id);
  const text = stripHtml(raw?.comment || raw?.body || "", COMMENT_MAX);
  if (!Number.isFinite(id) || id <= 0 || !text) return null;
  const authorObj = raw?.author && typeof raw.author === "object" ? raw.author : null;
  const authorId = Number(raw?.author_id ?? authorObj?.id);
  const author = clip(
    raw?.author_name || authorObj?.display_name || "",
    80
  );
  const assignmentId = Number(
    extra.assignmentId ?? raw?.assignment_id ?? extra.assignment?.id
  );
  const assignment = clip(
    extra.assignmentName || extra.assignment?.name || extra.assignment?.title || "",
    160
  );
  const courseId = Number(extra.courseId);
  return {
    id,
    assignmentId: Number.isFinite(assignmentId) ? assignmentId : null,
    assignment,
    courseId: Number.isFinite(courseId) ? courseId : null,
    course: clip(extra.course || "", 120),
    authorId: Number.isFinite(authorId) ? authorId : null,
    author,
    own: extra.selfUserId != null && authorId === Number(extra.selfUserId),
    createdAt: String(raw?.created_at || raw?.edited_at || ""),
    comment: text,
  };
}

/**
 * @param {object[]} comments
 * @param {Iterable<number>|Set<number>} seenIds
 */
export function newComments(comments, seenIds) {
  const seen = seenIds instanceof Set ? seenIds : new Set(
    [...(seenIds || [])].map((n) => Number(n)).filter((n) => Number.isFinite(n))
  );
  return (Array.isArray(comments) ? comments : []).filter((row) => {
    const id = Number(row?.id);
    return Number.isFinite(id) && id > 0 && !seen.has(id);
  });
}

export function pageRow(raw, extra = {}) {
  const url = clip(raw?.url || "", 200);
  const title = clip(raw?.title || url, 160);
  if (!title) return null;
  if (raw?.published === false) return null;
  const body = stripHtml(raw?.body || "", PAGE_BODY_MAX);
  const courseId = Number(extra.courseId);
  return {
    url: url || title,
    title,
    courseId: Number.isFinite(courseId) ? courseId : null,
    course: clip(extra.course || "", 120),
    frontPage: Boolean(raw?.front_page),
    updatedAt: String(raw?.updated_at || raw?.created_at || ""),
    htmlUrl: clip(raw?.html_url || extra.htmlUrl || "", 400),
    body,
  };
}

export function moduleItemRow(raw, extra = {}) {
  const title = clip(raw?.title || "", 160);
  if (!title) return null;
  const type = clip(raw?.type || "", 40);
  if (type.toLowerCase() === "subheader") {
    return {
      title,
      type: "SubHeader",
      indent: Number(raw?.indent) || 0,
    };
  }
  const details = raw?.content_details && typeof raw.content_details === "object"
    ? raw.content_details
    : {};
  return {
    title,
    type: type || "Item",
    indent: Number(raw?.indent) || 0,
    contentId: Number(raw?.content_id) || null,
    htmlUrl: clip(raw?.html_url || "", 400),
    published: raw?.published !== false,
    locked: Boolean(details.locked),
    lockExplanation: clip(details.lock_explanation || "", 240),
    points: Number.isFinite(Number(details.points_possible))
      ? Number(details.points_possible)
      : null,
  };
}

export function moduleRow(raw, extra = {}) {
  const name = clip(raw?.name || "", 160);
  if (!name) return null;
  const courseId = Number(extra.courseId);
  const items = Array.isArray(raw?.items)
    ? raw.items.map((item) => moduleItemRow(item)).filter(Boolean)
    : [];
  return {
    id: Number(raw?.id) || null,
    name,
    courseId: Number.isFinite(courseId) ? courseId : null,
    course: clip(extra.course || "", 120),
    position: Number(raw?.position) || null,
    state: clip(raw?.state || "", 24),
    items,
  };
}

export function courseFileRow(raw, extra = {}) {
  const id = Number(raw?.id);
  const name = clip(
    raw?.display_name || raw?.filename || raw?.name || "",
    180
  );
  if (!Number.isFinite(id) || id <= 0 || !name) return null;
  const courseId = Number(extra.courseId);
  const folder = clip(extra.folder || raw?.folder_path || "", 240);
  return {
    id,
    name,
    courseId: Number.isFinite(courseId) ? courseId : null,
    course: clip(extra.course || "", 120),
    folder,
    size: Number.isFinite(Number(raw?.size)) ? Number(raw.size) : null,
    contentType: clip(raw?.["content-type"] || raw?.content_type || "", 80),
    updatedAt: String(raw?.updated_at || raw?.modified_at || ""),
    htmlUrl: clip(raw?.html_url || "", 400),
    url: clip(raw?.url || "", 500),
  };
}

export function formatCommentsMarkdown(comments, { heading = "Canvas comments", empty = "(none)" } = {}) {
  const lines = [`# ${heading}`, ""];
  const list = Array.isArray(comments) ? comments : [];
  if (!list.length) {
    lines.push(empty, "");
    return `${lines.join("\n")}\n`;
  }
  const byCourse = groupByCourse(list);
  for (const [course, rows] of byCourse) {
    lines.push(`## ${course}`, "");
    for (const row of rows) {
      const when = String(row.createdAt || "").replace("T", " ").slice(0, 16);
      const who = row.author || "someone";
      const own = row.own ? " (you)" : "";
      const asg = row.assignment ? ` on ${row.assignment}` : "";
      const id = row.assignmentId != null ? ` [canvasId ${row.assignmentId}]` : "";
      lines.push(`- **${who}${own}**${asg}${id}${when ? ` — ${when}` : ""}`);
      lines.push(`  ${row.comment}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function formatPagesMarkdown(pages) {
  const lines = [
    "# Canvas pages",
    "",
    "Agent context only. Do not put these on the education UI.",
    "",
  ];
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) {
    lines.push("(none)", "");
    return `${lines.join("\n")}\n`;
  }
  const byCourse = groupByCourse(list);
  for (const [course, rows] of byCourse) {
    lines.push(`## ${course}`, "");
    for (const row of rows) {
      const front = row.frontPage ? " (front page)" : "";
      const link = row.htmlUrl ? ` — ${row.htmlUrl}` : "";
      lines.push(`- **${row.title}**${front}${link}`);
      if (row.body) {
        const excerpt = row.body.length > 360 ? `${row.body.slice(0, 360).trim()}…` : row.body;
        lines.push(`  ${excerpt}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function formatModulesMarkdown(modules) {
  const lines = [
    "# Canvas modules",
    "",
    "Agent context only. Do not put these on the education UI.",
    "",
  ];
  const list = Array.isArray(modules) ? modules : [];
  if (!list.length) {
    lines.push("(none)", "");
    return `${lines.join("\n")}\n`;
  }
  const byCourse = groupByCourse(list);
  for (const [course, rows] of byCourse) {
    lines.push(`## ${course}`, "");
    for (const mod of rows) {
      const state = mod.state ? ` (${mod.state})` : "";
      lines.push(`- **${mod.name}**${state}`);
      for (const item of mod.items || []) {
        const pad = "  ".repeat(1 + (Number(item.indent) || 0));
        if (item.type === "SubHeader") {
          lines.push(`${pad}- ${item.title}`);
          continue;
        }
        const lock = item.locked ? " locked" : "";
        const pts = item.points != null ? ` ${item.points}pts` : "";
        lines.push(`${pad}- ${item.title} [${item.type}]${pts}${lock}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function formatCourseFilesMarkdown(files) {
  const lines = [
    "# Canvas course files",
    "",
    "Agent context only. Names and folders, not education tiles. Do not copy into OneDrive for the UI.",
    "",
  ];
  const list = Array.isArray(files) ? files : [];
  if (!list.length) {
    lines.push("(none)", "");
    return `${lines.join("\n")}\n`;
  }
  const byCourse = groupByCourse(list);
  for (const [course, rows] of byCourse) {
    lines.push(`## ${course}`, "");
    for (const row of rows) {
      const path = row.folder ? `${row.folder}/${row.name}` : row.name;
      const id = row.id != null ? ` [file ${row.id}]` : "";
      lines.push(`- ${path}${id}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function groupByCourse(rows) {
  /** @type {Map<string, object[]>} */
  const map = new Map();
  for (const row of rows) {
    const key = String(row?.course || "Course").trim() || "Course";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

async function readJson(path) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

export async function readSeenCommentIds(dir) {
  const raw = await readJson(join(dir, "seen-comment-ids.json"));
  const ids = Array.isArray(raw?.ids) ? raw.ids : [];
  return new Set(ids.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0));
}

export async function markCanvasCommentsSeen(dir, comments) {
  const ids = [
    ...new Set(
      (Array.isArray(comments) ? comments : [])
        .map((row) => Number(row?.id))
        .filter((n) => Number.isFinite(n) && n > 0)
    ),
  ].sort((a, b) => a - b);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "seen-comment-ids.json"),
    `${JSON.stringify({ ids, at: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
  return ids.length;
}

export async function readCanvasContext(dir) {
  const comments = await readJson(join(dir, "comments.json"));
  const pages = await readJson(join(dir, "pages.json"));
  const modules = await readJson(join(dir, "modules.json"));
  const files = await readJson(join(dir, "files.json"));
  return {
    comments: Array.isArray(comments?.comments) ? comments.comments : [],
    pages: Array.isArray(pages?.pages) ? pages.pages : [],
    modules: Array.isArray(modules?.modules) ? modules.modules : [],
    files: Array.isArray(files?.files) ? files.files : [],
    updatedAt:
      comments?.updatedAt ||
      pages?.updatedAt ||
      modules?.updatedAt ||
      files?.updatedAt ||
      "",
  };
}

/**
 * @param {string} dir
 * @param {{ comments?: object[], pages?: object[], modules?: object[], files?: object[], updatedAt?: string }} payload
 */
export async function persistCanvasContext(dir, payload) {
  await mkdir(dir, { recursive: true });
  const updatedAt = payload.updatedAt || new Date().toISOString();
  const comments = Array.isArray(payload.comments) ? payload.comments : [];
  const pages = Array.isArray(payload.pages) ? payload.pages : [];
  const modules = Array.isArray(payload.modules) ? payload.modules : [];
  const files = Array.isArray(payload.files) ? payload.files : [];
  const seen = await readSeenCommentIds(dir);
  const fresh = newComments(comments, seen);

  await writeFile(
    join(dir, "comments.json"),
    `${JSON.stringify({ updatedAt, comments }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(join(dir, "comments.md"), formatCommentsMarkdown(comments), "utf8");
  await writeFile(
    join(dir, "comments-new.md"),
    formatCommentsMarkdown(fresh, {
      heading: "New Canvas comments",
      empty: "(none since last successful nightly Canvas agent)",
    }),
    "utf8"
  );
  await writeFile(
    join(dir, "pages.json"),
    `${JSON.stringify({ updatedAt, pages }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(join(dir, "pages.md"), formatPagesMarkdown(pages), "utf8");
  await writeFile(
    join(dir, "modules.json"),
    `${JSON.stringify({ updatedAt, modules }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(join(dir, "modules.md"), formatModulesMarkdown(modules), "utf8");
  await writeFile(
    join(dir, "files.json"),
    `${JSON.stringify({ updatedAt, files }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(join(dir, "files.md"), formatCourseFilesMarkdown(files), "utf8");

  return {
    comments: comments.length,
    commentsNew: fresh.length,
    pages: pages.length,
    modules: modules.length,
    files: files.length,
  };
}

async function canvasGetAllAllowMissing(base, token, path, fetchOpts) {
  try {
    return await canvasGetAll(base, token, path, fetchOpts);
  } catch (err) {
    const status = Number(err?.status);
    if (status === 401 || status === 403 || status === 404) return [];
    throw err;
  }
}

async function fetchSelfUserId(base, token, fetchOpts) {
  try {
    const { data } = await canvasFetch(base, token, "/api/v1/users/self", fetchOpts);
    const id = Number(data?.id);
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    console.error("[canvas-context] users/self", err);
    return null;
  }
}

async function fetchCourseComments(base, token, course, selfUserId, fetchOpts) {
  const rows = await canvasGetAllAllowMissing(
    base,
    token,
    `/api/v1/courses/${course.id}/students/submissions?student_ids[]=self&include[]=submission_comments&include[]=assignment&per_page=50`,
    fetchOpts
  );
  /** @type {ReturnType<typeof commentRow>[]} */
  const out = [];
  for (const sub of rows) {
    const assignment = sub?.assignment && typeof sub.assignment === "object"
      ? sub.assignment
      : null;
    const comments = Array.isArray(sub?.submission_comments)
      ? sub.submission_comments
      : [];
    for (const raw of comments) {
      const row = commentRow(raw, {
        courseId: course.id,
        course: course.name,
        assignmentId: sub?.assignment_id || assignment?.id,
        assignment,
        assignmentName: assignment?.name,
        selfUserId,
      });
      if (row) out.push(row);
    }
  }
  return out;
}

async function fetchCoursePages(base, token, course, fetchOpts) {
  const listed = await canvasGetAllAllowMissing(
    base,
    token,
    `/api/v1/courses/${course.id}/pages?per_page=50`,
    fetchOpts
  );
  const published = listed.filter((p) => p && p.published !== false);
  const wantBodies = published.slice(0, MAX_PAGE_BODIES);
  const bodies = await Promise.all(
    wantBodies.map(async (page) => {
      const slug = String(page?.url || "").trim();
      if (!slug) return pageRow(page, { courseId: course.id, course: course.name });
      try {
        const { data } = await canvasFetch(
          base,
          token,
          `/api/v1/courses/${course.id}/pages/${encodeURIComponent(slug)}`,
          fetchOpts
        );
        return pageRow(data || page, {
          courseId: course.id,
          course: course.name,
          htmlUrl: data?.html_url || page?.html_url,
        });
      } catch (err) {
        console.error(`[canvas-context] page ${course.id}/${slug}`, err);
        return pageRow(page, { courseId: course.id, course: course.name });
      }
    })
  );
  const rest = published.slice(MAX_PAGE_BODIES).map((page) =>
    pageRow(page, { courseId: course.id, course: course.name })
  );
  return [...bodies, ...rest].filter(Boolean);
}

async function fetchCourseModules(base, token, course, fetchOpts) {
  const listed = await canvasGetAllAllowMissing(
    base,
    token,
    `/api/v1/courses/${course.id}/modules?include[]=items&include[]=content_details&per_page=50`,
    fetchOpts
  );
  const out = [];
  for (const mod of listed) {
    let items = Array.isArray(mod?.items) ? mod.items : null;
    if (!items && mod?.id) {
      try {
        items = await canvasGetAllAllowMissing(
          base,
          token,
          `/api/v1/courses/${course.id}/modules/${mod.id}/items?include[]=content_details&per_page=50`,
          fetchOpts
        );
      } catch (err) {
        console.error(`[canvas-context] module items ${course.id}/${mod.id}`, err);
        items = [];
      }
    }
    const row = moduleRow({ ...mod, items: items || [] }, {
      courseId: course.id,
      course: course.name,
    });
    if (row) out.push(row);
  }
  return out;
}

async function fetchCourseFiles(base, token, course, fetchOpts) {
  /** @type {Map<number, string>} */
  const folderNames = new Map();
  try {
    const folders = await canvasGetAllAllowMissing(
      base,
      token,
      `/api/v1/courses/${course.id}/folders?per_page=50`,
      fetchOpts
    );
    for (const folder of folders) {
      const id = Number(folder?.id);
      if (!Number.isFinite(id)) continue;
      const full = String(folder?.full_name || folder?.name || "").trim();
      folderNames.set(id, full.replace(/^course files\/?/i, "").trim());
    }
  } catch (err) {
    console.error(`[canvas-context] folders course ${course.id}`, err);
  }
  const listed = await canvasGetAllAllowMissing(
    base,
    token,
    `/api/v1/courses/${course.id}/files?per_page=50`,
    { ...fetchOpts, maxPages: 8 }
  );
  const out = [];
  for (const file of listed.slice(0, MAX_FILES_PER_COURSE)) {
    const folderId = Number(file?.folder_id);
    const row = courseFileRow(file, {
      courseId: course.id,
      course: course.name,
      folder: folderNames.get(folderId) || "",
    });
    if (row) out.push(row);
  }
  return out;
}

/**
 * @param {string} base
 * @param {string} token
 * @param {{ id: number, name?: string }[]} courses
 * @param {{ timeoutMs?: number }} [fetchOpts]
 */
export async function fetchCanvasContext(base, token, courses, fetchOpts = {}) {
  const list = Array.isArray(courses) ? courses.filter((c) => c && c.id) : [];
  const selfUserId = await fetchSelfUserId(base, token, fetchOpts);
  /** @type {object[]} */
  const comments = [];
  /** @type {object[]} */
  const pages = [];
  /** @type {object[]} */
  const modules = [];
  /** @type {object[]} */
  const files = [];

  for (const course of list) {
    const label = course.name || course.id;
    try {
      comments.push(
        ...(await fetchCourseComments(base, token, course, selfUserId, fetchOpts))
      );
    } catch (err) {
      console.error(`[canvas-context] comments ${label}`, err);
    }
    try {
      pages.push(...(await fetchCoursePages(base, token, course, fetchOpts)));
    } catch (err) {
      console.error(`[canvas-context] pages ${label}`, err);
    }
    try {
      modules.push(...(await fetchCourseModules(base, token, course, fetchOpts)));
    } catch (err) {
      console.error(`[canvas-context] modules ${label}`, err);
    }
    try {
      files.push(...(await fetchCourseFiles(base, token, course, fetchOpts)));
    } catch (err) {
      console.error(`[canvas-context] files ${label}`, err);
    }
  }

  comments.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { comments, pages, modules, files, selfUserId };
}

/**
 * Live comments for one assignment (Personal Agent on demand).
 * @param {string} base
 * @param {string} token
 * @param {{ courseId: number, assignmentId: number, course?: string, assignmentName?: string }} opts
 */
export async function fetchAssignmentComments(base, token, opts) {
  const courseId = Number(opts?.courseId);
  const assignmentId = Number(opts?.assignmentId);
  if (!Number.isFinite(courseId) || !Number.isFinite(assignmentId)) {
    return { ok: false, reason: "missing-ids", comments: [] };
  }
  const selfUserId = await fetchSelfUserId(base, token);
  const { data } = await canvasFetch(
    base,
    token,
    `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self?include[]=submission_comments`
  );
  const comments = (Array.isArray(data?.submission_comments)
    ? data.submission_comments
    : []
  )
    .map((raw) =>
      commentRow(raw, {
        courseId,
        course: opts.course || "",
        assignmentId,
        assignmentName: opts.assignmentName || "",
        selfUserId,
      })
    )
    .filter(Boolean);
  return { ok: true, comments, assignmentId, courseId };
}
