(() => {
  const gate = document.getElementById("gate");
  const gateCopy = document.getElementById("gate-copy");
  const signIn = document.getElementById("sign-in");
  const signOut = document.getElementById("sign-out");
  const desk = document.getElementById("desk");
  const fileInput = document.getElementById("file-input");
  const drop = document.getElementById("drop");
  const fileList = document.getElementById("file-list");
  const notes = document.getElementById("notes");
  const make = document.getElementById("make");
  const status = document.getElementById("status");
  const papers = document.getElementById("papers");
  const downloadWork = document.getElementById("download-work");
  const downloadKey = document.getElementById("download-key");
  const workTitle = document.getElementById("work-title");

  const ALLOWED = new Set(["full", "jype", "study"]);
  const MAX_FILES = 20;
  const MAX_TOTAL = 40 * 1024 * 1024;
  /** @type {{ name: string, file: File }[]} */
  let files = [];
  let jobId = "";
  let pollTimer = 0;
  let apiBase = "https://api.yanylevin.com";

  function localHost() {
    const host = location.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
  }

  async function loadApiBase() {
    if (localHost()) {
      apiBase = "http://127.0.0.1:3004";
      return;
    }
    try {
      const res = await fetch("/runtime-config.json", { cache: "no-store" });
      if (res.ok) {
        const runtime = await res.json();
        if (runtime?.apiBase) apiBase = String(runtime.apiBase).replace(/\/$/, "");
      }
    } catch {
      /* keep the public API */
    }
  }

  async function macToken() {
    const res = await fetch("/api/mac-user-token", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      const err = new Error(res.status === 401 ? "Sign in again." : "Could not reach the Mac.");
      err.status = res.status;
      throw err;
    }
    return data.token;
  }

  async function macFetch(path, opts = {}) {
    const token = await macToken();
    const headers = new Headers(opts.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${apiBase}${path}`, { ...opts, headers });
  }

  function formatSize(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderFiles() {
    fileList.replaceChildren();
    for (const item of files) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "file-label";
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = item.name;
      const size = document.createElement("span");
      size.className = "file-size";
      size.textContent = formatSize(item.file.size);
      label.append(name, size);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${item.name}`);
      remove.addEventListener("click", () => {
        files = files.filter((row) => row !== item);
        renderFiles();
      });
      li.append(label, remove);
      fileList.append(li);
    }
  }

  function addFiles(list) {
    const next = [...files];
    for (const file of list) {
      if (next.length >= MAX_FILES) {
        status.textContent = "Up to 20 files.";
        break;
      }
      next.push({ name: file.name, file });
    }
    const total = next.reduce((n, row) => n + row.file.size, 0);
    if (total > MAX_TOTAL) {
      status.textContent = "Those files are over 40MB.";
      return;
    }
    files = next;
    renderFiles();
  }

  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files || []);
    fileInput.value = "";
  });

  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("is-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-over");
    addFiles(event.dataTransfer?.files || []);
  });

  function showGate(copy, withSignIn) {
    desk.hidden = true;
    gate.hidden = false;
    signOut.hidden = true;
    gateCopy.textContent = copy;
    signIn.hidden = !withSignIn;
  }

  function showDesk() {
    gate.hidden = true;
    desk.hidden = false;
    signOut.hidden = false;
    desk.dispatchEvent(new Event("pointerleave"));
  }

  function showPapers(title) {
    papers.hidden = false;
    desk.dataset.state = "split";
    workTitle.textContent = title || "Practice test";
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || "");
        const comma = raw.indexOf(",");
        resolve(comma === -1 ? raw : raw.slice(comma + 1));
      };
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    });
  }

  async function download(which, filename) {
    const res = await macFetch(`/api/study/jobs/${jobId}/${which}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Could not download that PDF.");
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  downloadWork.addEventListener("click", () => {
    download("work.pdf", "work.pdf").catch((err) => {
      status.textContent = err.message;
    });
  });
  downloadKey.addEventListener("click", () => {
    download("key.pdf", "key.pdf").catch((err) => {
      status.textContent = err.message;
    });
  });

  async function poll() {
    const res = await macFetch(`/api/study/jobs/${jobId}`);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showGate("Sign in again.", true);
      return;
    }
    if (!res.ok) {
      desk.dataset.state = "idle";
      make.disabled = false;
      status.textContent = data.error || "Could not check on the test.";
      return;
    }
    if (data.status === "done") {
      make.disabled = false;
      status.textContent = "Both copies are ready.";
      showPapers(data.title);
      return;
    }
    if (data.status === "error") {
      desk.dataset.state = "idle";
      make.disabled = false;
      status.textContent = data.error || "The test could not be made.";
      return;
    }
    status.textContent = "Writing the test. This usually takes a few minutes.";
    pollTimer = window.setTimeout(poll, 2000);
  }

  make.addEventListener("click", async () => {
    if (make.disabled) return;
    papers.hidden = true;
    desk.dataset.state = "merging";
    make.disabled = true;
    status.textContent = "Writing the test. This usually takes a few minutes.";
    try {
      const payloadFiles = [];
      for (const item of files) {
        payloadFiles.push({
          name: item.name,
          data: await fileToBase64(item.file),
        });
      }
      const res = await macFetch("/api/study/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes.value, files: payloadFiles }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        showGate("Sign in again.", true);
        return;
      }
      if (!res.ok) {
        desk.dataset.state = "idle";
        make.disabled = false;
        status.textContent = data.error || "Could not start that test.";
        return;
      }
      jobId = data.id;
      window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(poll, 1500);
    } catch (err) {
      desk.dataset.state = "idle";
      make.disabled = false;
      status.textContent = err instanceof Error ? err.message : "Could not start that test.";
    }
  });

  signOut.addEventListener("click", async () => {
    await fetch("/api/auth/signout", { method: "POST", credentials: "same-origin" });
    location.reload();
  });

  async function boot() {
    await loadApiBase();
    let session = null;
    try {
      const res = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      session = await res.json();
    } catch {
      session = null;
    }
    if (!session?.authenticated) {
      showGate("Make a test from the class files.", true);
      return;
    }
    if (!ALLOWED.has(session.access)) {
      showGate("This Google account cannot use Study.", false);
      signOut.hidden = false;
      return;
    }
    showDesk();
    try {
      const res = await macFetch("/api/study/jobs");
      const data = await res.json().catch(() => ({}));
      const latest = Array.isArray(data.jobs) ? data.jobs[0] : null;
      if (!latest) return;
      jobId = latest.id;
      if (latest.status === "done") {
        status.textContent = "Both copies are ready.";
        showPapers(latest.title);
      } else if (latest.status === "queued" || latest.status === "running") {
        desk.dataset.state = "merging";
        make.disabled = true;
        status.textContent = "Writing the test. This usually takes a few minutes.";
        pollTimer = window.setTimeout(poll, 800);
      } else if (latest.status === "error" && latest.error) {
        status.textContent = latest.error;
      }
    } catch {
      /* the form still works */
    }
  }

  boot();
})();
