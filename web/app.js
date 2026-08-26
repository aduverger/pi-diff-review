const {
  acceptComparison,
  beginComparison,
  buildFileTree,
  contextIndexKey,
  createCompareState,
  directoryKey,
  getFilePath,
  receiveComparison,
  rejectComparison,
  repositoryCollapseKey,
  restoreComparisonInputs,
  settleFileLoad,
  viewKey,
} = globalThis.__piDiffReviewState;

const bootstrapData = JSON.parse(document.getElementById("diff-review-data").textContent || "{}");

const state = {
  workspaceRoot: bootstrapData.workspaceRoot || "",
  workspaceLoaded: false,
  warnings: [],
  repositories: [],
  repositoriesById: new Map(),
  compareByRepositoryId: new Map(),
  fileIndexesByContext: new Map(),
  selectedMode: "uncommitted",
  repositoryFilter: "all",
  fileFilter: "",
  active: null,
  sidebarCollapsed: false,
  collapsedRepositories: new Set(),
  collapsedDirectories: new Set(),
  comments: new Map(),
  commentCounts: new Map(),
  reviewed: new Map(),
  loads: new Map(),
  viewStates: new Map(),
  overallComment: "",
  wrapLines: true,
  minimap: true,
  hideUnchanged: false,
  requestSequence: 0,
  initialCompareRequested: false,
  terminalMessageSent: false,
  treeRowsByViewKey: new Map(),
};

const rootLayoutEl = document.getElementById("root-layout");
const workspaceRootEl = document.getElementById("workspace-root");
const workspaceWarningsEl = document.getElementById("workspace-warnings");
const summaryEl = document.getElementById("summary");
const sidebarEl = document.getElementById("sidebar");
const toggleSidebarButton = document.getElementById("toggle-sidebar-button");
const tabUncommittedButton = document.getElementById("tab-uncommitted-button");
const tabCompareButton = document.getElementById("tab-compare-button");
const repositoryFilterEl = document.getElementById("repository-filter");
const sidebarSearchInputEl = document.getElementById("sidebar-search-input");
const fileTreeEl = document.getElementById("file-tree");
const currentFileLabelEl = document.getElementById("current-file-label");
const modeHintEl = document.getElementById("mode-hint");
const fileCommentsContainer = document.getElementById("file-comments-container");
const editorContainerEl = document.getElementById("editor-container");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const overallCommentButton = document.getElementById("overall-comment-button");
const fileCommentButton = document.getElementById("file-comment-button");
const toggleReviewedButton = document.getElementById("toggle-reviewed-button");
const toggleUnchangedButton = document.getElementById("toggle-unchanged-button");
const toggleWrapButton = document.getElementById("toggle-wrap-button");
const toggleMinimapButton = document.getElementById("toggle-minimap-button");
const reviewDialogEl = document.getElementById("review-dialog");
const reviewDialogFormEl = document.getElementById("review-dialog-form");
const reviewDialogTitleEl = document.getElementById("review-dialog-title");
const reviewDialogDescriptionEl = document.getElementById("review-dialog-description");
const reviewDialogTextLabelEl = document.getElementById("review-dialog-text-label");
const reviewDialogTextEl = document.getElementById("review-dialog-text");
const reviewDialogCancelEl = document.getElementById("review-dialog-cancel");
const reviewDialogSaveEl = document.getElementById("review-dialog-save");
const fatalOverlayEl = document.getElementById("fatal-overlay");
const fatalMessageEl = document.getElementById("fatal-message");
const fatalCancelButton = document.getElementById("fatal-cancel-button");

let monacoApi = null;
let diffEditor = null;
let originalModel = null;
let modifiedModel = null;
let originalLanguage = "plaintext";
let modifiedLanguage = "plaintext";
let mountedViewKey = null;
let pendingViewRestore = null;
let originalDecorations = null;
let modifiedDecorations = null;
let originalHoverDecorations = null;
let modifiedHoverDecorations = null;
let activeInlineZones = new Map();
let activeFileCommentElements = new Map();
let dialogState = null;
let scheduledTreeRender = null;
const dialogQueue = [];
const hoverResetters = [];

workspaceRootEl.textContent = state.workspaceRoot;

function makeElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function nextRequestId(prefix) {
  state.requestSequence += 1;
  return `${prefix}:${Date.now()}:${state.requestSequence}`;
}

function sendToHost(message) {
  if (!window.glimpse?.send) {
    showFatalError("The native review bridge is unavailable.");
    return false;
  }
  try {
    window.glimpse.send(message);
    return true;
  } catch (error) {
    showFatalError(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function showFatalError(message) {
  const text = message || "Unknown browser error.";
  fatalMessageEl.textContent = text;
  fatalOverlayEl.hidden = false;
  rootLayoutEl.inert = true;
  fatalCancelButton.focus();
}

function sendTerminalMessage(message) {
  if (state.terminalMessageSent) return;
  if (sendToHost(message)) state.terminalMessageSent = true;
}

function indexChangeSet(changeSet) {
  if (!changeSet?.context?.key) return;
  const files = changeSet.files || [];
  state.fileIndexesByContext.set(
    contextIndexKey(changeSet.context.repositoryId, changeSet.context.key),
    new Map(files.map((file) => [file.id, file])),
  );
  files.forEach((file) => {
    const key = viewKey(changeSet.context.repositoryId, changeSet.context.key, file.id);
    if (state.loads.has(key)) return;
    state.loads.set(key, {
      status: "idle",
      requestId: null,
      repositoryId: changeSet.context.repositoryId,
      contextKey: changeSet.context.key,
      fileId: file.id,
      mode: changeSet.context.mode,
    });
  });
}

function getRepository(repositoryId) {
  return state.repositoriesById.get(repositoryId) || null;
}

function getCompareState(repositoryId) {
  return state.compareByRepositoryId.get(repositoryId) || null;
}

function getChangeSet(repository, mode = state.selectedMode) {
  if (!repository) return null;
  if (mode === "uncommitted") return repository.uncommitted || null;
  return getCompareState(repository.id)?.comparison?.changeSet || null;
}

function getCurrentChangeSet(repositoryId) {
  return getChangeSet(getRepository(repositoryId));
}

function getIndexedFile(repositoryId, contextKey, fileId) {
  return state.fileIndexesByContext.get(contextIndexKey(repositoryId, contextKey))?.get(fileId) || null;
}

function getActiveDetails() {
  if (!state.active) return null;
  const repository = getRepository(state.active.repositoryId);
  const changeSet = getCurrentChangeSet(state.active.repositoryId);
  if (!repository || !changeSet || changeSet.context.key !== state.active.contextKey) return null;
  const file = getIndexedFile(state.active.repositoryId, state.active.contextKey, state.active.fileId);
  if (!file) return null;
  return {
    repository,
    changeSet,
    context: changeSet.context,
    file,
    key: viewKey(repository.id, changeSet.context.key, file.id),
  };
}

function getBaseName(path) {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1] || path || "(unknown)";
}

function statusLabel(status) {
  switch (status) {
    case "added": return "Added";
    case "copied": return "Copied";
    case "conflicted": return "Conflicted";
    case "deleted": return "Deleted";
    case "renamed": return "Renamed";
    case "modified": return "Modified";
    case "type-changed": return "Type changed";
    default: return status || "Changed";
  }
}

function statusLetter(status) {
  switch (status) {
    case "added": return "A";
    case "copied": return "C";
    case "conflicted": return "U";
    case "deleted": return "D";
    case "renamed": return "R";
    case "type-changed": return "T";
    default: return "M";
  }
}

function statusClass(status) {
  switch (status) {
    case "added": return "text-[#3fb950]";
    case "conflicted": return "text-[#f85149]";
    case "deleted": return "text-[#f85149]";
    case "copied": return "text-[#d29922]";
    case "renamed": return "text-[#d29922]";
    case "type-changed": return "text-[#d29922]";
    default: return "text-[#58a6ff]";
  }
}

function inferLanguage(path) {
  const lower = String(path || "").toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss") || lower.endsWith(".sass")) return "scss";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c";
  if (lower.endsWith(".cc") || lower.endsWith(".cpp") || lower.endsWith(".hpp")) return "cpp";
  if (lower.endsWith(".xml")) return "xml";
  if (lower.endsWith(".sql")) return "sql";
  return "plaintext";
}

function normalizeQuery(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function scoreSubsequence(query, candidate) {
  if (!query) return 0;
  let queryIndex = 0;
  let score = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -2;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;
    if (firstMatchIndex === -1) firstMatchIndex = index;
    score += 10;
    if (index === previousMatchIndex + 1) score += 8;
    const previous = index > 0 ? candidate[index - 1] : "";
    if (index === 0 || "/_-.".includes(previous)) score += 12;
    previousMatchIndex = index;
    queryIndex += 1;
  }
  if (queryIndex !== query.length) return -1;
  return score + Math.max(0, 20 - firstMatchIndex);
}

function getFileSearchScore(query, file) {
  const normalized = normalizeQuery(query);
  if (!normalized) return 0;
  const path = [file.displayPath, file.newPath, file.oldPath].filter(Boolean).join(" ").toLowerCase();
  const baseName = getBaseName(file.newPath || file.oldPath || file.displayPath).toLowerCase();
  const pathScore = scoreSubsequence(normalized, path);
  const baseScore = scoreSubsequence(normalized, baseName);
  let score = Math.max(pathScore, baseScore >= 0 ? baseScore + 40 : -1);
  if (score < 0) return -1;
  if (baseName === normalized) score += 200;
  else if (baseName.startsWith(normalized)) score += 120;
  else if (path.includes(normalized)) score += 35;
  return score;
}

function filteredFiles(changeSet) {
  const files = [...(changeSet?.files || [])];
  const query = state.fileFilter.trim();
  if (!query) return files.sort((a, b) => getFilePath(a).localeCompare(getFilePath(b)));
  return files
    .map((file) => ({ file, score: getFileSearchScore(query, file) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || getFilePath(a.file).localeCompare(getFilePath(b.file)))
    .map((entry) => entry.file);
}

function currentViewKey() {
  return getActiveDetails()?.key || null;
}

function isReviewed(key) {
  return state.reviewed.has(key);
}

function getLoad(key) {
  return state.loads.get(key) || null;
}

function activeComments(side) {
  const key = currentViewKey();
  if (!key) return [];
  return [...state.comments.values()].filter((comment) => viewKey(comment.repositoryId, comment.contextKey, comment.fileId) === key && (!side || comment.side === side));
}

function updateSummary() {
  const repositoryCount = state.repositories.length;
  const commentCount = state.comments.size;
  const note = state.overallComment ? " • overall note" : "";
  summaryEl.textContent = state.workspaceLoaded
    ? `${repositoryCount} repositor${repositoryCount === 1 ? "y" : "ies"} • ${commentCount} comment${commentCount === 1 ? "" : "s"}${note}`
    : "Loading workspace…";
}

function updateWarnings() {
  const warnings = state.warnings.map((warning) => typeof warning === "string" ? warning : warning?.message || String(warning));
  workspaceWarningsEl.textContent = warnings.join(" • ");
  workspaceWarningsEl.className = warnings.length
    ? "border-b border-[#d29922]/30 bg-[#d29922]/10 px-4 py-2 text-xs text-[#e3b341]"
    : "hidden";
}

function activeButtonClass(active) {
  return active
    ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-3 py-1.5 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25"
    : "cursor-pointer rounded-md border border-review-border bg-review-panel px-3 py-1.5 text-xs font-medium text-review-text hover:bg-[#21262d]";
}

function updateTabs() {
  const uncommitted = state.selectedMode === "uncommitted";
  tabUncommittedButton.className = activeButtonClass(uncommitted);
  tabCompareButton.className = activeButtonClass(!uncommitted);
  tabUncommittedButton.setAttribute("aria-selected", String(uncommitted));
  tabCompareButton.setAttribute("aria-selected", String(!uncommitted));
}

function updateToolbar() {
  const active = getActiveDetails();
  const reviewed = active ? isReviewed(active.key) : false;
  const fileReady = active ? getLoad(active.key)?.status === "ready" : false;
  toggleReviewedButton.disabled = !active;
  toggleReviewedButton.textContent = reviewed ? "Reviewed" : "Mark reviewed";
  toggleReviewedButton.setAttribute("aria-pressed", String(reviewed));
  toggleReviewedButton.className = reviewed
    ? "cursor-pointer rounded-md border border-[#2ea043]/40 bg-[#238636]/15 px-3 py-1 text-xs font-medium text-[#3fb950] hover:bg-[#238636]/25"
    : "rounded-md border border-review-border bg-review-panel px-3 py-1 text-xs font-medium text-review-text disabled:cursor-default disabled:opacity-50";
  if (active) toggleReviewedButton.classList.add("cursor-pointer", "hover:bg-[#21262d]");
  toggleWrapButton.textContent = `Wrap lines: ${state.wrapLines ? "on" : "off"}`;
  toggleWrapButton.setAttribute("aria-pressed", String(state.wrapLines));
  toggleMinimapButton.textContent = `Minimap: ${state.minimap ? "on" : "off"}`;
  toggleMinimapButton.setAttribute("aria-pressed", String(state.minimap));
  toggleUnchangedButton.disabled = !active;
  toggleUnchangedButton.textContent = state.hideUnchanged ? "Show full file" : "Show changed areas only";
  toggleUnchangedButton.setAttribute("aria-pressed", String(state.hideUnchanged));
  if (active) toggleUnchangedButton.classList.add("cursor-pointer", "hover:bg-[#21262d]");
  fileCommentButton.disabled = !fileReady;
  fileCommentButton.classList.toggle("cursor-pointer", fileReady);
  fileCommentButton.classList.toggle("hover:bg-[#21262d]", fileReady);
}

function updateCurrentFileHeader() {
  const active = getActiveDetails();
  if (!state.workspaceLoaded) {
    currentFileLabelEl.textContent = "Loading workspace…";
    modeHintEl.textContent = "Waiting for repository data.";
    return;
  }
  if (!active) {
    currentFileLabelEl.textContent = "No file selected";
    modeHintEl.textContent = state.selectedMode === "compare"
      ? "Choose refs for a repository, then select a changed file."
      : "No uncommitted file is available in the selected repositories.";
    return;
  }
  currentFileLabelEl.textContent = `${active.repository.name} • ${active.file.displayPath}`;
  if (active.context.mode === "compare") {
    const base = active.context.baseRef || active.context.baseOid || "base";
    const head = active.context.headRef || active.context.headOid || "head";
    modeHintEl.textContent = `Compare ${base} → ${head}. Select lines or use the gutter to add a comment.`;
  } else {
    modeHintEl.textContent = "Uncommitted changes. Select lines or use the gutter to add a comment.";
  }
}

function captureTreeFocus() {
  const activeElement = document.activeElement;
  if (!activeElement || !fileTreeEl.contains(activeElement) || !activeElement.dataset.focusKey) return null;
  return {
    key: activeElement.dataset.focusKey,
    start: typeof activeElement.selectionStart === "number" ? activeElement.selectionStart : null,
    end: typeof activeElement.selectionEnd === "number" ? activeElement.selectionEnd : null,
  };
}

function findTreeFocusTarget(focusKey) {
  if (!focusKey) return null;
  return [...fileTreeEl.querySelectorAll("[data-focus-key]")]
    .find((element) => element.dataset.focusKey === focusKey) || null;
}

function restoreTreeFocus(snapshot) {
  if (!snapshot) return;
  const target = findTreeFocusTarget(snapshot.key);
  if (!target) return;
  target.focus({ preventScroll: true });
  if (snapshot.start != null && typeof target.setSelectionRange === "function") {
    target.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
  }
}

function appendMessage(parent, text, className = "px-3 py-2 text-xs text-review-muted") {
  parent.appendChild(makeElement("div", className, text));
}

function registerTreeRow(key, row) {
  const rows = state.treeRowsByViewKey.get(key) || [];
  rows.push(row);
  state.treeRowsByViewKey.set(key, rows);
}

function fileRowAriaLabel(file, key) {
  const count = state.commentCounts.get(key) || 0;
  const parts = [file.displayPath, statusLabel(file.status)];
  if (isReviewed(key)) parts.push("reviewed");
  if (count) parts.push(`${count} comment${count === 1 ? "" : "s"}`);
  const load = getLoad(key);
  if (load?.status === "loading") parts.push("loading");
  if (load?.status === "error") parts.push("load failed");
  return parts.join(", ");
}

function applyFileRowState(row, file, key) {
  const active = currentViewKey() === key;
  const reviewed = isReviewed(key);
  const count = state.commentCounts.get(key) || 0;
  const load = getLoad(key);
  row.button.className = [
    "group flex w-full items-center justify-between gap-2 py-1 pr-2 text-left text-[13px]",
    active ? "bg-[#373e47] text-white" : reviewed ? "text-[#c9d1d9] hover:bg-[#21262d]" : "text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]",
  ].join(" ");
  row.button.setAttribute("aria-current", active ? "true" : "false");
  row.button.setAttribute("aria-label", fileRowAriaLabel(file, key));
  row.marker.textContent = reviewed ? "●" : load?.status === "error" ? "!" : load?.status === "loading" ? "…" : "";
  row.marker.className = `shrink-0 text-[10px] ${reviewed ? "text-[#3fb950]" : load?.status === "error" ? "text-red-400" : load?.status === "loading" ? "text-[#58a6ff]" : "text-transparent"}`;
  row.count.textContent = count ? String(count) : "";
  row.count.hidden = count === 0;
}

function updateFileRow(key) {
  const active = getActiveDetails();
  const rows = state.treeRowsByViewKey.get(key) || [];
  const first = rows[0];
  const file = first?.file || (active?.key === key ? active.file : null);
  if (!file) return;
  rows.forEach((row) => applyFileRowState(row, file, key));
}

function createFileRow(repository, changeSet, file, depth, parent) {
  const key = viewKey(repository.id, changeSet.context.key, file.id);
  const button = makeElement("button", "", null);
  button.type = "button";
  button.style.paddingLeft = `${depth * 12 + 20}px`;
  button.dataset.focusKey = `file:${key}`;
  const left = makeElement("span", "flex min-w-0 items-center gap-1.5 truncate");
  const marker = makeElement("span", "shrink-0 text-[10px]");
  const name = makeElement("span", "truncate", state.fileFilter.trim() ? file.displayPath : getBaseName(getFilePath(file)));
  name.title = file.displayPath;
  left.append(marker, name);
  const right = makeElement("span", "flex shrink-0 items-center gap-1.5");
  const count = makeElement("span", "flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#1f2937] px-1 text-[10px] font-medium text-[#c9d1d9]");
  const status = makeElement("span", `font-medium ${statusClass(file.status)}`, statusLetter(file.status));
  status.title = statusLabel(file.status);
  right.append(count, status);
  button.append(left, right);
  button.addEventListener("click", () => activateFile(repository.id, changeSet.context, file.id));
  const row = { button, marker, count, file };
  applyFileRowState(row, file, key);
  registerTreeRow(key, row);
  parent.appendChild(button);
}

function sortedTreeChildren(node) {
  return [...node.children.values()].sort((a, b) => {
    const aDirectory = a.children.size > 0;
    const bDirectory = b.children.size > 0;
    if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function compactDirectory(node) {
  const names = [node.name];
  let terminal = node;
  while (!terminal.file && terminal.children.size === 1) {
    const child = [...terminal.children.values()][0];
    if (child.file || child.children.size === 0) break;
    names.push(child.name);
    terminal = child;
  }
  return { label: names.join("/"), terminal };
}

function renderTreeNode(repository, changeSet, node, depth, parent) {
  if (node.file) createFileRow(repository, changeSet, node.file, depth, parent);
  if (node.children.size === 0) return;
  const compact = compactDirectory(node);
  const collapseKey = directoryKey(state.selectedMode, repository.id, changeSet.context.key, compact.terminal.path);
  const collapsed = state.collapsedDirectories.has(collapseKey);
  const directoryButton = makeElement("button", "group flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[13px] text-[#c9d1d9] hover:bg-[#21262d]");
  directoryButton.type = "button";
  directoryButton.style.paddingLeft = `${depth * 12 + 8}px`;
  directoryButton.dataset.focusKey = `dir:${collapseKey}`;
  directoryButton.setAttribute("aria-expanded", String(!collapsed));
  const arrow = makeElement("span", `w-4 shrink-0 text-center text-[#8b949e] ${collapsed ? "-rotate-90" : ""}`, "▾");
  const label = makeElement("span", "truncate", `${compact.label}/`);
  directoryButton.append(arrow, label);
  directoryButton.addEventListener("click", () => {
    if (collapsed) state.collapsedDirectories.delete(collapseKey);
    else state.collapsedDirectories.add(collapseKey);
    renderTree();
  });
  parent.appendChild(directoryButton);
  if (collapsed) return;
  sortedTreeChildren(compact.terminal).forEach((child) => renderTreeNode(repository, changeSet, child, depth + 1, parent));
}

function renderFileCollection(repository, changeSet, files, parent) {
  if (state.fileFilter.trim()) {
    files.forEach((file) => createFileRow(repository, changeSet, file, 1, parent));
    return;
  }
  const tree = buildFileTree(files);
  sortedTreeChildren(tree).forEach((node) => renderTreeNode(repository, changeSet, node, 0, parent));
}

function repoStatusText(repository, changeSet, compareState) {
  if (repository.error) return "Repository error";
  if (state.selectedMode === "compare" && compareState?.loading) return "Loading comparison…";
  if (state.selectedMode === "compare" && !changeSet) return compareState?.error ? "Comparison failed" : "Not compared";
  const count = changeSet?.files?.length || 0;
  return `${count} changed file${count === 1 ? "" : "s"}`;
}

function createCompareForm(repository, compareState) {
  const form = makeElement("form", "mx-2 mb-2 grid grid-cols-[1fr_1fr_auto] gap-1.5 rounded-md border border-review-border bg-[#11161d] p-2");
  const baseInput = makeElement("input", "min-w-0 rounded border border-review-border bg-[#010409] px-2 py-1.5 text-[11px] text-review-text outline-none focus:border-blue-500");
  baseInput.type = "text";
  baseInput.value = compareState.baseInput;
  baseInput.placeholder = "Base ref";
  baseInput.setAttribute("aria-label", `Base ref for ${repository.name}`);
  baseInput.dataset.focusKey = `compare-base:${repository.id}`;
  baseInput.addEventListener("input", () => { compareState.baseInput = baseInput.value; });
  const headInput = makeElement("input", "min-w-0 rounded border border-review-border bg-[#010409] px-2 py-1.5 text-[11px] text-review-text outline-none focus:border-blue-500");
  headInput.type = "text";
  headInput.value = compareState.headInput;
  headInput.placeholder = "Head ref";
  headInput.setAttribute("aria-label", `Head ref for ${repository.name}`);
  headInput.dataset.focusKey = `compare-head:${repository.id}`;
  headInput.addEventListener("input", () => { compareState.headInput = headInput.value; });
  const applyButton = makeElement("button", "rounded border border-review-border bg-review-panel px-2 py-1.5 text-[11px] font-medium text-review-text hover:bg-[#21262d]", "Apply");
  applyButton.type = "submit";
  applyButton.dataset.focusKey = `compare-apply:${repository.id}`;
  form.append(baseInput, headInput, applyButton);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    requestComparison(repository.id, compareState.baseInput, compareState.headInput);
  });
  return form;
}

function renderRepository(repository, fragment) {
  const compareState = getCompareState(repository.id);
  const changeSet = getChangeSet(repository);
  const files = filteredFiles(changeSet);
  const collapseKey = repositoryCollapseKey(state.selectedMode, repository.id);
  const forceExpanded = state.fileFilter.trim().length > 0;
  const collapsed = !forceExpanded && state.collapsedRepositories.has(collapseKey);
  const section = makeElement("section", "mt-2 overflow-hidden rounded-md border border-review-border bg-[#0d1117]");
  const header = makeElement("button", "flex w-full items-center gap-2 bg-[#161b22] px-2 py-2 text-left hover:bg-[#21262d]");
  header.type = "button";
  header.dataset.focusKey = `repo:${collapseKey}`;
  header.setAttribute("aria-expanded", String(!collapsed));
  const arrow = makeElement("span", `w-4 shrink-0 text-center text-review-muted ${collapsed ? "-rotate-90" : ""}`, "▾");
  const labels = makeElement("span", "min-w-0 flex-1");
  labels.append(
    makeElement("span", "block truncate text-[13px] font-semibold text-review-text", repository.name),
    makeElement("span", "block truncate text-[10px] text-review-muted", repository.workspacePath || repository.name),
  );
  const status = makeElement("span", "shrink-0 text-[10px] text-review-muted", repoStatusText(repository, changeSet, compareState));
  header.append(arrow, labels, status);
  header.addEventListener("click", () => {
    if (collapsed) state.collapsedRepositories.delete(collapseKey);
    else state.collapsedRepositories.add(collapseKey);
    renderTree();
  });
  section.appendChild(header);
  if (!collapsed) {
    if (state.selectedMode === "compare") section.appendChild(createCompareForm(repository, compareState));
    if (repository.error) appendMessage(section, repository.error, "mx-2 mb-2 rounded border border-red-500/20 bg-red-500/10 px-2 py-2 text-xs text-red-400");
    if (state.selectedMode === "compare" && compareState?.error) {
      appendMessage(section, compareState.error, "mx-2 mb-2 rounded border border-red-500/20 bg-red-500/10 px-2 py-2 text-xs text-red-400");
    }
    if (changeSet && files.length > 0) renderFileCollection(repository, changeSet, files, section);
    else if (changeSet && state.fileFilter.trim()) appendMessage(section, "No files match the filter.");
    else if (changeSet) appendMessage(section, "No changed files.");
    else if (state.selectedMode === "uncommitted") appendMessage(section, "No uncommitted changes.");
    else if (compareState?.loading) appendMessage(section, "Resolving refs and computing changes…");
    else appendMessage(section, repository.baseRef ? "Apply refs to compare." : "Enter a base ref to compare.");
  }
  fragment.appendChild(section);
}

function renderTree() {
  if (scheduledTreeRender !== null) {
    cancelAnimationFrame(scheduledTreeRender);
    scheduledTreeRender = null;
  }
  const scrollTop = fileTreeEl.scrollTop;
  const focusSnapshot = captureTreeFocus();
  state.treeRowsByViewKey = new Map();
  const fragment = document.createDocumentFragment();
  if (!state.workspaceLoaded) {
    appendMessage(fragment, "Loading workspace…", "px-3 py-4 text-sm text-review-muted");
  } else {
    const repositories = state.repositories.filter((repository) => state.repositoryFilter === "all" || repository.id === state.repositoryFilter);
    if (repositories.length === 0) appendMessage(fragment, "No repository matches the filter.", "px-3 py-4 text-sm text-review-muted");
    repositories.forEach((repository) => renderRepository(repository, fragment));
  }
  fileTreeEl.replaceChildren(fragment);
  fileTreeEl.scrollTop = scrollTop;
  restoreTreeFocus(focusSnapshot);
  updateTabs();
  updateToolbar();
  updateSummary();
}

function scheduleTreeRender() {
  if (scheduledTreeRender !== null) return;
  scheduledTreeRender = requestAnimationFrame(() => {
    scheduledTreeRender = null;
    const previousKey = currentViewKey();
    ensureActiveSelection();
    renderTree();
    if (currentViewKey() !== previousKey) mountActiveFile({ restoreSaved: true });
  });
}

function clearFileFilter() {
  const previousKey = currentViewKey();
  state.fileFilter = "";
  sidebarSearchInputEl.value = "";
  ensureActiveSelection();
  renderTree();
  if (currentViewKey() !== previousKey) mountActiveFile({ restoreSaved: true });
}

function populateRepositoryFilter() {
  const previous = state.repositoryFilter;
  repositoryFilterEl.replaceChildren();
  const all = makeElement("option", "", "All repositories");
  all.value = "all";
  repositoryFilterEl.appendChild(all);
  state.repositories.forEach((repository) => {
    const detail = repository.workspacePath && repository.workspacePath !== repository.name ? ` — ${repository.workspacePath}` : "";
    const option = makeElement("option", "", `${repository.name}${detail}`);
    option.value = repository.id;
    option.title = repository.workspacePath;
    repositoryFilterEl.appendChild(option);
  });
  state.repositoryFilter = previous === "all" || state.repositoriesById.has(previous) ? previous : "all";
  repositoryFilterEl.value = state.repositoryFilter;
}

function saveActiveViewState() {
  const active = getActiveDetails();
  if (!active || !diffEditor?.saveViewState) return;
  const saved = diffEditor.saveViewState();
  if (!saved) return;
  state.viewStates.set(active.key, {
    repositoryId: active.repository.id,
    contextKey: active.context.key,
    fileId: active.file.id,
    mode: active.context.mode,
    viewState: saved,
  });
}

function firstFileForMode() {
  const repositories = state.repositories.filter((repository) => state.repositoryFilter === "all" || repository.id === state.repositoryFilter);
  for (const repository of repositories) {
    const changeSet = getChangeSet(repository);
    const file = filteredFiles(changeSet)[0];
    if (file) return { repository, changeSet, file };
  }
  return null;
}

function ensureActiveSelection() {
  if (getActiveDetails()) return;
  const first = firstFileForMode();
  state.active = first ? {
    repositoryId: first.repository.id,
    contextKey: first.changeSet.context.key,
    fileId: first.file.id,
  } : null;
}

function activateFile(repositoryId, context, fileId) {
  const key = viewKey(repositoryId, context.key, fileId);
  const previousKey = currentViewKey();
  const same = previousKey === key;
  const load = getLoad(key);
  if (same) {
    if (load?.status === "error") {
      requestFile(key, true);
      mountActiveFile({ preserveCurrent: true });
    }
    updateFileRow(key);
    return;
  }
  if (!same) {
    saveActiveViewState();
    state.active = { repositoryId, contextKey: context.key, fileId };
  }
  requestFile(key, load?.status === "error");
  mountActiveFile({ restoreSaved: true });
  if (previousKey) updateFileRow(previousKey);
  updateFileRow(key);
}

function requestFile(key, force = false) {
  const active = getActiveDetails();
  if (!active || active.key !== key) return;
  const existing = getLoad(key);
  if (!force && existing && existing.status !== "idle") return;
  const requestId = nextRequestId("file");
  state.loads.set(key, {
    status: "loading",
    requestId,
    repositoryId: active.repository.id,
    contextKey: active.context.key,
    fileId: active.file.id,
    mode: active.context.mode,
  });
  updateFileRow(key);
  sendToHost({
    type: "request-file",
    requestId,
    repositoryId: active.repository.id,
    contextKey: active.context.key,
    fileId: active.file.id,
  });
}

function selectMode(mode) {
  if (state.selectedMode === mode) {
    if (mode === "compare" && requestInitialComparisons()) renderTree();
    return;
  }
  saveActiveViewState();
  state.selectedMode = mode;
  state.active = null;
  if (mode === "compare") requestInitialComparisons();
  ensureActiveSelection();
  renderTree();
  mountActiveFile({ restoreSaved: true });
}

function requestInitialComparisons() {
  if (!state.workspaceLoaded || state.initialCompareRequested) return false;
  state.initialCompareRequested = true;
  let requested = false;
  state.repositories.forEach((repository) => {
    if (!repository.baseRef?.trim()) return;
    requested = true;
    requestComparison(repository.id, repository.baseRef, repository.headRef, false);
  });
  return requested;
}

function requestComparison(repositoryId, baseRefValue, headRefValue, renderImmediately = true) {
  const compareState = getCompareState(repositoryId);
  if (!compareState) return;
  const baseRef = String(baseRefValue || "").trim();
  const headRef = String(headRefValue || "").trim();
  compareState.baseInput = baseRef;
  compareState.headInput = headRef;
  if (!baseRef || !headRef) {
    compareState.error = "Both base and head refs are required.";
    if (renderImmediately) renderTree();
    return;
  }
  if (baseRef.startsWith("-") || headRef.startsWith("-") || /[\0\r\n]/.test(baseRef) || /[\0\r\n]/.test(headRef)) {
    compareState.error = "Refs cannot start with a dash or contain line breaks.";
    if (renderImmediately) renderTree();
    return;
  }
  const requestId = nextRequestId("compare");
  state.compareByRepositoryId.set(repositoryId, beginComparison(compareState, requestId, baseRef, headRef));
  if (renderImmediately) renderTree();
  sendToHost({ type: "request-compare", requestId, repositoryId, baseRef, headRef });
}

function hasCompareReviewState(repositoryId) {
  for (const comment of state.comments.values()) {
    if (comment.repositoryId === repositoryId && comment.mode === "compare") return true;
  }
  for (const reviewed of state.reviewed.values()) {
    if (reviewed.repositoryId === repositoryId && reviewed.mode === "compare") return true;
  }
  return false;
}

function clearCompareReviewState(repositoryId) {
  for (const [commentId, comment] of state.comments) {
    if (comment.repositoryId !== repositoryId || comment.mode !== "compare") continue;
    const key = viewKey(comment.repositoryId, comment.contextKey, comment.fileId);
    state.comments.delete(commentId);
    const count = Math.max(0, (state.commentCounts.get(key) || 1) - 1);
    if (count) state.commentCounts.set(key, count);
    else state.commentCounts.delete(key);
  }
  for (const [key, reviewed] of state.reviewed) {
    if (reviewed.repositoryId === repositoryId && reviewed.mode === "compare") state.reviewed.delete(key);
  }
  for (const [key, load] of state.loads) {
    if (load.repositoryId === repositoryId && load.mode === "compare") state.loads.delete(key);
  }
  for (const [key, saved] of state.viewStates) {
    if (saved.repositoryId === repositoryId && saved.mode === "compare") state.viewStates.delete(key);
  }
}

function applyComparison(repositoryId, comparison) {
  const compareState = getCompareState(repositoryId);
  const nextCompareState = acceptComparison(compareState, comparison);
  if (!nextCompareState) return;
  const previousActiveKey = currentViewKey();
  const oldContextKey = compareState.comparison?.changeSet?.context?.key || null;
  const newContextKey = comparison.changeSet.context.key;
  if (oldContextKey && oldContextKey !== newContextKey) clearCompareReviewState(repositoryId);
  state.compareByRepositoryId.set(repositoryId, nextCompareState);
  indexChangeSet(comparison.changeSet);
  if (state.active?.repositoryId === repositoryId && state.active.contextKey !== newContextKey && state.selectedMode === "compare") {
    state.active = null;
  }
  ensureActiveSelection();
  renderTree();
  if (currentViewKey() !== previousActiveKey) mountActiveFile({ restoreSaved: true });
  else {
    updateCurrentFileHeader();
    updateToolbar();
  }
}

function handleCompareData(message) {
  const compareState = receiveComparison(getCompareState(message.repositoryId), message);
  if (!compareState || !message.comparison?.changeSet?.context?.key) return;
  state.compareByRepositoryId.set(message.repositoryId, compareState);
  const previous = compareState.comparison;
  const previousContextKey = previous?.changeSet?.context?.key || null;
  const nextContextKey = message.comparison.changeSet.context.key;
  const pendingReviewTarget = dialogState?.reviewTarget;
  if (
    previousContextKey &&
    previousContextKey !== nextContextKey &&
    pendingReviewTarget?.repositoryId === message.repositoryId &&
    pendingReviewTarget.contextKey === previousContextKey
  ) {
    dialogState.afterClose = () => handleCompareData(message);
    return;
  }
  if (previousContextKey && previousContextKey !== nextContextKey && hasCompareReviewState(message.repositoryId)) {
    openConfirmDialog({
      title: "Replace this comparison?",
      description: "The resolved refs changed. Applying them will clear this repository’s compare comments and reviewed state.",
      saveLabel: "Clear and apply",
      onConfirm: () => {
        if (getCompareState(message.repositoryId)?.latestRequestId === message.requestId) applyComparison(message.repositoryId, message.comparison);
      },
      onCancel: () => {
        const current = getCompareState(message.repositoryId);
        if (!current || current.latestRequestId !== message.requestId) return;
        state.compareByRepositoryId.set(message.repositoryId, restoreComparisonInputs(current, previous));
        renderTree();
      },
    });
    renderTree();
    return;
  }
  applyComparison(message.repositoryId, message.comparison);
}

function handleCompareError(message) {
  const compareState = rejectComparison(getCompareState(message.repositoryId), message);
  if (!compareState) return;
  state.compareByRepositoryId.set(message.repositoryId, compareState);
  renderTree();
}

function handleWorkspaceData(message) {
  saveActiveViewState();
  state.workspaceRoot = message.workspaceRoot || state.workspaceRoot;
  state.warnings = Array.isArray(message.warnings) ? message.warnings : [];
  state.repositories = Array.isArray(message.repositories) ? message.repositories : [];
  state.repositoriesById = new Map(state.repositories.map((repository) => [repository.id, repository]));
  state.compareByRepositoryId = new Map(state.repositories.map((repository) => [repository.id, createCompareState(repository)]));
  state.fileIndexesByContext = new Map();
  state.repositories.forEach((repository) => indexChangeSet(repository.uncommitted));
  state.workspaceLoaded = true;
  workspaceRootEl.textContent = state.workspaceRoot;
  populateRepositoryFilter();
  updateWarnings();
  state.active = null;
  ensureActiveSelection();
  if (state.selectedMode === "compare") requestInitialComparisons();
  renderTree();
  mountActiveFile({ restoreSaved: true });
}

function contentText(content) {
  if (!content || content.kind === "missing") return "";
  if (content.kind === "text" || content.kind === "symlink" || content.kind === "gitlink") return content.text || "";
  if (content.kind === "binary") {
    return content.byteLength == null ? "[Binary content is unavailable]" : `[Binary content is unavailable • ${content.byteLength} bytes]`;
  }
  if (content.kind === "special") return `[Content is unavailable: ${content.message || "special file"}]`;
  return "[Content is unavailable]";
}

function contentSupportsLineComments(content) {
  return content?.kind === "text" || content?.kind === "symlink" || content?.kind === "gitlink";
}

function activeLoadedContents() {
  const key = currentViewKey();
  const load = key ? getLoad(key) : null;
  return load?.status === "ready" ? load.contents : null;
}

function canCommentOnSide(side) {
  const contents = activeLoadedContents();
  return !!contents && contentSupportsLineComments(contents[side]);
}

function mountedContents(active) {
  const load = active ? getLoad(active.key) : null;
  if (!active) return { original: "", modified: "" };
  if (load?.status === "ready") {
    return { original: contentText(load.contents.original), modified: contentText(load.contents.modified) };
  }
  if (load?.status === "error") {
    const text = `Failed to load ${active.file.displayPath}\n\n${load.message}`;
    return { original: text, modified: text };
  }
  const text = `Loading ${active.file.displayPath}…`;
  return { original: text, modified: text };
}

function captureEditorAnchor(editor) {
  if (!editor) return null;
  const firstRange = editor.getVisibleRanges()[0];
  const lineNumber = firstRange?.startLineNumber || editor.getPosition()?.lineNumber || 1;
  return {
    lineNumber,
    pixelDelta: editor.getScrollTop() - editor.getTopForLineNumber(lineNumber),
    scrollLeft: editor.getScrollLeft(),
  };
}

function restoreEditorAnchor(editor, anchor) {
  if (!editor || !anchor) return;
  const lineNumber = Math.min(anchor.lineNumber, editor.getModel()?.getLineCount() || 1);
  editor.setScrollTop(editor.getTopForLineNumber(lineNumber) + anchor.pixelDelta);
  editor.setScrollLeft(anchor.scrollLeft);
}

function captureBothEditorAnchors() {
  if (!diffEditor) return null;
  return {
    original: captureEditorAnchor(diffEditor.getOriginalEditor()),
    modified: captureEditorAnchor(diffEditor.getModifiedEditor()),
  };
}

function restoreBothEditorAnchors(anchors) {
  if (!diffEditor || !anchors) return;
  restoreEditorAnchor(diffEditor.getOriginalEditor(), anchors.original);
  restoreEditorAnchor(diffEditor.getModifiedEditor(), anchors.modified);
}

function applyEditorOptions() {
  if (!diffEditor) return;
  diffEditor.updateOptions({
    renderSideBySide: true,
    diffWordWrap: state.wrapLines ? "on" : "off",
    minimap: {
      enabled: state.minimap,
      renderCharacters: false,
      showSlider: "always",
      size: "proportional",
    },
    hideUnchangedRegions: {
      enabled: state.hideUnchanged,
      contextLineCount: 4,
      minimumLineCount: 2,
      revealLineCount: 12,
    },
  });
  diffEditor.getOriginalEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
  diffEditor.getModifiedEditor().updateOptions({ wordWrap: state.wrapLines ? "on" : "off" });
}

function clearActiveCommentSurfaces() {
  if (diffEditor && activeInlineZones.size) {
    const byEditor = new Map();
    for (const zone of activeInlineZones.values()) {
      const ids = byEditor.get(zone.editor) || [];
      ids.push(zone.zoneId);
      byEditor.set(zone.editor, ids);
    }
    for (const [editor, zoneIds] of byEditor) {
      editor.changeViewZones((accessor) => zoneIds.forEach((zoneId) => accessor.removeZone(zoneId)));
    }
  }
  activeInlineZones = new Map();
  activeFileCommentElements = new Map();
  fileCommentsContainer.replaceChildren();
  fileCommentsContainer.className = "hidden";
  originalDecorations?.set([]);
  modifiedDecorations?.set([]);
  hoverResetters.forEach((reset) => reset());
}

function commentTitle(comment) {
  if (comment.side === "file") return "File comment";
  const side = comment.side === "original" ? "Original" : "Modified";
  return comment.startLine === comment.endLine
    ? `${side} line ${comment.startLine}`
    : `${side} lines ${comment.startLine}–${comment.endLine}`;
}

function createCommentEditor(comment, inline) {
  const container = makeElement("div", inline ? "view-zone-container" : "rounded-lg border border-review-border bg-review-panel p-4");
  container.dataset.commentEditor = comment.id;
  const header = makeElement("div", "mb-2 flex items-center justify-between gap-3");
  const title = makeElement("div", "text-xs font-semibold text-review-text", commentTitle(comment));
  const deleteButton = makeElement("button", "cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-xs font-medium text-review-muted hover:bg-red-500/10 hover:text-red-400", "Delete");
  deleteButton.type = "button";
  deleteButton.setAttribute("aria-label", `Delete ${commentTitle(comment).toLowerCase()}`);
  deleteButton.addEventListener("click", () => deleteComment(comment.id));
  header.append(title, deleteButton);
  const textarea = makeElement("textarea", inline
    ? "scrollbar-thin h-[76px] w-full resize-none overflow-auto rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
    : "scrollbar-thin min-h-[76px] w-full resize-y rounded-md border border-review-border bg-[#010409] px-3 py-2 text-sm text-review-text outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500");
  textarea.value = comment.body || "";
  textarea.placeholder = "Leave a review comment";
  textarea.dataset.commentId = comment.id;
  textarea.dataset.commentInput = "true";
  textarea.setAttribute("aria-label", commentTitle(comment));
  textarea.addEventListener("input", () => { comment.body = textarea.value; });
  container.append(header, textarea);
  return { container, textarea };
}

function addInlineZone(comment, focus = false) {
  if (!diffEditor || activeInlineZones.has(comment.id) || viewKey(comment.repositoryId, comment.contextKey, comment.fileId) !== currentViewKey()) return;
  const editor = comment.side === "original" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
  const anchor = captureEditorAnchor(editor);
  const editorDom = createCommentEditor(comment, true);
  let zoneId = null;
  editor.changeViewZones((accessor) => {
    zoneId = accessor.addZone({
      afterLineNumber: comment.endLine,
      heightInPx: 138,
      domNode: editorDom.container,
    });
  });
  restoreEditorAnchor(editor, anchor);
  activeInlineZones.set(comment.id, { zoneId, editor, element: editorDom.container, textarea: editorDom.textarea });
  if (focus) requestAnimationFrame(() => editorDom.textarea.focus({ preventScroll: true }));
}

function removeInlineZone(commentId) {
  const zone = activeInlineZones.get(commentId);
  if (!zone) return;
  const anchor = captureEditorAnchor(zone.editor);
  zone.editor.changeViewZones((accessor) => accessor.removeZone(zone.zoneId));
  restoreEditorAnchor(zone.editor, anchor);
  activeInlineZones.delete(commentId);
}

function ensureFileCommentsVisibility() {
  fileCommentsContainer.className = activeFileCommentElements.size
    ? "scrollbar-thin max-h-[35vh] space-y-4 overflow-auto border-b border-review-border bg-[#0d1117] px-4 py-4"
    : "hidden";
}

function addFileCommentElement(comment, focus = false) {
  if (activeFileCommentElements.has(comment.id) || viewKey(comment.repositoryId, comment.contextKey, comment.fileId) !== currentViewKey()) return;
  const anchors = captureBothEditorAnchors();
  const editorDom = createCommentEditor(comment, false);
  fileCommentsContainer.appendChild(editorDom.container);
  activeFileCommentElements.set(comment.id, { element: editorDom.container, textarea: editorDom.textarea });
  ensureFileCommentsVisibility();
  requestAnimationFrame(() => {
    restoreBothEditorAnchors(anchors);
    if (focus) editorDom.textarea.focus({ preventScroll: true });
  });
}

function removeFileCommentElement(commentId) {
  const entry = activeFileCommentElements.get(commentId);
  if (!entry) return;
  const anchors = captureBothEditorAnchors();
  entry.element.remove();
  activeFileCommentElements.delete(commentId);
  ensureFileCommentsVisibility();
  requestAnimationFrame(() => restoreBothEditorAnchors(anchors));
}

function refreshActiveDecorations() {
  if (!monacoApi || !originalDecorations || !modifiedDecorations) return;
  const original = [];
  const modified = [];
  for (const comment of activeComments()) {
    if (comment.side === "file") continue;
    const decoration = {
      range: new monacoApi.Range(comment.startLine, 1, comment.endLine, 1),
      options: {
        isWholeLine: true,
        className: comment.side === "original" ? "review-comment-line-original" : "review-comment-line-modified",
        glyphMarginClassName: comment.side === "original" ? "review-comment-glyph-original" : "review-comment-glyph-modified",
      },
    };
    if (comment.side === "original") original.push(decoration);
    else modified.push(decoration);
  }
  originalDecorations.set(original);
  modifiedDecorations.set(modified);
}

function mountActiveCommentSurfaces() {
  for (const comment of activeComments()) {
    if (comment.side === "file") addFileCommentElement(comment);
    else addInlineZone(comment);
  }
  refreshActiveDecorations();
}

function mountActiveFile(options = {}) {
  updateCurrentFileHeader();
  updateToolbar();
  if (!diffEditor || !originalModel || !modifiedModel) return;
  const active = getActiveDetails();
  if (active && getLoad(active.key)?.status === "idle") requestFile(active.key);
  const nextKey = active?.key || null;
  const currentState = options.preserveCurrent ? diffEditor.saveViewState?.() : null;
  const savedState = options.restoreSaved && nextKey ? state.viewStates.get(nextKey)?.viewState : null;
  const restoreState = currentState || savedState || null;
  const contents = mountedContents(active);
  const loaded = activeLoadedContents();
  const originalNextLanguage = active && loaded?.original?.kind === "text"
    ? inferLanguage(active.file.oldPath || getFilePath(active.file))
    : "plaintext";
  const modifiedNextLanguage = active && loaded?.modified?.kind === "text"
    ? inferLanguage(active.file.newPath || getFilePath(active.file))
    : "plaintext";
  clearActiveCommentSurfaces();
  if (originalLanguage !== originalNextLanguage) {
    monacoApi.editor.setModelLanguage(originalModel, originalNextLanguage);
    originalLanguage = originalNextLanguage;
  }
  if (modifiedLanguage !== modifiedNextLanguage) {
    monacoApi.editor.setModelLanguage(modifiedModel, modifiedNextLanguage);
    modifiedLanguage = modifiedNextLanguage;
  }
  if (originalModel.getValue() !== contents.original) originalModel.setValue(contents.original);
  if (modifiedModel.getValue() !== contents.modified) modifiedModel.setValue(contents.modified);
  mountedViewKey = nextKey;
  applyEditorOptions();
  mountActiveCommentSurfaces();
  pendingViewRestore = restoreState && nextKey ? { key: nextKey, viewState: restoreState } : null;
  const restore = () => {
    if (pendingViewRestore?.key === mountedViewKey) diffEditor.restoreViewState(pendingViewRestore.viewState);
    else if (!restoreState) {
      diffEditor.getOriginalEditor().setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
      diffEditor.getModifiedEditor().setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
    }
  };
  requestAnimationFrame(restore);
}

function addComment(comment, focus = true) {
  state.comments.set(comment.id, comment);
  const key = viewKey(comment.repositoryId, comment.contextKey, comment.fileId);
  state.commentCounts.set(key, (state.commentCounts.get(key) || 0) + 1);
  if (comment.side === "file") addFileCommentElement(comment, focus);
  else addInlineZone(comment, focus);
  refreshActiveDecorations();
  updateFileRow(key);
  updateSummary();
}

function deleteComment(commentId) {
  const comment = state.comments.get(commentId);
  if (!comment) return;
  const key = viewKey(comment.repositoryId, comment.contextKey, comment.fileId);
  if (comment.side === "file") removeFileCommentElement(commentId);
  else removeInlineZone(commentId);
  state.comments.delete(commentId);
  const count = Math.max(0, (state.commentCounts.get(key) || 1) - 1);
  if (count) state.commentCounts.set(key, count);
  else state.commentCounts.delete(key);
  refreshActiveDecorations();
  updateFileRow(key);
  updateSummary();
}

function selectionLines(editor, clickedLine = null) {
  const selection = editor.getSelection();
  if (selection && !selection.isEmpty()) {
    const startLine = Math.min(selection.startLineNumber, selection.endLineNumber);
    let endLine = Math.max(selection.startLineNumber, selection.endLineNumber);
    if (selection.endColumn === 1 && endLine > startLine) endLine -= 1;
    if (clickedLine == null || (clickedLine >= startLine && clickedLine <= endLine)) return { startLine, endLine };
  }
  const line = clickedLine || editor.getPosition()?.lineNumber || 1;
  return { startLine: line, endLine: line };
}

function addInlineComment(side, editor, clickedLine = null) {
  const active = getActiveDetails();
  if (!active || !canCommentOnSide(side)) return;
  const lines = selectionLines(editor, clickedLine);
  addComment({
    id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
    repositoryId: active.repository.id,
    contextKey: active.context.key,
    fileId: active.file.id,
    mode: active.context.mode,
    side,
    startLine: lines.startLine,
    endLine: lines.endLine,
    body: "",
  });
}

function installEditorCommentActions(editor, side, hoverCollection) {
  let hoveredLine = null;
  hoverResetters.push(() => {
    hoveredLine = null;
    hoverCollection.set([]);
  });
  editor.onMouseMove((event) => {
    const target = event.target;
    const inGutter = target.type === monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
    const line = inGutter && canCommentOnSide(side) ? target.position?.lineNumber || null : null;
    if (line === hoveredLine) return;
    hoveredLine = line;
    hoverCollection.set(line ? [{
      range: new monacoApi.Range(line, 1, line, 1),
      options: { glyphMarginClassName: "review-glyph-plus" },
    }] : []);
  });
  editor.onMouseLeave(() => {
    hoveredLine = null;
    hoverCollection.set([]);
  });
  editor.onMouseDown((event) => {
    const target = event.target;
    if (target.type !== monacoApi.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && target.type !== monacoApi.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
    const line = target.position?.lineNumber;
    if (line) addInlineComment(side, editor, line);
  });
  editor.addAction({
    id: `add-review-comment-${side}`,
    label: "Add review comment",
    keybindings: [monacoApi.KeyMod.CtrlCmd | monacoApi.KeyMod.Shift | monacoApi.KeyCode.KeyM],
    contextMenuGroupId: "review",
    contextMenuOrder: 1,
    run: () => addInlineComment(side, editor),
  });
}

function setupMonaco() {
  if (!window.require?.config) {
    showFatalError("Monaco loader did not initialize.");
    return;
  }
  window.require.config({ paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.56.0/min/vs" } });
  window.require(["vs/editor/editor.main"], () => {
    monacoApi = window.monaco;
    monacoApi.editor.defineTheme("review-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d1117",
        "diffEditor.insertedTextBackground": "#2ea04326",
        "diffEditor.removedTextBackground": "#f8514926",
      },
    });
    monacoApi.editor.setTheme("review-dark");
    originalModel = monacoApi.editor.createModel("", "plaintext");
    modifiedModel = monacoApi.editor.createModel("", "plaintext");
    diffEditor = monacoApi.editor.createDiffEditor(editorContainerEl, {
      automaticLayout: true,
      renderSideBySide: true,
      readOnly: true,
      originalEditable: false,
      minimap: { enabled: true, renderCharacters: false, showSlider: "always", size: "proportional" },
      renderOverviewRuler: true,
      diffWordWrap: "on",
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 4,
      glyphMargin: true,
      folding: true,
      lineDecorationsWidth: 10,
      overviewRulerBorder: false,
      wordWrap: "on",
      ariaLabel: "Code comparison",
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    const originalEditor = diffEditor.getOriginalEditor();
    const modifiedEditor = diffEditor.getModifiedEditor();
    originalEditor.updateOptions({ ariaLabel: "Original file" });
    modifiedEditor.updateOptions({ ariaLabel: "Modified file" });
    originalDecorations = originalEditor.createDecorationsCollection();
    modifiedDecorations = modifiedEditor.createDecorationsCollection();
    originalHoverDecorations = originalEditor.createDecorationsCollection();
    modifiedHoverDecorations = modifiedEditor.createDecorationsCollection();
    installEditorCommentActions(originalEditor, "original", originalHoverDecorations);
    installEditorCommentActions(modifiedEditor, "modified", modifiedHoverDecorations);
    diffEditor.onDidUpdateDiff(() => {
      if (pendingViewRestore?.key !== mountedViewKey) return;
      diffEditor.restoreViewState(pendingViewRestore.viewState);
      pendingViewRestore = null;
    });
    mountActiveFile({ restoreSaved: true });
  }, (error) => showFatalError(`Monaco failed to initialize.\n\n${error?.message || String(error)}`));
}

function openDialog(options) {
  if (reviewDialogEl.open || dialogState) {
    dialogQueue.push(options);
    return;
  }
  const returnFocus = document.activeElement;
  dialogState = {
    onSave: options.onSave || null,
    onCancel: options.onCancel || null,
    returnFocus,
    returnFocusKey: returnFocus?.dataset?.focusKey || null,
    returnViewKey: currentViewKey(),
    confirm: options.confirm === true,
    reviewTarget: options.reviewTarget || null,
    afterClose: null,
  };
  reviewDialogTitleEl.textContent = options.title;
  reviewDialogDescriptionEl.textContent = options.description || "";
  reviewDialogSaveEl.textContent = options.saveLabel || "Save";
  reviewDialogTextEl.value = options.initialValue || "";
  reviewDialogTextEl.hidden = options.confirm === true;
  reviewDialogTextLabelEl.hidden = options.confirm === true;
  reviewDialogEl.showModal();
  if (options.confirm) reviewDialogSaveEl.focus();
  else reviewDialogTextEl.focus();
}

function restoreDialogFocus(dialog) {
  if (dialog.returnFocus?.isConnected) {
    dialog.returnFocus.focus({ preventScroll: true });
    return;
  }
  const treeTarget = findTreeFocusTarget(dialog.returnFocusKey);
  if (treeTarget) {
    treeTarget.focus({ preventScroll: true });
    return;
  }
  const activeRow = state.treeRowsByViewKey.get(dialog.returnViewKey)?.[0]?.button;
  if (activeRow?.isConnected) {
    activeRow.focus({ preventScroll: true });
    return;
  }
  if (getActiveDetails() && diffEditor) {
    diffEditor.getModifiedEditor().focus();
    return;
  }
  toggleSidebarButton.focus({ preventScroll: true });
}

function closeDialog(save) {
  if (!dialogState) return;
  const current = dialogState;
  const value = reviewDialogTextEl.value.trim();
  dialogState = null;
  reviewDialogEl.close();
  if (save) current.onSave?.(value);
  else current.onCancel?.();
  restoreDialogFocus(current);
  queueMicrotask(() => {
    current.afterClose?.();
    const next = dialogQueue.shift();
    if (next) openDialog(next);
  });
}

function openConfirmDialog(options) {
  openDialog({
    title: options.title,
    description: options.description,
    saveLabel: options.saveLabel,
    confirm: true,
    onSave: options.onConfirm,
    onCancel: options.onCancel,
  });
}

function openOverallCommentDialog() {
  openDialog({
    title: "Overall review note",
    description: "This note is included before file and line comments.",
    initialValue: state.overallComment,
    saveLabel: "Save note",
    onSave: (value) => {
      state.overallComment = value;
      updateSummary();
    },
  });
}

function openFileCommentDialog() {
  const active = getActiveDetails();
  if (!active) return;
  openDialog({
    title: `File comment for ${active.file.displayPath}`,
    description: `Applies to this file in ${active.context.mode === "compare" ? "Compare" : "Uncommitted"}.`,
    initialValue: "",
    saveLabel: "Add comment",
    reviewTarget: {
      repositoryId: active.repository.id,
      contextKey: active.context.key,
    },
    onSave: (value) => {
      if (!value) return;
      addComment({
        id: `${Date.now()}:${Math.random().toString(16).slice(2)}`,
        repositoryId: active.repository.id,
        contextKey: active.context.key,
        fileId: active.file.id,
        mode: active.context.mode,
        side: "file",
        startLine: null,
        endLine: null,
        body: value,
      });
    },
  });
}

function syncCommentBodiesFromDOM() {
  document.querySelectorAll("textarea[data-comment-id]").forEach((textarea) => {
    const comment = state.comments.get(textarea.dataset.commentId);
    if (comment) comment.body = textarea.value;
  });
}

function toggleReviewed() {
  const active = getActiveDetails();
  if (!active) return;
  if (state.reviewed.has(active.key)) state.reviewed.delete(active.key);
  else state.reviewed.set(active.key, {
    repositoryId: active.repository.id,
    contextKey: active.context.key,
    fileId: active.file.id,
    mode: active.context.mode,
  });
  updateFileRow(active.key);
  updateToolbar();
}

function handleFileData(message) {
  const key = viewKey(message.repositoryId, message.contextKey, message.fileId);
  const load = settleFileLoad(getLoad(key), message, "ready");
  if (!load) return;
  state.loads.set(key, load);
  updateFileRow(key);
  if (currentViewKey() === key) mountActiveFile({ preserveCurrent: true });
}

function handleFileError(message) {
  const key = viewKey(message.repositoryId, message.contextKey, message.fileId);
  const load = settleFileLoad(getLoad(key), message, "error");
  if (!load) return;
  state.loads.set(key, load);
  updateFileRow(key);
  if (currentViewKey() === key) mountActiveFile({ preserveCurrent: true });
}

window.__reviewReceive = function (message) {
  try {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "workspace-data":
        handleWorkspaceData(message);
        break;
      case "compare-data":
        handleCompareData(message);
        break;
      case "compare-error":
        handleCompareError(message);
        break;
      case "file-data":
        handleFileData(message);
        break;
      case "file-error":
        handleFileError(message);
        break;
    }
  } catch (error) {
    showFatalError(error instanceof Error ? error.stack || error.message : String(error));
  }
};

submitButton.addEventListener("click", () => {
  syncCommentBodiesFromDOM();
  sendTerminalMessage({
    type: "submit",
    overallComment: state.overallComment.trim(),
    comments: [...state.comments.values()]
      .map((comment) => ({ ...comment, body: comment.body.trim() }))
      .filter((comment) => comment.body.length > 0),
  });
});

cancelButton.addEventListener("click", () => sendTerminalMessage({ type: "cancel" }));
fatalCancelButton.addEventListener("click", () => sendTerminalMessage({ type: "cancel" }));
overallCommentButton.addEventListener("click", openOverallCommentDialog);
fileCommentButton.addEventListener("click", openFileCommentDialog);
toggleReviewedButton.addEventListener("click", toggleReviewed);
tabUncommittedButton.addEventListener("click", () => selectMode("uncommitted"));
tabCompareButton.addEventListener("click", () => selectMode("compare"));

toggleWrapButton.addEventListener("click", () => {
  const anchors = captureBothEditorAnchors();
  state.wrapLines = !state.wrapLines;
  applyEditorOptions();
  updateToolbar();
  requestAnimationFrame(() => restoreBothEditorAnchors(anchors));
});

toggleMinimapButton.addEventListener("click", () => {
  const anchors = captureBothEditorAnchors();
  state.minimap = !state.minimap;
  applyEditorOptions();
  updateToolbar();
  requestAnimationFrame(() => restoreBothEditorAnchors(anchors));
});

toggleUnchangedButton.addEventListener("click", () => {
  const anchors = captureBothEditorAnchors();
  state.hideUnchanged = !state.hideUnchanged;
  applyEditorOptions();
  updateToolbar();
  requestAnimationFrame(() => restoreBothEditorAnchors(anchors));
});

toggleSidebarButton.addEventListener("click", () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  const width = state.sidebarCollapsed ? "0px" : "304px";
  sidebarEl.style.width = width;
  sidebarEl.style.minWidth = width;
  sidebarEl.style.flexBasis = width;
  sidebarEl.style.borderRightWidth = state.sidebarCollapsed ? "0px" : "1px";
  sidebarEl.inert = state.sidebarCollapsed;
  sidebarEl.setAttribute("aria-hidden", String(state.sidebarCollapsed));
  toggleSidebarButton.textContent = state.sidebarCollapsed ? "Show sidebar" : "Hide sidebar";
  toggleSidebarButton.setAttribute("aria-expanded", String(!state.sidebarCollapsed));
});

sidebarEl.addEventListener("transitionend", (event) => {
  if (event.propertyName === "width") diffEditor?.layout();
});

repositoryFilterEl.addEventListener("change", () => {
  saveActiveViewState();
  state.repositoryFilter = repositoryFilterEl.value || "all";
  state.active = null;
  ensureActiveSelection();
  renderTree();
  mountActiveFile({ restoreSaved: true });
});

sidebarSearchInputEl.addEventListener("input", () => {
  state.fileFilter = sidebarSearchInputEl.value;
  scheduleTreeRender();
});

sidebarSearchInputEl.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  clearFileFilter();
});

reviewDialogFormEl.addEventListener("submit", (event) => {
  event.preventDefault();
  closeDialog(true);
});
reviewDialogCancelEl.addEventListener("click", () => closeDialog(false));
reviewDialogEl.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || state.terminalMessageSent) return;
  if (reviewDialogEl.open) return;
  const activeElement = document.activeElement;
  if (activeElement === sidebarSearchInputEl) {
    event.preventDefault();
    event.stopPropagation();
    clearFileFilter();
    return;
  }
  const commentEditor = activeElement?.closest?.("[data-comment-editor]");
  if (commentEditor) {
    event.preventDefault();
    event.stopPropagation();
    if (activeElement?.dataset?.commentInput === "true") activeElement.blur();
    else commentEditor.querySelector("textarea")?.focus({ preventScroll: true });
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  sendTerminalMessage({ type: "cancel" });
}, true);

window.addEventListener("error", (event) => {
  if (event.message === "Script error." && !event.filename && event.error == null) return;
  if (!event.message) return;
  showFatalError(event.error instanceof Error ? event.error.stack || event.error.message : event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  showFatalError(event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason));
});

updateTabs();
updateToolbar();
updateSummary();
renderTree();

if (window.__reviewAssetErrors?.length) showFatalError(window.__reviewAssetErrors.join("\n"));
else setupMonaco();

sendToHost({ type: "ready" });
