const $ = (selector) => document.querySelector(selector);
const sourceGrid = $("#source-grid");
const modalBackdrop = $("#modal-backdrop");
const sourceForm = $("#source-form");
const fileList = $("#file-list");
const logOutput = $("#log-output");

let sources = [];
let currentType = "kubernetes";
let currentIcon = "kubernetes";
let editingSourceId = null;
let activeSource = null;
let activeFile = null;
let refreshTimer = null;
let paused = false;
let wrapLines = localStorage.getItem("logstation-wrap-lines") === "true";
const DEFAULT_TAIL_LINES = 300;
const MAX_TAIL_LINES = 10000;
const savedTailLines = Number(localStorage.getItem("logstation-tail-lines"));
let tailLines = Number.isInteger(savedTailLines) && savedTailLines >= 1 && savedTailLines <= MAX_TAIL_LINES
  ? savedTailLines
  : DEFAULT_TAIL_LINES;
let latestLogs = "";
let toastTimer = null;
let passwordSourceId = null;

const icons = { kubernetes: "⎈", "remote-kubernetes": "⎈", ssh: "⌘", local: "▤" };
const tileIcons = {
  kubernetes: "⎈", ssh: "⌘", server: "▣", terminal: "›_", files: "▤", database: "◉",
};
const defaultTileIcons = {
  kubernetes: "kubernetes", "remote-kubernetes": "kubernetes", ssh: "ssh", local: "files",
};

function sourceIcon(source) {
  return Object.hasOwn(tileIcons, source.icon) ? tileIcons[source.icon] : icons[source.type] || "▤";
}

function showMessage(element, message, kind = "") {
  element.textContent = message;
  element.className = `form-message${kind ? ` ${kind}` : ""}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Server returned an invalid response (${response.status}).`);
  }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.code = data.code;
    throw error;
  }
  return data;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), 3200);
}

function sourceSubtitle(source) {
  if (source.type === "kubernetes") return `${source.context} · ${source.namespace}`;
  if (source.type === "remote-kubernetes") {
    return `${source.username}@${source.host} · ${source.context} · ${source.namespace}`;
  }
  if (source.type === "ssh") return `${source.username}@${source.host}`;
  return `${source.paths.length} local file${source.paths.length === 1 ? "" : "s"}`;
}

function renderSources() {
  sourceGrid.querySelectorAll(".source-card").forEach((card) => card.remove());
  $("#source-count").textContent = String(sources.length).padStart(2, "0");
  $("#empty-hint").classList.toggle("hidden", sources.length > 0);
  for (const source of sources) {
    const card = document.createElement("article");
    card.className = `source-card type-${source.type}`;

    const top = document.createElement("div");
    top.className = "card-top";
    const icon = document.createElement("span");
    icon.className = "source-icon";
    icon.textContent = sourceIcon(source);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "card-edit";
    edit.textContent = "✎";
    edit.title = "Edit source";
    edit.setAttribute("aria-label", `Edit ${source.name}`);
    edit.addEventListener("click", () => openEditModal(source));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "card-menu";
    remove.textContent = "×";
    remove.title = "Remove source";
    remove.setAttribute("aria-label", `Remove ${source.name}`);
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm(`Remove "${source.name}"?`)) return;
      try {
        await api(`/api/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" });
        sources = sources.filter((item) => item.id !== source.id);
        renderSources();
        toast("Source removed");
      } catch (error) {
        toast(error.message);
      }
    });
    actions.append(edit, remove);
    top.append(icon, actions);

    const content = document.createElement("button");
    content.type = "button";
    content.className = "card-content";
    content.setAttribute("aria-label", `Open ${source.name}`);
    const title = document.createElement("h3");
    title.textContent = source.name;
    const detail = document.createElement("span");
    detail.className = "source-detail";
    detail.textContent = sourceSubtitle(source);
    const bottom = document.createElement("div");
    bottom.className = "card-bottom";
    const kind = document.createElement("span");
    kind.textContent = source.type === "local"
      ? "Local files"
      : source.type === "remote-kubernetes" ? "Remote Kubernetes" : source.type;
    const open = document.createElement("span");
    open.className = "card-open";
    open.textContent = source.requiresPassword ? "Reconnect →" : "View logs →";
    bottom.append(kind, open);
    content.append(title, detail, bottom);
    card.append(top, content);
    content.addEventListener("click", () => openSource(source));
    sourceGrid.insertBefore(card, $("#add-source-card"));
  }
}

async function loadSources() {
  try {
    sources = (await api("/api/sources")).sources;
    renderSources();
  } catch (error) {
    toast(error.message);
  }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("logstation-theme", theme);
}

function selectTileIcon(icon) {
  currentIcon = Object.hasOwn(tileIcons, icon) ? icon : defaultTileIcons[currentType];
  for (const button of document.querySelectorAll(".icon-choice")) {
    const active = button.dataset.icon === currentIcon;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function setFormType(type) {
  currentType = type;
  selectTileIcon(defaultTileIcons[type]);
  for (const tab of document.querySelectorAll(".source-tab")) {
    tab.classList.toggle("active", tab.dataset.type === type);
    tab.setAttribute("aria-selected", String(tab.dataset.type === type));
  }
  const groups = {
    kubernetes: $("#kubernetes-fields"),
    "remote-kubernetes": $("#remote-kubernetes-fields"),
    ssh: $("#ssh-fields"),
    local: $("#local-fields"),
  };
  for (const [name, group] of Object.entries(groups)) {
    const active = name === type;
    group.classList.toggle("hidden", !active);
    group.querySelectorAll("input, select, textarea").forEach((field) => {
      field.disabled = !active;
    });
  }
  $("#form-message").classList.add("hidden");
}

function splitPaths(value) {
  return value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
}

function formSource() {
  const source = {
    name: $("#source-title-field").value.trim(),
    icon: currentIcon,
  };
  if (currentType === "kubernetes") {
    const context = $("#context-field").value;
    Object.assign(source, { type: "kubernetes", context, namespace: $("#namespace-field").value });
  } else if (currentType === "remote-kubernetes") {
    const host = $("#remote-kube-host-field").value.trim();
    Object.assign(source, {
      type: "remote-kubernetes", host,
      username: $("#remote-kube-username-field").value.trim(),
      password: $("#remote-kube-password-field").value,
      context: $("#remote-kube-context-field").value,
      namespace: $("#remote-kube-namespace-field").value,
    });
  } else if (currentType === "ssh") {
    const host = $("#host-field").value.trim();
    Object.assign(source, {
      type: "ssh", host, username: $("#username-field").value.trim(),
      password: $("#password-field").value, paths: splitPaths($("#ssh-paths-field").value),
    });
  } else {
    Object.assign(source, { type: "local", paths: splitPaths($("#local-paths-field").value) });
  }
  if (editingSourceId) source.id = editingSourceId;
  return source;
}

async function loadContexts(selectedContext = "", selectedNamespace = "") {
  const contextField = $("#context-field");
  contextField.replaceChildren(new Option("Loading contexts…", ""));
  try {
    const data = await api("/api/contexts");
    contextField.replaceChildren(new Option("Select a context", ""));
    for (const context of data.contexts) {
      const option = new Option(context.name, context.name);
      option.textContent = context.cluster ? `${context.name} · ${context.cluster}` : context.name;
      contextField.add(option);
    }
    if (selectedContext && !data.contexts.some((context) => context.name === selectedContext)) {
      contextField.add(new Option(`${selectedContext} (saved)`, selectedContext));
    }
    if (selectedContext) contextField.value = selectedContext;
    else if (data.active) contextField.value = data.active;
    if (!data.contexts.length && !selectedContext) {
      contextField.replaceChildren(new Option("No local contexts found", ""));
    }
  } catch (error) {
    contextField.replaceChildren(new Option("Could not load kubeconfig", ""));
    if (selectedContext) {
      contextField.add(new Option(`${selectedContext} (saved)`, selectedContext));
      contextField.value = selectedContext;
    }
    showMessage($("#form-message"), error.message, "error");
  }
  await loadNamespaces(contextField.value, selectedNamespace);
}

async function loadNamespaces(context, selectedNamespace = "") {
  const namespaceField = $("#namespace-field");
  namespaceField.replaceChildren(new Option(context ? "Loading namespaces…" : "Choose a context first", ""));
  if (!context) return;
  try {
    const data = await api(`/api/namespaces/${encodeURIComponent(context)}`);
    namespaceField.replaceChildren(new Option("Select a namespace", ""));
    for (const namespace of data.namespaces) namespaceField.add(new Option(namespace, namespace));
    if (selectedNamespace && !data.namespaces.includes(selectedNamespace)) {
      namespaceField.add(new Option(`${selectedNamespace} (saved)`, selectedNamespace));
    }
    if (selectedNamespace) namespaceField.value = selectedNamespace;
    else if (data.namespaces.includes("default")) namespaceField.value = "default";
    if (!data.namespaces.length && !selectedNamespace) {
      namespaceField.replaceChildren(new Option("No namespaces found", ""));
    }
  } catch (error) {
    namespaceField.replaceChildren(new Option("Could not load namespaces", ""));
    if (selectedNamespace) {
      namespaceField.add(new Option(`${selectedNamespace} (saved)`, selectedNamespace));
      namespaceField.value = selectedNamespace;
    }
    showMessage($("#form-message"), error.message, "error");
  }
}

function remoteKubeCredentials() {
  return {
    host: $("#remote-kube-host-field").value.trim(),
    username: $("#remote-kube-username-field").value.trim(),
    password: $("#remote-kube-password-field").value,
  };
}

async function loadRemoteContexts() {
  const contextField = $("#remote-kube-context-field");
  contextField.replaceChildren(new Option("Loading remote contexts…", ""));
  try {
    const data = await api("/api/remote-kubernetes/contexts", {
      method: "POST",
      body: JSON.stringify(remoteKubeCredentials()),
    });
    contextField.replaceChildren(new Option("Select a context", ""));
    for (const context of data.contexts) {
      const option = new Option(context.name, context.name);
      option.textContent = context.cluster ? `${context.name} · ${context.cluster}` : context.name;
      contextField.add(option);
    }
    if (data.active) contextField.value = data.active;
    if (!data.contexts.length) contextField.replaceChildren(new Option("No remote contexts found", ""));
    await loadRemoteNamespaces(contextField.value);
  } catch (error) {
    contextField.replaceChildren(new Option("Could not load remote contexts", ""));
    showMessage($("#form-message"), error.message, "error");
  }
}

async function loadRemoteNamespaces(context) {
  const namespaceField = $("#remote-kube-namespace-field");
  namespaceField.replaceChildren(new Option(context ? "Loading namespaces…" : "Choose a context first", ""));
  if (!context) return;
  try {
    const data = await api("/api/remote-kubernetes/namespaces", {
      method: "POST",
      body: JSON.stringify({ ...remoteKubeCredentials(), context }),
    });
    namespaceField.replaceChildren(new Option("Select a namespace", ""));
    for (const namespace of data.namespaces) namespaceField.add(new Option(namespace, namespace));
    if (data.namespaces.includes("default")) namespaceField.value = "default";
    if (!data.namespaces.length) namespaceField.replaceChildren(new Option("No namespaces found", ""));
  } catch (error) {
    namespaceField.replaceChildren(new Option("Could not load namespaces", ""));
    showMessage($("#form-message"), error.message, "error");
  }
}

function configureFormMode(source = null) {
  editingSourceId = source?.id || null;
  const editing = Boolean(editingSourceId);
  $(".modal-header .eyebrow").textContent = editing ? "EDIT SOURCE" : "CONNECT A SOURCE";
  $("#modal-title").textContent = editing ? "Edit source" : "Add a log source";
  $("#save-source").textContent = editing ? "Save changes →" : "Save source →";
  for (const tab of document.querySelectorAll(".source-tab")) {
    tab.disabled = editing && tab.dataset.type !== source.type;
  }
  for (const field of [$("#password-field"), $("#remote-kube-password-field")]) {
    field.required = !editing;
    field.placeholder = editing ? "Leave blank to keep current password" : "SSH password";
  }
}

function openModal() {
  sourceForm.reset();
  configureFormMode();
  modalBackdrop.classList.remove("hidden");
  setFormType("kubernetes");
  loadContexts();
  $("#close-modal").focus();
}

function openEditModal(source) {
  sourceForm.reset();
  configureFormMode(source);
  modalBackdrop.classList.remove("hidden");
  setFormType(source.type);
  selectTileIcon(source.icon);
  $("#source-title-field").value = source.name;

  if (source.type === "kubernetes") {
    loadContexts(source.context, source.namespace);
  } else if (source.type === "remote-kubernetes") {
    $("#remote-kube-host-field").value = source.host;
    $("#remote-kube-username-field").value = source.username;
    $("#remote-kube-context-field").replaceChildren(new Option(source.context, source.context));
    $("#remote-kube-namespace-field").replaceChildren(new Option(source.namespace, source.namespace));
  } else if (source.type === "ssh") {
    $("#host-field").value = source.host;
    $("#username-field").value = source.username;
    $("#ssh-paths-field").value = source.paths.join("\n");
  } else {
    $("#local-paths-field").value = source.paths.join("\n");
  }
  $("#source-title-field").focus();
}

function closeModal() {
  modalBackdrop.classList.add("hidden");
  sourceForm.reset();
  configureFormMode();
  setFormType("kubernetes");
  $("#form-message").classList.add("hidden");
}

async function testConnection() {
  const message = $("#form-message");
  try {
    const result = await api("/api/test-source", {
      method: "POST",
      body: JSON.stringify(formSource()),
    });
    showMessage(message, result.message, "success");
  } catch (error) {
    showMessage(message, error.message, "error");
  }
}

async function saveSource(event) {
  event.preventDefault();
  const message = $("#form-message");
  const source = formSource();
  const isEditing = Boolean(editingSourceId);
  try {
    if (isEditing) {
      const result = await api(`/api/sources/${encodeURIComponent(editingSourceId)}`, {
        method: "PUT",
        body: JSON.stringify(source),
      });
      sources = sources.map((item) => item.id === editingSourceId ? result.source : item);
    } else {
      await api("/api/test-source", { method: "POST", body: JSON.stringify(source) });
      const result = await api("/api/sources", { method: "POST", body: JSON.stringify(source) });
      sources.push(result.source);
    }
    renderSources();
    closeModal();
    toast(isEditing ? "Source updated" : "Source connected and saved");
  } catch (error) {
    showMessage(message, error.message, "error");
  }
}

function showHome() {
  clearInterval(refreshTimer);
  refreshTimer = null;
  activeSource = null;
  activeFile = null;
  $("#main-content").classList.remove("viewer-active");
  $("#home-view").classList.remove("hidden");
  $("#viewer-view").classList.add("hidden");
}

function openPasswordDialog(sourceId) {
  passwordSourceId = sourceId;
  $("#password-message").classList.add("hidden");
  $("#reconnect-password").value = "";
  $("#password-backdrop").classList.remove("hidden");
  $("#reconnect-password").focus();
}

async function openSource(source) {
  activeSource = source;
  activeFile = null;
  paused = false;
  $("#pause-logs").innerHTML = "<span>Ⅱ</span> Pause";
  $("#pause-logs").classList.remove("paused");
  $("#main-content").classList.add("viewer-active");
  $("#home-view").classList.add("hidden");
  $("#viewer-view").classList.remove("hidden");
  $("#viewer-title").textContent = source.name;
  $("#viewer-subtitle").textContent = sourceSubtitle(source);
  $("#viewer-source-icon").className = `mini-source-icon type-${source.type}`;
  $("#viewer-source-icon").textContent = sourceIcon(source);
  $("#file-filter").value = "";
  $("#file-list").replaceChildren();
  showLogEmpty("Loading log streams…", "Fetching available files and containers.");
  if (source.requiresPassword) openPasswordDialog(source.id);
  await loadFiles();
}

async function loadFiles() {
  if (!activeSource) return;
  try {
    const data = await api(`/api/sources/${encodeURIComponent(activeSource.id)}/files`);
    renderFiles(data.files);
    if (data.files.length && !activeFile) selectFile(data.files[0]);
    if (!data.files.length) showLogEmpty("No log streams found", "This source doesn't have any available files or containers.");
  } catch (error) {
    $("#file-list").replaceChildren();
    showLogEmpty("Couldn't load log streams", error.message);
    $("#log-status").textContent = "CONNECTION ERROR";
  }
}

function renderFiles(files) {
  fileList.replaceChildren();
  $("#stream-count").textContent = `${files.length} stream${files.length === 1 ? "" : "s"}`;
  for (const file of files) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `file-item${activeFile?.id === file.id ? " active" : ""}`;
    button.dataset.search = `${file.label} ${file.detail}`.toLowerCase();
    const icon = document.createElement("span");
    icon.className = "file-item-icon";
    icon.textContent = ["kubernetes", "remote-kubernetes"].includes(activeSource.type) ? "▧" : "▤";
    const text = document.createElement("span");
    text.className = "file-item-text";
    const label = document.createElement("strong");
    label.textContent = file.label;
    const detail = document.createElement("small");
    detail.textContent = file.detail;
    text.append(label, detail);
    button.append(icon, text);
    button.addEventListener("click", () => selectFile(file));
    fileList.append(button);
  }
  filterFiles();
}

function selectFile(file) {
  activeFile = file;
  for (const button of fileList.querySelectorAll(".file-item")) {
    button.classList.toggle("active", button.dataset.search.startsWith(`${file.label} ${file.detail}`.toLowerCase()));
  }
  const selected = [...fileList.querySelectorAll(".file-item")].find((item) => item.querySelector("strong").textContent === file.label && item.querySelector("small").textContent === file.detail);
  if (selected) {
    fileList.querySelectorAll(".file-item").forEach((item) => item.classList.remove("active"));
    selected.classList.add("active");
  }
  $("#selected-file").textContent = `${file.detail} / ${file.label}`;
  $("#log-status").textContent = "CONNECTING";
  latestLogs = "";
  renderLogs("");
  refreshLogs();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (!paused) refreshLogs(); }, 2500);
}

function showLogEmpty(title, description) {
  const empty = document.createElement("div");
  empty.className = "log-empty";
  const icon = document.createElement("span");
  icon.className = "empty-terminal";
  icon.textContent = "›_";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const detail = document.createElement("p");
  detail.textContent = description;
  empty.append(icon, heading, detail);
  logOutput.replaceChildren(empty);
}

async function refreshLogs() {
  if (!activeSource || !activeFile) return;
  try {
    const url = `/api/sources/${encodeURIComponent(activeSource.id)}/logs?file=${encodeURIComponent(activeFile.id)}&lines=${tailLines}`;
    const data = await api(url);
    latestLogs = data.logs;
    renderLogs(latestLogs);
    $("#log-status").textContent = "CONNECTED";
  } catch (error) {
    $("#log-status").textContent = "CONNECTION ERROR";
    if (error.code === "password_required" && $("#password-backdrop").classList.contains("hidden")) {
      openPasswordDialog(activeSource.id);
    }
    else showLogEmpty("Log stream unavailable", error.message);
  }
}

function renderLogs(text) {
  const wasNearBottom = logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight < 60;
  const filter = $("#log-filter").value.toLowerCase();
  $("#clear-filter").style.display = filter ? "inline-block" : "none";
  const allLines = text ? text.split(/\r?\n/) : [];
  const lines = allLines.map((value, index) => ({ value, index })).filter(({ value }) => !filter || value.toLowerCase().includes(filter));
  $("#line-count").textContent = `${lines.length} LINE${lines.length === 1 ? "" : "S"}`;
  if (!lines.length) {
    showLogEmpty(text ? "No matching lines" : "Waiting for log output", text ? "Try a different filter." : "New lines will appear here as they are written.");
    return;
  }
  const wrapper = document.createElement("div");
  wrapper.className = `log-lines${wrapLines ? " wrap-lines" : ""}`;
  for (const { value, index } of lines) {
    const row = document.createElement("div");
    row.className = "log-line";
    const lower = value.toLowerCase();
    if (/\b(error|fatal|panic|critical)\b/.test(lower)) row.classList.add("error");
    else if (/\b(warn|warning)\b/.test(lower)) row.classList.add("warning");
    else if (/\b(info|debug)\b/.test(lower)) row.classList.add("info");
    const number = document.createElement("span");
    number.className = "line-number";
    number.textContent = String(index + 1);
    const content = document.createElement("span");
    content.className = "line-content";
    content.textContent = value;
    row.append(number, content);
    wrapper.append(row);
  }
  logOutput.replaceChildren(wrapper);
  if (wasNearBottom) logOutput.scrollTop = logOutput.scrollHeight;
}

function filterFiles() {
  const query = $("#file-filter").value.trim().toLowerCase();
  fileList.querySelectorAll(".file-item").forEach((item) => {
    item.classList.toggle("hidden", !item.dataset.search.includes(query));
  });
}

async function savePassword(event) {
  event.preventDefault();
  if (!passwordSourceId) return;
  const message = $("#password-message");
  try {
    await api(`/api/sources/${encodeURIComponent(passwordSourceId)}/credentials`, {
      method: "POST",
      body: JSON.stringify({ password: $("#reconnect-password").value }),
    });
    $("#password-backdrop").classList.add("hidden");
    activeSource.requiresPassword = false;
    const saved = sources.find((source) => source.id === activeSource.id);
    if (saved) saved.requiresPassword = false;
    renderSources();
    passwordSourceId = null;
    await loadFiles();
  } catch (error) {
    showMessage(message, error.message, "error");
  }
}

$("#add-source-card").addEventListener("click", openModal);
$("#close-modal").addEventListener("click", closeModal);
$("#test-source").addEventListener("click", testConnection);
sourceForm.addEventListener("submit", saveSource);
document.querySelectorAll(".source-tab").forEach((button) => {
  button.addEventListener("click", () => setFormType(button.dataset.type));
});
document.querySelectorAll(".icon-choice").forEach((button) => {
  button.addEventListener("click", () => selectTileIcon(button.dataset.icon));
});
$("#context-field").addEventListener("change", (event) => loadNamespaces(event.target.value));
$("#load-remote-contexts").addEventListener("click", loadRemoteContexts);
$("#remote-kube-context-field").addEventListener("change", (event) => loadRemoteNamespaces(event.target.value));
$("#theme-toggle").addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});
$("#back-home").addEventListener("click", showHome);
$("#refresh-files").addEventListener("click", loadFiles);
$("#file-filter").addEventListener("input", filterFiles);
$("#sidebar-toggle").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const collapsed = $(".log-workspace").classList.toggle("sidebar-collapsed");
  button.textContent = collapsed ? "Show files" : "Hide files";
  button.setAttribute("aria-expanded", String(!collapsed));
});
$("#log-filter").addEventListener("input", () => renderLogs(latestLogs));
$("#tail-lines").value = String(tailLines);
$("#tail-lines").addEventListener("change", (event) => {
  const input = event.currentTarget;
  const value = input.valueAsNumber;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TAIL_LINES) {
    input.value = String(tailLines);
    return;
  }
  tailLines = value;
  localStorage.setItem("logstation-tail-lines", String(tailLines));
  if (!paused) refreshLogs();
});
$("#clear-filter").addEventListener("click", () => {
  $("#log-filter").value = "";
  renderLogs(latestLogs);
});
$("#pause-logs").addEventListener("click", () => {
  paused = !paused;
  $("#pause-logs").classList.toggle("paused", paused);
  $("#pause-logs").innerHTML = paused ? "<span>▶</span> Resume" : "<span>Ⅱ</span> Pause";
  if (!paused) refreshLogs();
});
$("#wrap-lines").addEventListener("click", (event) => {
  wrapLines = !wrapLines;
  localStorage.setItem("logstation-wrap-lines", String(wrapLines));
  event.currentTarget.setAttribute("aria-pressed", String(wrapLines));
  event.currentTarget.classList.toggle("active", wrapLines);
  renderLogs(latestLogs);
});
$("#close-password-modal").addEventListener("click", () => $("#password-backdrop").classList.add("hidden"));
$("#password-form").addEventListener("submit", savePassword);
modalBackdrop.addEventListener("click", (event) => {
  if (event.target === modalBackdrop) closeModal();
});
$("#password-backdrop").addEventListener("click", (event) => {
  if (event.target === $("#password-backdrop")) $("#password-backdrop").classList.add("hidden");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModal();
    $("#password-backdrop").classList.add("hidden");
  }
});

setTheme(localStorage.getItem("logstation-theme") || "light");
$("#wrap-lines").setAttribute("aria-pressed", String(wrapLines));
$("#wrap-lines").classList.toggle("active", wrapLines);
loadSources();
