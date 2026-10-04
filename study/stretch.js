/**
 * Stretch between the two solid materials. The blobs sit under the panels
 * and run through an SVG goo filter, so they neck together when the panels
 * move. This is not the refraction glass on the rest of the site.
 */
(() => {
  const desk = document.getElementById("desk");
  const files = document.getElementById("files-material");
  const notes = document.getElementById("notes-material");
  const blobFiles = document.getElementById("blob-files");
  const blobNotes = document.getElementById("blob-notes");
  if (!desk || !files || !notes || !blobFiles || !blobNotes) return;

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let pointer = null;
  let frame = 0;

  function reduced() {
    return motion.matches;
  }

  function place(blob, el, pullX, pullY) {
    const deskBox = desk.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const pad = 8;
    blob.style.left = `${box.left - deskBox.left - pad + pullX}px`;
    blob.style.top = `${box.top - deskBox.top - pad + pullY}px`;
    blob.style.width = `${box.width + pad * 2}px`;
    blob.style.height = `${box.height + pad * 2}px`;
  }

  function pullFor(el) {
    if (reduced() || !pointer || desk.dataset.state !== "idle") return [0, 0];
    const box = el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const dx = pointer.x - cx;
    const dy = pointer.y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const reach = Math.max(0, 1 - dist / 420);
    return [(dx / dist) * reach * 14, (dy / dist) * reach * 8];
  }

  function tick() {
    frame = 0;
    const [fx, fy] = pullFor(files);
    const [nx, ny] = pullFor(notes);
    place(blobFiles, files, fx, fy);
    place(blobNotes, notes, nx, ny);
    if (desk.dataset.state === "idle" && !reduced()) {
      files.style.transform = pointer ? `translate(${fx * 0.35}px, ${fy * 0.35}px)` : "";
      notes.style.transform = pointer ? `translate(${nx * 0.35}px, ${ny * 0.35}px)` : "";
    } else if (desk.dataset.state !== "idle") {
      files.style.transform = "";
      notes.style.transform = "";
    }
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(tick);
  }

  desk.addEventListener("pointermove", (event) => {
    pointer = { x: event.clientX, y: event.clientY };
    schedule();
  });
  desk.addEventListener("pointerleave", () => {
    pointer = null;
    schedule();
  });

  const observer = new MutationObserver(schedule);
  observer.observe(desk, { attributes: true, attributeFilter: ["data-state", "hidden"] });
  window.addEventListener("resize", schedule);
  if (!desk.hidden) schedule();
})();
