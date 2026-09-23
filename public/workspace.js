import { saveImagesToSelectedDirectory } from "./downloadFolder.js";
import { groupDownloadRowsByBatch } from "./uploadBatches.js";
import {
  SHARED_CONCURRENCY_EVENT,
  SHARED_CONCURRENCY_KEY,
  readSharedConcurrency,
  writeSharedConcurrency,
} from "./sharedConcurrency.js";
import {
  SHARED_API_KEY_KEY,
  readSharedApiKey,
  writeSharedApiKey,
} from "./sharedApiKey.js";

const SECTION_ORDER = ["main", "creation", "custom", "converter", "history"];
const SOURCE_ORDER = ["main", "creation", "custom", "converter"];
const QUEUE_ROW_HEIGHT = 77;
const HISTORY_UPDATE_KEY = "sence-image-history-update-v1";
const STATUS_TEXT = {
  pending: "等待",
  paused: "暂停",
  queued: "队列中",
  running: "生成中",
  done: "已完成",
  error: "失败",
};

const els = {
  nav: document.querySelector("#workspaceNav"),
  main: document.querySelector("#workspaceMainFeature"),
  frames: new Map(SECTION_ORDER.slice(1).map((section) => [
    section,
    document.querySelector(`[data-workspace-frame="${section}"]`),
  ])),
  list: document.querySelector("#workspaceQueueList"),
  count: document.querySelector("#workspaceQueueCount"),
  summary: document.querySelector("#workspaceQueueSummary"),
  queueView: document.querySelector("#workspaceSharedQueueView"),
  completedView: document.querySelector("#workspaceSharedCompletedView"),
  queueViewCount: document.querySelector("#workspaceSharedQueueCount"),
  completedViewCount: document.querySelector("#workspaceSharedCompletedCount"),
  apiKey: document.querySelector("#workspaceApiKeyInput"),
  concurrency: document.querySelector("#workspaceConcurrencyInput"),
  concurrencyApply: document.querySelector("#workspaceConcurrencyApply"),
  startQueue: document.querySelector("#workspaceStartQueue"),
  pauseQueue: document.querySelector("#workspacePauseQueue"),
  downloadPng: document.querySelector("#workspaceDownloadPng"),
  exportWebp: document.querySelector("#workspaceExportWebp"),
  previous: document.querySelector("#workspaceQueuePrevious"),
  next: document.querySelector("#workspaceQueueNext"),
  page: document.querySelector("#workspaceQueuePage"),
  status: document.querySelector("#workspaceQueueStatus"),
  preview: document.querySelector("#workspacePreviewDialog"),
  previewTitle: document.querySelector("#workspacePreviewTitle"),
  previewImage: document.querySelector("#workspacePreviewImage"),
  previewClose: document.querySelector("#workspacePreviewClose"),
  batchDownloadDialog: document.querySelector("#workspaceBatchDownloadDialog"),
  batchDownloadTitle: document.querySelector("#workspaceBatchDownloadTitle"),
  batchDownloadList: document.querySelector("#workspaceBatchDownloadList"),
  batchDownloadStatus: document.querySelector("#workspaceBatchDownloadStatus"),
  batchDownloadClose: document.querySelector("#workspaceBatchDownloadClose"),
  batchDownloadCancel: document.querySelector("#workspaceBatchDownloadCancel"),
  batchDownloadConfirm: document.querySelector("#workspaceBatchDownloadConfirm"),
};

let activeSection = normalizeSection(location.hash.slice(1));
let activeQueueView = "queue";
let currentPage = 1;
let pageSize = 8;
let renderScheduled = false;
let previousCompletedCount = 0;
let pendingBatchExport = null;

els.nav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-workspace-target]");
  if (!button) return;
  activateSection(button.dataset.workspaceTarget);
});
window.addEventListener("hashchange", () => activateSection(location.hash.slice(1), false));
window.addEventListener("message", (event) => {
  if (event.origin === location.origin && event.data?.type === "workspace:queue-changed") scheduleRender();
});
els.downloadPng.addEventListener("click", () => exportSelected({
  format: "png",
  label: "PNG",
  convertImageDataUrl: (dataUrl) => convertImage(dataUrl, "image/png"),
}));
els.exportWebp.addEventListener("click", () => exportSelected({
  format: "webp",
  label: "WebP",
  convertImageDataUrl: (dataUrl) => convertImage(dataUrl, "image/webp", 0.9),
}));
els.concurrencyApply.addEventListener("click", () => {
  void updateSharedConcurrency(els.concurrency.value);
});
els.startQueue.addEventListener("click", () => {
  void startSharedQueue();
});
els.pauseQueue.addEventListener("click", () => {
  void toggleSharedQueuePause();
});
els.apiKey.addEventListener("input", () => {
  writeSharedApiKey(els.apiKey.value);
});
els.queueView.addEventListener("click", () => setQueueView("queue"));
els.completedView.addEventListener("click", () => setQueueView("completed"));
window.addEventListener("storage", (event) => {
  if (event.key === SHARED_CONCURRENCY_KEY) {
    els.concurrency.value = String(readSharedConcurrency());
  }
  if (event.key === SHARED_API_KEY_KEY && document.activeElement !== els.apiKey) {
    els.apiKey.value = readSharedApiKey();
  }
});
els.previous.addEventListener("click", () => {
  currentPage -= 1;
  renderQueue();
});
els.next.addEventListener("click", () => {
  currentPage += 1;
  renderQueue();
});
els.previewClose.addEventListener("click", () => els.preview.close());
els.preview.addEventListener("click", (event) => {
  if (event.target === els.preview) els.preview.close();
});
els.batchDownloadClose.addEventListener("click", () => els.batchDownloadDialog.close());
els.batchDownloadCancel.addEventListener("click", () => els.batchDownloadDialog.close());
els.batchDownloadDialog.addEventListener("click", (event) => {
  if (event.target === els.batchDownloadDialog) els.batchDownloadDialog.close();
});
els.batchDownloadConfirm.addEventListener("click", () => void confirmBatchExport());

for (const frame of els.frames.values()) frame.addEventListener("load", scheduleRender);
new ResizeObserver(updatePageSize).observe(els.list);

activateSection(activeSection, false);
els.apiKey.value = readSharedApiKey();
els.concurrency.value = String(readSharedConcurrency());
void refreshSharedConcurrency();
scheduleRender();
setInterval(() => {
  scheduleRender();
  if (allTasks().some((task) => ["pending", "queued", "running"].includes(task.status))) {
    void refreshSharedConcurrency();
  }
}, 3000);

function normalizeSection(section) {
  return SECTION_ORDER.includes(section) ? section : "main";
}

function activateSection(section, updateHash = true) {
  activeSection = normalizeSection(section);
  els.main.hidden = activeSection !== "main";
  for (const [name, frame] of els.frames) {
    frame.hidden = name !== activeSection;
  }
  for (const button of els.nav.querySelectorAll("[data-workspace-target]")) {
    const selected = button.dataset.workspaceTarget === activeSection;
    button.setAttribute("aria-current", selected ? "page" : "false");
  }
  if (updateHash && location.hash !== `#${activeSection}`) history.replaceState(null, "", `#${activeSection}`);
}

function sourceApis() {
  const apis = [];
  if (window.workspaceQueueApi) apis.push(window.workspaceQueueApi);
  for (const source of SOURCE_ORDER.slice(1)) {
    const api = els.frames.get(source)?.contentWindow?.workspaceQueueApi;
    if (api) apis.push(api);
  }
  return apis;
}

function allTasks() {
  return sourceApis().flatMap((api) => api.getTasks());
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderQueue();
  });
}

function renderQueue() {
  const tasks = allTasks();
  const queueTasks = tasks.filter((task) => task.status !== "done");
  const completedTasks = tasks.filter((task) => task.status === "done");
  const visibleTasks = activeQueueView === "completed" ? completedTasks : queueTasks;
  const totalPages = Math.max(1, Math.ceil(visibleTasks.length / pageSize));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const pageTasks = visibleTasks.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const completed = completedTasks.length;
  const selected = tasks.filter((task) => task.selectable && task.selected).length;

  if (completed > previousCompletedCount) notifyHistoryUpdated();
  previousCompletedCount = completed;

  els.list.replaceChildren();
  if (!pageTasks.length) {
    const empty = document.createElement("div");
    empty.className = "workspace-queue-empty";
    empty.textContent = "暂无任务";
    els.list.append(empty);
  } else {
    pageTasks.forEach((task) => els.list.append(renderTask(task)));
  }

  els.count.textContent = String(tasks.length);
  els.queueViewCount.textContent = String(queueTasks.length);
  els.completedViewCount.textContent = String(completed);
  els.queueView.setAttribute("aria-selected", activeQueueView === "queue" ? "true" : "false");
  els.completedView.setAttribute("aria-selected", activeQueueView === "completed" ? "true" : "false");
  els.summary.textContent = `${completed} 已完成 · ${selected} 已选`;
  els.downloadPng.disabled = completed === 0;
  els.exportWebp.disabled = completed === 0;
  const waitingSources = sourceApis().filter((api) => api.getTasks().some((task) => task.status === "pending"));
  els.startQueue.disabled = waitingSources.length === 0;
  const activeSources = sourceApis()
    .map((api) => ({ api, state: api.getPauseState?.() || {} }))
    .filter(({ state }) => state.active);
  const allPaused = activeSources.length > 0 && activeSources.every(({ state }) => state.paused);
  const transitioning = activeSources.some(({ state }) => state.transitioning);
  els.pauseQueue.disabled = !activeSources.length || transitioning;
  els.pauseQueue.textContent = transitioning ? "处理中" : allPaused ? "继续队列" : "暂停队列";
  els.previous.disabled = currentPage <= 1;
  els.next.disabled = currentPage >= totalPages;
  els.page.textContent = `${currentPage} / ${totalPages}`;
}

function notifyHistoryUpdated() {
  localStorage.setItem(HISTORY_UPDATE_KEY, String(Date.now()));
  els.frames.get("history")?.contentWindow?.postMessage(
    { type: "workspace:history-updated" },
    location.origin,
  );
}

async function startSharedQueue() {
  const waitingSources = sourceApis().filter((api) => api.getTasks().some((task) => task.status === "pending"));
  if (!waitingSources.length) return;
  els.startQueue.disabled = true;
  els.startQueue.textContent = "提交中";
  try {
    const results = await Promise.all(waitingSources.map((api) => api.startQueuedTasks()));
    const started = results.filter(Boolean).length;
    setQueueStatus(started ? `已开始 ${started} 个任务源` : "没有可开始的任务");
  } catch (error) {
    setQueueStatus(error?.message || "开始生成失败");
  } finally {
    els.startQueue.textContent = "开始生成";
    scheduleRender();
  }
}

async function toggleSharedQueuePause() {
  const activeSources = sourceApis()
    .map((api) => ({ api, state: api.getPauseState?.() || {} }))
    .filter(({ state }) => state.active && !state.transitioning);
  if (!activeSources.length) return;
  const action = activeSources.every(({ state }) => state.paused) ? "resume" : "pause";
  els.pauseQueue.disabled = true;
  els.pauseQueue.textContent = "处理中";
  try {
    const results = await Promise.all(activeSources.map(({ api }) => api.togglePause(action)));
    const failed = results.filter((result) => result === false).length;
    setQueueStatus(failed ? `${failed} 个任务源未能${action === "pause" ? "暂停" : "继续"}` : action === "pause" ? "已暂停等待中的任务" : "已继续等待中的任务");
  } catch (error) {
    setQueueStatus(error?.message || "队列控制失败");
  } finally {
    scheduleRender();
  }
}

function setQueueView(view) {
  if (view === activeQueueView) return;
  activeQueueView = view;
  currentPage = 1;
  renderQueue();
}

function updatePageSize() {
  const nextSize = Math.max(1, Math.floor(els.list.clientHeight / QUEUE_ROW_HEIGHT));
  if (nextSize === pageSize) return;
  pageSize = nextSize;
  renderQueue();
}

function renderTask(task) {
  const row = document.createElement("article");
  row.className = `workspace-queue-row ${task.status}`;

  const preview = document.createElement("button");
  preview.className = "workspace-queue-thumb";
  preview.type = "button";
  preview.disabled = !task.imageSrc;
  if (task.imageSrc) {
    const image = document.createElement("img");
    image.src = task.imageSrc;
    image.alt = task.outputName;
    preview.append(image);
    preview.addEventListener("click", () => openPreview(task));
  }

  const content = document.createElement("div");
  content.className = "workspace-queue-main";
  const source = document.createElement("span");
  source.className = "workspace-queue-source";
  source.textContent = task.label;
  const title = document.createElement("strong");
  title.textContent = task.outputName;
  const detail = document.createElement("span");
  detail.className = "workspace-queue-detail";
  detail.textContent = task.detail || STATUS_TEXT[task.status] || task.status;
  content.append(source, title, detail);

  const status = document.createElement("span");
  status.className = `workspace-queue-status ${task.status}`;
  status.textContent = STATUS_TEXT[task.status] || task.status;

  const remove = document.createElement("button");
  remove.className = "icon-button workspace-queue-delete";
  remove.type = "button";
  remove.textContent = "×";
  remove.title = "删除";
  remove.setAttribute("aria-label", `删除 ${task.outputName}`);
  remove.hidden = !task.removable;
  remove.addEventListener("click", () => {
    const api = sourceApis().find((candidate) => candidate.source === task.source);
    if (api?.removeTask(task.key)) scheduleRender();
  });

  const select = document.createElement("input");
  select.type = "checkbox";
  select.checked = task.selected;
  select.disabled = !task.selectable;
  select.setAttribute("aria-label", `选择 ${task.outputName}`);
  select.addEventListener("change", () => {
    const api = sourceApis().find((candidate) => candidate.source === task.source);
    api?.setSelected(task.key, select.checked);
    scheduleRender();
  });

  row.append(preview, content, status, remove, select);
  return row;
}

function openPreview(task) {
  els.previewTitle.textContent = task.outputName;
  els.previewImage.src = task.imageSrc;
  els.preview.showModal();
}

async function exportSelected({ format, label, convertImageDataUrl }) {
  const rows = allResults();
  if (!rows.length) return setQueueStatus("暂无已完成图片");
  const groups = groupDownloadRowsByBatch(rows);
  const selectedResults = sourceApis().flatMap((api) => api.getSelectedResults?.() || []);
  const selectedKeys = new Set(selectedResults.map(resultKey));
  const selectedBatchIds = groups
    .filter((group) => group.rows.some((row) => selectedKeys.has(resultKey(row))))
    .map((group) => group.id);
  pendingBatchExport = {
    format,
    label,
    convertImageDataUrl,
    groups,
    selectedBatchIds: new Set(selectedBatchIds.length ? selectedBatchIds : groups.map((group) => group.id)),
  };
  renderBatchDownloadDialog();
  els.batchDownloadDialog.showModal();
}

function allResults() {
  return sourceApis().flatMap((api) => api.getResults?.() || api.getSelectedResults?.() || []);
}

function resultKey(row) {
  return `${row.outputName || ""}\u0000${row.imageDataUrl || ""}`;
}

function renderBatchDownloadDialog() {
  if (!pendingBatchExport) return;
  els.batchDownloadTitle.textContent = `选择 ${pendingBatchExport.label} 批次`;
  els.batchDownloadStatus.textContent = "";
  els.batchDownloadList.replaceChildren();
  for (const group of pendingBatchExport.groups) {
    const label = document.createElement("label");
    label.className = "batch-download-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = pendingBatchExport.selectedBatchIds.has(group.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) pendingBatchExport.selectedBatchIds.add(group.id);
      else pendingBatchExport.selectedBatchIds.delete(group.id);
      updateBatchDownloadConfirm();
    });
    const text = document.createElement("span");
    text.textContent = group.label;
    const count = document.createElement("small");
    count.textContent = `${group.rows.length} 张`;
    label.append(checkbox, text, count);
    els.batchDownloadList.append(label);
  }
  updateBatchDownloadConfirm();
}

function updateBatchDownloadConfirm() {
  const selectedCount = pendingBatchExport?.selectedBatchIds.size || 0;
  els.batchDownloadConfirm.disabled = selectedCount === 0;
  els.batchDownloadConfirm.textContent = selectedCount ? `选择文件夹并保存 (${selectedCount})` : "选择文件夹并保存";
}

async function confirmBatchExport() {
  if (!pendingBatchExport) return;
  const { format, label, convertImageDataUrl, groups, selectedBatchIds } = pendingBatchExport;
  const rows = groups
    .filter((group) => selectedBatchIds.has(group.id))
    .flatMap((group) => group.rows);
  if (!rows.length) return;
  els.batchDownloadConfirm.disabled = true;
  els.batchDownloadConfirm.textContent = "保存中";
  try {
    const { saved } = await saveImagesToSelectedDirectory(rows, {
      format,
      convertImageDataUrl,
    });
    setQueueStatus(`已保存 ${saved} 张 ${label}`);
    els.batchDownloadDialog.close();
  } catch (error) {
    if (error?.name === "AbortError") {
      setQueueStatus("已取消选择文件夹");
      els.batchDownloadDialog.close();
    } else {
      els.batchDownloadStatus.textContent = error?.message || "保存失败";
      setQueueStatus(error?.message || "保存失败");
    }
  } finally {
    if (pendingBatchExport) updateBatchDownloadConfirm();
  }
}

function setQueueStatus(text) {
  els.status.textContent = text;
}

async function updateSharedConcurrency(value) {
  const previous = readSharedConcurrency();
  const concurrency = writeSharedConcurrency(value);
  els.concurrency.value = String(concurrency);
  els.concurrency.disabled = true;
  els.concurrencyApply.disabled = true;
  try {
    const response = await fetch("/api/generation-concurrency", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ concurrency }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "并发设置失败");
    const applied = writeSharedConcurrency(data.concurrency);
    els.concurrency.value = String(applied);
    window.dispatchEvent(new CustomEvent(SHARED_CONCURRENCY_EVENT, {
      detail: { concurrency: applied },
    }));
    setQueueStatus(`最大并发数已设为 ${applied}`);
  } catch (error) {
    writeSharedConcurrency(previous);
    els.concurrency.value = String(previous);
    setQueueStatus(error?.message || "并发设置失败");
  } finally {
    els.concurrency.disabled = false;
    els.concurrencyApply.disabled = false;
  }
}

async function refreshSharedConcurrency() {
  if (document.activeElement === els.concurrency) return;
  try {
    const response = await fetch("/api/generation-concurrency");
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Number.isFinite(Number(data.concurrency))) return;
    const applied = writeSharedConcurrency(data.concurrency);
    if (String(els.concurrency.value) === String(applied)) return;
    els.concurrency.value = String(applied);
    window.dispatchEvent(new CustomEvent(SHARED_CONCURRENCY_EVENT, {
      detail: { concurrency: applied },
    }));
    setQueueStatus(`上游限流，最大并发数已自动调整为 ${applied}`);
  } catch {
    // A failed status refresh must not interrupt local generation queues.
  }
}

async function convertImage(dataUrl, mimeType, quality) {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法转换图片");
  context.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("图片转换失败")),
      mimeType,
      quality,
    );
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("读取图片失败"));
    image.src = src;
  });
}
