/**
 * Canvas score labels for the education tree.
 * Overlay only. Does not write todo.json / class.json.
 */

export function trimScore(n) {
  if (!Number.isFinite(n)) return "";
  const rounded = Math.round(n * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

function finiteFrom(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function assignmentHasPostedScore(row, courseId) {
  if (Number(row?.courseId) !== Number(courseId)) return false;
  if (row?.excused) return true;
  const state = String(row?.workflowState || "").toLowerCase();
  if (state !== "graded") return false;
  return finiteFrom(row?.score) != null;
}

export function formatCourseScoreLabel(score) {
  if (score == null || score === "") return "";
  const n = Number(score);
  if (!Number.isFinite(n)) return "";
  const s = trimScore(n);
  return s ? `${s}%` : "";
}

/**
 * Graded: points first (8/10), then percent, then letter.
 * Open / ungraded: /10, or n/a when the assignment is worth nothing.
 * @param {object} row
 */
export function formatAssignmentWork(row) {
  const points = finiteFrom(row?.pointsPossible ?? row?.points);
  const hasPoints = points != null && points > 0;
  const score = finiteFrom(row?.score);
  const hasScore = score != null;
  const letter = String(row?.grade || "").trim();
  const state = String(row?.workflowState || "").toLowerCase();
  const graded =
    state === "graded" || hasScore || Boolean(row?.excused);

  if (row?.excused) {
    return { display: "exc", graded: true };
  }

  if (graded) {
    if (hasScore && hasPoints) {
      return { display: `${trimScore(score)}/${trimScore(points)}`, graded: true };
    }
    const pct = finiteFrom(row?.percent);
    if (pct != null) {
      return { display: `${trimScore(pct)}%`, graded: true };
    }
    if (/%$/.test(letter)) return { display: letter, graded: true };
    if (/^\d+(\.\d+)?\/\d+(\.\d+)?$/.test(letter)) {
      return { display: letter, graded: true };
    }
    if (letter && !/^\d/.test(letter)) {
      return { display: letter, graded: true };
    }
    if (hasScore) return { display: `${trimScore(score)}%`, graded: true };
    if (letter) return { display: letter, graded: true };
  }

  if (hasPoints) return { display: `/${trimScore(points)}`, graded: false };
  return { display: "n/a", graded: false };
}

export function canvasCourseIdFromLink(raw) {
  const m = String(raw || "").match(/\/courses\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function canvasAssignmentIdFromLink(raw) {
  const m = String(raw || "").match(/\/assignments\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function invertCourseMap(map) {
  /** @type {Map<string, number>} */
  const out = new Map();
  if (!map || typeof map !== "object") return out;
  for (const [courseId, classId] of Object.entries(map)) {
    const id = Number(courseId);
    const folder = String(classId || "").trim();
    if (Number.isFinite(id) && folder) out.set(folder, id);
  }
  return out;
}

function assignmentKey(row) {
  const id = Number(row?.id);
  return Number.isFinite(id) ? id : null;
}

export function todoCanvasAssignmentId(todo) {
  if (!todo || typeof todo !== "object") return null;
  const fromField = Number(todo.canvasId);
  if (Number.isFinite(fromField)) return fromField;
  return canvasAssignmentIdFromLink(todo.canvasLink);
}

/**
 * Submitted, graded, excused, or a posted score. Used to paint `done` in the
 * API overlay. Agents still must not write done into todo.json.
 * @param {object|null|undefined} row
 */
export function assignmentLooksComplete(row) {
  if (!row || typeof row !== "object") return false;
  if (row.excused) return true;
  if (row.plannerComplete || row.markedComplete) return true;
  if (row.submittedAt) return true;
  const state = String(row.workflowState || "").toLowerCase();
  if (state === "submitted" || state === "graded" || state === "pending_review") {
    return true;
  }
  return finiteFrom(row.score) != null;
}

function assignmentsById(snapshot) {
  const map = new Map();
  for (const row of snapshot?.assignments || []) {
    const id = assignmentKey(row);
    if (id != null) map.set(id, row);
  }
  return map;
}

/**
 * Attach live Canvas labels onto an education tree. Mutates `tree`.
 * @param {object} tree
 * @param {object|null} snapshot
 * @param {Record<string, string>|null} [courseMap]
 */
export function attachCanvasGrades(tree, snapshot, courseMap = null) {
  if (!tree || !snapshot) return tree;
  const classByCanvas = invertCourseMap(courseMap);
  const coursesById = new Map(
    (snapshot.courses || [])
      .filter((c) => c && c.id != null)
      .map((c) => [Number(c.id), c])
  );
  const byAssignment = assignmentsById(snapshot);

  const paintTodo = (todo) => {
    if (!todo || typeof todo !== "object") return;
    const id = todoCanvasAssignmentId(todo);
    if (id == null) return;
    const row = byAssignment.get(id);
    if (!row) return;
    todo.canvasWork = formatAssignmentWork(row);
  };

  const paintClass = (cls) => {
    if (!cls || typeof cls !== "object") return;
    const fromLink = canvasCourseIdFromLink(cls.canvasLink);
    const fromMap = classByCanvas.get(String(cls.id || ""));
    const courseId = fromLink != null ? fromLink : fromMap;
    const course = courseId != null ? coursesById.get(Number(courseId)) : null;
    const score = finiteFrom(course?.currentScore);
    const hasPostedWork = (snapshot.assignments || []).some((row) =>
      assignmentHasPostedScore(row, courseId)
    );
    // Canvas current_score is n/a until a grade is posted. Don't paint a
    // leftover final_score (History 12% / F) or a 0 with nothing graded.
    if (score != null && hasPostedWork) {
      cls.canvasScore = score;
      cls.canvasScoreLabel = formatCourseScoreLabel(score);
    }
    for (const t of cls.todos || []) paintTodo(t);
    for (const t of cls.classOnlyTodos || []) paintTodo(t);
  };

  for (const cls of tree.classes || []) paintClass(cls);
  for (const t of tree.todos || []) paintTodo(t);
  for (const p of tree.projects || []) {
    for (const t of p.todos || []) paintTodo(t);
  }
  return tree;
}

/**
 * Overlay Canvas completion onto todos. Canvas-linked rows follow Canvas
 * (including uncheck). Does not write files.
 * @param {object} tree
 * @param {object|null} snapshot
 */
export function attachCanvasCompletion(tree, snapshot) {
  if (!tree || !snapshot) return tree;
  const byId = assignmentsById(snapshot);

  const paintTodo = (todo) => {
    if (!todo || typeof todo !== "object") return;
    const id = todoCanvasAssignmentId(todo);
    if (id == null) return;
    const row = byId.get(id);
    if (!row) return;
    if (assignmentLooksComplete(row)) {
      todo.done = true;
      if (!todo.completedAt && row.submittedAt) {
        todo.completedAt = row.submittedAt;
      }
      return;
    }
    todo.done = false;
    delete todo.completedAt;
  };

  const paintClass = (cls) => {
    if (!cls || typeof cls !== "object") return;
    for (const t of cls.todos || []) paintTodo(t);
    for (const t of cls.classOnlyTodos || []) paintTodo(t);
  };

  for (const cls of tree.classes || []) paintClass(cls);
  for (const t of tree.todos || []) paintTodo(t);
  for (const p of tree.projects || []) {
    for (const t of p.todos || []) paintTodo(t);
  }
  return tree;
}

/**
 * Grades plus completion overlay. Mutates `tree`.
 * @param {object} tree
 * @param {object|null} snapshot
 * @param {Record<string, string>|null} [courseMap]
 */
export function attachCanvasOverlay(tree, snapshot, courseMap = null) {
  attachCanvasGrades(tree, snapshot, courseMap);
  attachCanvasCompletion(tree, snapshot);
  return tree;
}

function eachEducationTodo(tree, fn) {
  if (!tree || typeof tree !== "object") return;
  for (const cls of tree.classes || []) {
    for (const t of cls?.todos || []) fn(t);
    for (const t of cls?.classOnlyTodos || []) fn(t);
  }
  for (const t of tree.todos || []) fn(t);
  for (const p of tree.projects || []) {
    for (const t of p?.todos || []) fn(t);
  }
}

/**
 * Teacher submission comments for the todo page. Drops Yan's own notes.
 * Newest first. Clears canvasComments when a Canvas todo has none left.
 * Does not write files.
 * @param {object} tree
 * @param {object[]|null|undefined} comments
 */
export function attachCanvasComments(tree, comments) {
  if (!tree) return tree;
  /** @type {Map<number, { id: number, createdAt: string, comment: string }[]>} */
  const byAssignment = new Map();
  const seen = new Set();
  for (const row of Array.isArray(comments) ? comments : []) {
    if (!row || row.own === true) continue;
    const text = String(row.comment || "").trim();
    const assignmentId = Number(row.assignmentId);
    const id = Number(row.id);
    if (!text || !Number.isFinite(assignmentId) || !Number.isFinite(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const bucket = byAssignment.get(assignmentId) || [];
    bucket.push({
      id,
      createdAt: String(row.createdAt || ""),
      comment: text,
    });
    byAssignment.set(assignmentId, bucket);
  }
  for (const bucket of byAssignment.values()) {
    bucket.sort((a, b) => {
      const byTime = b.createdAt.localeCompare(a.createdAt);
      if (byTime !== 0) return byTime;
      return b.id - a.id;
    });
  }

  eachEducationTodo(tree, (todo) => {
    if (!todo || typeof todo !== "object") return;
    const assignmentId = todoCanvasAssignmentId(todo);
    if (assignmentId == null) return;
    const rows = byAssignment.get(assignmentId);
    if (!rows || !rows.length) {
      delete todo.canvasComments;
      return;
    }
    todo.canvasComments = rows;
  });
  return tree;
}
