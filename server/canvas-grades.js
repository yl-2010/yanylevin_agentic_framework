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
  const assignmentsById = new Map();
  for (const row of snapshot.assignments || []) {
    const id = assignmentKey(row);
    if (id != null) assignmentsById.set(id, row);
  }

  const paintTodo = (todo) => {
    if (!todo || typeof todo !== "object") return;
    const fromField = Number(todo.canvasId);
    const fromLink = canvasAssignmentIdFromLink(todo.canvasLink);
    const id = Number.isFinite(fromField) ? fromField : fromLink;
    if (id == null) return;
    const row = assignmentsById.get(id);
    if (!row) return;
    todo.canvasWork = formatAssignmentWork(row);
  };

  const paintClass = (cls) => {
    if (!cls || typeof cls !== "object") return;
    const fromLink = canvasCourseIdFromLink(cls.canvasLink);
    const fromMap = classByCanvas.get(String(cls.id || ""));
    const courseId = fromLink != null ? fromLink : fromMap;
    const course = courseId != null ? coursesById.get(Number(courseId)) : null;
    const rawScore = course?.currentScore;
    const score = Number(rawScore);
    const hasPostedWork = (snapshot.assignments || []).some((row) => {
      if (Number(row?.courseId) !== Number(courseId)) return false;
      if (row?.score == null || row.score === "") return false;
      return Number.isFinite(Number(row.score));
    });
    // Canvas reports 0 before anything is scored. Don't paint a fake F.
    if (Number.isFinite(score) && !(score === 0 && !hasPostedWork)) {
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
