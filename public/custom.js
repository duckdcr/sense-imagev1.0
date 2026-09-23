import {
  addPromptRow,
  createCustomTaskRows,
  createPromptRows,
  customOutputName,
  customTaskStatusText,
  removePromptRow,
  updatePromptRow,
} from "./customCore.js";
import { saveImagesWithBrowserFallback } from "./downloadFolder.js";
import { previewUrlForFile } from "./imagePreview.js";
import { createGenerationBatchPoller } from "./generationBatchPoller.js";
import { pageCapacityForHeight, paginateRows, partitionQueueRows } from "./queueViews.js";
import {
  createPreviewTransform,
  dragPreview,
  resetPreviewTransform,
  transformStyle,
  zoomPreview,
} from "./previewZoom.js";
import { installWorkspaceQueueClient } from "./workspaceQueueClient.js";
import { readSharedApiKey } from "./sharedApiKey.js";
import { saveLocalHistoryEntry } from "./localHistoryStore.js";
import { applyUploadBatch, createNextUploadBatch } from "./uploadBatches.js";

const STORAGE = {
  prompts: "sence-image-custom-prompts-v1",
  quality: "sence-image-custom-quality-v1",
  size: "sence-image-custom-size-v1",
};
const poller = createGenerationBatchPoller();
const state = {
  reference: null,
  referencePreviewUrl: "",
  prompts: loadPrompts(),
  rows: [],
  running: false,
  submitting: false,
  activeJobs: 0,
  paused: false,
  activeBatchIds: new Set(),
  resultView: "queue",
  pages: { queue: 1, completed: 1 },
  pageSize: 5,
  transform: createPreviewTransform(),
  drag: null,
};
const workspaceQueue = installWorkspaceQueueClient({
  source: "custom",
  label: "多提示词生图",
  getRows: () => state.rows,
  describeRow: (row) => ({
    outputName: row.outputName,
    detail: row.error || customTaskStatusText(row.status),
    imageSrc: row.imageDataUrl || row.referencePreviewUrl || "",
    selectable: row.status === "done" && Boolean(row.imageDataUrl),
  }),
  onSelectionChange: () => render(),
  getPauseState: () => ({ active: state.running, paused: state.paused, transitioning: state.submitting }),
  togglePause,
  startQueuedTasks: startQueuedCustomTasks,
  removeTask: removePendingCustomTask,
});
const $ = (selector) => document.querySelector(selector);
const els = {
  form: $("#customForm"),
  taskDialog: $("#customTaskDialog"),
  openTaskDialog: $("#openCustomTaskDialog"),
  closeTaskDialog: $("#closeCustomTaskDialog"),
  referenceInput: $("#customReferenceInput"),
  referenceSummary: $("#customReferenceSummary"),
  referencePreview: $("#customReferencePreview"),
  promptList: $("#customPromptList"),
  addPrompt: $("#customAddPrompt"),
  quality: $("#customQuality"),
  size: $("#customSize"),
  outputPreview: $("#customOutputPreview"),
  generate: $("#customGenerate"),
  download: $("#customDownload"),
  progress: $("#customProgress"),
  progressBar: $("#customProgressBar"),
  status: $("#customStatus"),
  listViewport: $("#customListViewport"),
  list: $("#customList"),
  completedList: $("#customCompletedList"),
  queueView: $("#customQueueView"),
  completedView: $("#customCompletedView"),
  queueCount: $("#customQueueCount"),
  completedCount: $("#customCompletedCount"),
  previous: $("#customPrevious"),
  next: $("#customNext"),
  page: $("#customPage"),
  dialog: $("#customPreviewDialog"),
  dialogTitle: $("#customDialogTitle"),
  dialogClose: $("#customDialogClose"),
  dialogWrap: $("#customDialogWrap"),
  dialogImage: $("#customDialogImage"),
};

restoreSettings();
renderPrompts();
render();

els.referenceInput.addEventListener("change", selectReference);
els.openTaskDialog.addEventListener("click", () => els.taskDialog.showModal());
els.closeTaskDialog.addEventListener("click", () => els.taskDialog.close());
els.taskDialog.addEventListener("click", (event) => { if (event.target === els.taskDialog) els.taskDialog.close(); });
els.addPrompt.addEventListener("click", () => {
  state.prompts = addPromptRow(state.prompts);
  persistPrompts();
  renderPrompts();
});
els.form.addEventListener("submit", startGeneration);
els.download.addEventListener("click", downloadSelected);
els.queueView.addEventListener("click", () => setResultView("queue"));
els.completedView.addEventListener("click", () => setResultView("completed"));
els.previous.addEventListener("click", () => { state.pages[state.resultView] -= 1; render(); });
els.next.addEventListener("click", () => { state.pages[state.resultView] += 1; render(); });
els.dialogClose.addEventListener("click", () => els.dialog.close());
els.dialog.addEventListener("click", (event) => { if (event.target === els.dialog) els.dialog.close(); });
els.dialogWrap.addEventListener("wheel", previewWheel, { passive: false });
els.dialogWrap.addEventListener("pointerdown", previewDown);
els.dialogWrap.addEventListener("pointermove", previewMove);
els.dialogWrap.addEventListener("pointerup", previewUp);
els.dialogWrap.addEventListener("pointercancel", previewUp);
for (const [element, key] of [[els.quality, "quality"], [els.size, "size"]]) {
  element.addEventListener("change", () => {
    localStorage.setItem(STORAGE[key], element.value);
  });
}
new ResizeObserver(updatePageSize).observe(els.listViewport);

function loadPrompts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE.prompts) || "[]");
    return createPromptRows(Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : []);
  } catch {
    return createPromptRows();
  }
}

function restoreSettings() {
  els.quality.value = localStorage.getItem(STORAGE.quality) || "high";
  els.size.value = localStorage.getItem(STORAGE.size) || "2048x2048";
  if (!els.size.value) {
    els.size.value = "2048x2048";
    localStorage.setItem(STORAGE.size, els.size.value);
  }
}

function persistPrompts() {
  localStorage.setItem(STORAGE.prompts, JSON.stringify(state.prompts.map((row) => row.prompt)));
}

function renderPrompts() {
  els.promptList.replaceChildren();
  state.prompts.forEach((row, index) => {
    const item = document.createElement("div");
    item.className = "custom-prompt-row";
    const number = document.createElement("span");
    number.textContent = String(index + 1).padStart(2, "0");
    const input = document.createElement("textarea");
    input.rows = 2;
    input.maxLength = 20000;
    input.value = row.prompt;
    input.placeholder = "输入提示词";
    input.disabled = state.submitting;
    input.addEventListener("input", () => {
      state.prompts = updatePromptRow(state.prompts, row.id, input.value);
      persistPrompts();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.textContent = "×";
    remove.title = "删除提示词";
    remove.setAttribute("aria-label", "删除提示词");
    remove.disabled = state.submitting || state.prompts.length <= 1;
    remove.addEventListener("click", () => {
      state.prompts = removePromptRow(state.prompts, row.id);
      persistPrompts();
      renderPrompts();
    });
    item.append(number, input, remove);
    els.promptList.append(item);
  });
}

async function selectReference() {
  const [file] = Array.from(els.referenceInput.files || []);
  if (!file) return;
  state.reference = file;
  state.referencePreviewUrl = "";
  els.referenceSummary.textContent = `${file.name} 已上传`;
  els.referencePreview.classList.remove("empty");
  els.referencePreview.replaceChildren();
  const image = document.createElement("img");
  image.alt = file.name;
  els.referencePreview.append(image);
  try { state.referencePreviewUrl = await previewUrlForFile(file); image.src = state.referencePreviewUrl; }
  catch (error) { els.referencePreview.classList.add("empty"); els.referencePreview.textContent = error.message || "HEIC 预览转换失败"; }
  render();
}

async function startGeneration(event) {
  event.preventDefault();
  if (state.submitting) return;
  if (!state.reference) return setStatus("请选择参考图");
  const newRows = createCustomTaskRows(state.prompts, state.reference.name, state.rows);
  if (!newRows.length) return setStatus("请至少填写一条提示词");

  state.submitting = true;
  toggleBusy();
  try {
    const referenceFile = state.reference;
    const referencePreviewUrl = state.referencePreviewUrl;
    const quality = els.quality.value;
    const size = els.size.value;
    applyUploadBatch(newRows, createNextUploadBatch({ sourceLabel: "多提示词生图", taskCount: newRows.length }));
    newRows.forEach((row) => Object.assign(row, {
      referenceFile,
      referencePreviewUrl,
      quality,
      size,
      status: "pending",
    }));
    state.rows.push(...newRows);
    state.resultView = "queue";
    state.prompts = createPromptRows();
    persistPrompts();
    renderPrompts();
    const activeCount = partitionQueueRows(state.rows).active.length;
    state.pages.queue = Math.max(1, Math.ceil(activeCount / state.pageSize));
    setStatus(`已添加 ${newRows.length} 个任务`);
    els.taskDialog.close();
    render();
  } catch (error) {
    setStatus(error.message || "添加失败");
  } finally {
    state.submitting = false;
    toggleBusy();
    renderPrompts();
  }
}

async function startQueuedCustomTasks() {
  if (state.submitting) return false;
  const rows = state.rows.filter((row) => row.status === "pending");
  if (!rows.length) return false;
  const apiKey = readSharedApiKey();
  if (!apiKey) { setStatus("请输入 API Key"); return false; }
  state.submitting = true;
  toggleBusy();
  rows.forEach((row) => { row.status = "queued"; row.error = ""; });
  try {
    const batch = await createBatch();
    if (state.paused) await fetchJson(`/api/generation-batches/${batch.batchId}/pause`, { method: "POST" });
    state.activeJobs += rows.length;
    state.running = true;
    state.activeBatchIds.add(batch.batchId);
    setStatus(`已开始 ${rows.length} 个任务`);
    render();
    void runRows(rows, batch.batchId, apiKey);
    return true;
  } catch (error) {
    rows.forEach((row) => { row.status = "error"; row.error = error.message || "提交失败"; });
    setStatus(error.message || "提交失败");
    return false;
  } finally {
    state.submitting = false;
    toggleBusy();
    render();
  }
}

async function createBatch() {
  return fetchJson("/api/generation-batches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function runRows(rows, batchId, apiKey) {
  try {
    await Promise.all(rows.map(async (row) => {
      try {
        const reference = await filePayload(row.referenceFile);
        const submitted = await fetchJson(`/api/generation-batches/${batchId}/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({
            kind: "custom",
            payload: {
              reference,
              prompt: row.prompt,
              outputName: row.outputName,
              quality: row.quality,
              size: row.size,
              clientHistory: true,
            },
          }),
        });
        const result = await poller.waitFor(batchId, submitted.jobId, (status) => {
          row.status = status === "running" ? "running" : status === "paused" ? "paused" : "queued";
          render();
        });
        row.imageDataUrl = result.imageDataUrl;
        row.outputName = result.outputName || row.outputName;
        row.selected = true;
        try {
          row.historyEntry = await saveLocalHistoryEntry({
            taskType: "custom_generation",
            sku: row.outputName.replace(/\.jpg$/i, ""),
            outputName: row.outputName,
            prompt: row.prompt,
            resultUrl: row.imageDataUrl,
            sceneUrl: reference.dataUrl,
            options: { quality: row.quality, size: row.size },
            uploadBatchId: row.uploadBatchId,
            uploadBatchLabel: row.uploadBatchLabel,
            uploadBatchCreatedAt: row.uploadBatchCreatedAt,
          });
        } catch (historyError) { row.historyError = historyError.message || "本地历史保存失败"; }
        row.status = "done";
      } catch (error) {
        row.status = "error";
        row.error = error.message || "生成失败";
      }
      render();
    }));
  } catch (error) {
    rows.filter((row) => row.status === "queued").forEach((row) => {
      row.status = "error";
      row.error = error.message || "生成失败";
    });
  } finally {
    state.activeJobs = Math.max(0, state.activeJobs - rows.length);
    state.activeBatchIds.delete(batchId);
    state.running = state.activeJobs > 0;
    if (!state.running) {
      state.paused = false;
      const failed = state.rows.some((row) => row.status === "error");
      setStatus(failed ? "部分任务失败" : "全部任务完成");
    }
    toggleBusy();
    render();
  }
}

async function togglePause(requestedAction) {
  if (!state.running || !state.activeBatchIds.size) return;
  const action = requestedAction || (state.paused ? "resume" : "pause");
  try {
    await Promise.all([...state.activeBatchIds].map((batchId) =>
      fetchJson(`/api/generation-batches/${batchId}/${action}`, { method: "POST" })
    ));
    state.paused = action === "pause";
    setStatus(state.paused ? "已暂停待执行任务" : "继续生成");
  } catch (error) {
    setStatus(error.message || "操作失败");
  }
  render();
}

function render() {
  const referenceName = state.reference?.name || "reference.jpg";
  const index = state.rows.filter((row) => row.referenceName === referenceName).length;
  els.outputPreview.textContent = customOutputName(referenceName, index);
  const { active, completed } = partitionQueueRows(state.rows);
  const queuePage = paginateRows(active, state.pages.queue, state.pageSize);
  const completedPage = paginateRows(completed, state.pages.completed, state.pageSize);
  state.pages.queue = queuePage.currentPage;
  state.pages.completed = completedPage.currentPage;
  els.list.replaceChildren();
  els.completedList.replaceChildren();
  renderRows(queuePage.rows, els.list, state.rows.length ? "当前没有未完成任务" : "尚未生成图片");
  renderRows(completedPage.rows, els.completedList, "暂无已完成任务");
  els.queueCount.textContent = String(active.length);
  els.completedCount.textContent = String(completed.length);
  const completedView = state.resultView === "completed";
  els.queueView.setAttribute("aria-selected", String(!completedView));
  els.completedView.setAttribute("aria-selected", String(completedView));
  els.list.hidden = completedView;
  els.completedList.hidden = !completedView;
  const page = completedView ? completedPage : queuePage;
  els.page.textContent = `${page.currentPage} / ${page.totalPages}`;
  els.previous.disabled = page.currentPage <= 1;
  els.next.disabled = page.currentPage >= page.totalPages;
  const finished = state.rows.filter((row) => row.status === "done" || row.status === "error").length;
  els.progress.textContent = `${finished} / ${state.rows.length}`;
  els.progressBar.style.width = `${state.rows.length ? finished / state.rows.length * 100 : 0}%`;
  els.download.disabled = !state.rows.some((row) => row.status === "done" && row.selected);
  els.generate.textContent = "添加任务";
  workspaceQueue.notify();
}

function renderRows(rows, container, emptyText) {
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  rows.forEach((row) => container.append(renderResultRow(row)));
}

function setResultView(view) {
  state.resultView = view === "completed" ? "completed" : "queue";
  render();
}

function removePendingCustomTask(row) {
  if (!row || row.status !== "pending" || !state.rows.includes(row)) return false;
  state.rows = state.rows.filter((item) => item !== row);
  setStatus("已删除任务");
  render();
  return true;
}

function renderResultRow(row) {
  const article = document.createElement("article");
  article.className = "queue-row";
  const thumb = document.createElement("button");
  thumb.className = "thumb";
  thumb.type = "button";
  thumb.disabled = !row.imageDataUrl;
  const image = document.createElement("img");
  image.src = row.imageDataUrl || row.referencePreviewUrl || state.referencePreviewUrl;
  image.alt = row.outputName;
  thumb.append(image);
  thumb.addEventListener("click", () => openPreview(row));
  const main = document.createElement("div");
  main.className = "file-main";
  const title = document.createElement("strong");
  title.textContent = row.outputName;
  const sub = document.createElement("span");
  sub.textContent = row.error
    ? `${customTaskStatusText(row.status)} · ${row.error}`
    : `${customTaskStatusText(row.status)} · ${row.prompt}`;
  main.append(title, sub);
  const actions = document.createElement("div");
  actions.className = "result-actions";
  const action = document.createElement("button");
  action.className = "button";
  action.type = "button";
  action.textContent = row.status === "error" ? "重试" : "预览";
  action.disabled = row.status === "queued"
    || row.status === "running"
    || (row.status === "error" && state.paused)
    || (row.status !== "error" && !row.imageDataUrl);
  action.addEventListener("click", () => row.status === "error" ? retryRow(row) : openPreview(row));
  actions.append(action);
  const select = document.createElement("input");
  select.type = "checkbox";
  select.checked = row.selected;
  select.disabled = row.status !== "done";
  select.addEventListener("change", () => { row.selected = select.checked; render(); });
  article.append(thumb, main, actions, select);
  return article;
}

function openPreview(row) {
  if (!row.imageDataUrl) return;
  state.transform = resetPreviewTransform();
  applyTransform();
  els.dialogTitle.textContent = row.outputName;
  els.dialogImage.src = row.imageDataUrl;
  els.dialog.showModal();
}

function previewWheel(event) {
  event.preventDefault();
  state.transform = zoomPreview(state.transform, event.deltaY);
  applyTransform();
}
function previewDown(event) {
  if (state.transform.scale <= 1) return;
  state.drag = { x: event.clientX, y: event.clientY };
  els.dialogWrap.setPointerCapture(event.pointerId);
}
function previewMove(event) {
  if (!state.drag) return;
  state.transform = dragPreview(state.transform, event.clientX - state.drag.x, event.clientY - state.drag.y);
  state.drag = { x: event.clientX, y: event.clientY };
  applyTransform();
}
function previewUp() { state.drag = null; }
function applyTransform() {
  els.dialogImage.style.transform = transformStyle(state.transform);
  els.dialogWrap.classList.toggle("zoomed", state.transform.scale > 1);
}

async function downloadSelected() {
  try {
    const rows = state.rows.filter((row) => row.status === "done" && row.selected);
    const { saved, usedBrowserDownload } = await saveImagesWithBrowserFallback(rows, { format: "jpg" });
    setStatus(usedBrowserDownload ? `浏览器开始下载 ${saved} 张` : `已保存 ${saved} 张`);
  } catch (error) {
    if (error.name !== "AbortError") setStatus(error.message || "保存失败");
  }
}

async function retryRow(row) {
  if (!row.referenceFile) return setStatus("原参考图不可用，请重新提交");
  const apiKey = readSharedApiKey();
  if (!apiKey) return setStatus("请输入 API Key");
  row.status = "queued";
  row.error = "";
  try {
    const batch = await createBatch();
    const reference = await filePayload(row.referenceFile);
    state.activeJobs += 1;
    state.running = true;
    state.activeBatchIds.add(batch.batchId);
    render();
    void runRows([row], batch.batchId, apiKey, reference);
  } catch (error) {
    row.status = "error";
    row.error = error.message || "重试失败";
    render();
  }
}

function toggleBusy() {
  els.referenceInput.disabled = state.submitting;
  els.addPrompt.disabled = state.submitting;
  els.quality.disabled = state.submitting;
  els.size.disabled = state.submitting;
  els.generate.disabled = state.submitting;
}

function updatePageSize() {
  const size = pageCapacityForHeight(els.listViewport.clientHeight);
  if (size !== state.pageSize) {
    state.pageSize = size;
    render();
  }
}
function setStatus(text) { els.status.textContent = text; }
function filePayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result });
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}
async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "请求失败");
  return data;
}
