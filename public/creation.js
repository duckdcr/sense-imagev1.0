import { imageFilesFromSelection, appendUniqueImageFiles } from "./fabricFiles.js";
import { pageCapacityForHeight, paginateRows } from "./queueViews.js";
import { createPreviewTransform, dragPreview, resetPreviewTransform, transformStyle, zoomPreview } from "./previewZoom.js";
import { saveImagesWithBrowserFallback } from "./downloadFolder.js";
import { isHeicFile, previewUrlForFile } from "./imagePreview.js";
import { createCreationRows, outputNameForCreation } from "./creationCore.js";
import { installWorkspaceQueueClient } from "./workspaceQueueClient.js";
import { readSharedApiKey } from "./sharedApiKey.js";
import { saveLocalHistoryEntry } from "./localHistoryStore.js";
import { applyUploadBatch, createNextUploadBatch } from "./uploadBatches.js";
import {
  clearLegacyFixedPromptCache,
  fetchEditablePromptTemplate,
  resetEditablePromptTemplate,
  saveEditablePromptTemplate,
} from "./editablePromptSettings.js";

const STORAGE = { prompt: "sence-image-creation-extra-prompt-v2", size: "sence-image-creation-size-v1", quality: "sence-image-creation-quality-v1" };
const state = { sceneTemplateId: "", templates: [], files: [], stagedFiles: [], rows: [], running: false, submitting: false, activeJobs: 0, activeBatchIds: new Set(), paused: false, page: 1, pageSize: 5, transform: createPreviewTransform(), drag: null };
const workspaceQueue = installWorkspaceQueueClient({
  source: "creation",
  label: "场景图生成",
  getRows: () => state.rows,
  describeRow: (row) => ({ outputName: row.outputName, detail: row.error || ({ pending: "等待", queued: "队列中", paused: "暂停", running: "生成中", done: "已完成", error: "失败" }[row.status]), imageSrc: row.imageDataUrl || row.previewUrl || "", selectable: row.status === "done" && Boolean(row.imageDataUrl) }),
  onSelectionChange: () => render(),
  getPauseState: () => ({ active: state.running, paused: state.paused, transitioning: state.submitting }),
  togglePause,
  startQueuedTasks: startCreationTasks,
  removeTask: removePendingCreationTask,
});
const $ = (selector) => document.querySelector(selector);
const els = {
  form: $("#creationForm"), taskDialog: $("#creationTaskDialog"), openTaskDialog: $("#openCreationTaskDialog"), closeTaskDialog: $("#closeCreationTaskDialog"), promptEditorDialog: $("#creationPromptEditorDialog"), openPromptEditor: $("#openCreationPromptEditor"), resetPrompt: $("#resetCreationPrompt"), closePromptEditor: $("#closeCreationPromptEditor"), promptEditorInput: $("#creationPromptEditorInput"), savePromptEditor: $("#saveCreationPromptEditor"), templateList: $("#creationTemplateList"), fabricInput: $("#creationFabricInput"), fabricSummary: $("#creationFabricSummary"), folderInput: $("#creationFolderInput"), folderSummary: $("#creationFolderSummary"), prompt: $("#creationPrompt"), quality: $("#creationQuality"), size: $("#creationSize"), generate: $("#creationGenerate"), outputPreview: $("#creationOutputPreview"), list: $("#creationList"), viewport: $("#creationListViewport"), previous: $("#creationPrevious"), next: $("#creationNext"), page: $("#creationPage"), progress: $("#creationProgress"), progressBar: $("#creationProgressBar"), status: $("#creationStatus"), download: $("#creationDownload"), webp: $("#creationWebp"), dialog: $("#creationPreviewDialog"), dialogTitle: $("#creationDialogTitle"), dialogImage: $("#creationDialogImage"), dialogWrap: $("#creationDialogWrap"), dialogClose: $("#creationDialogClose"),
};

void init();

async function init() {
  clearLegacyFixedPromptCache(localStorage);
  for (const [key, element] of [["prompt", els.prompt], ["size", els.size], ["quality", els.quality]]) {
    const value = localStorage.getItem(STORAGE[key]);
    if (value) element.value = value;
    element.addEventListener(key === "prompt" ? "input" : "change", () => localStorage.setItem(STORAGE[key], element.value));
  }
  els.fabricInput.addEventListener("change", () => addFabrics(els.fabricInput.files, false));
  els.folderInput.addEventListener("change", () => addFabrics(els.folderInput.files, true));
  els.openTaskDialog.addEventListener("click", () => els.taskDialog.showModal());
  els.closeTaskDialog.addEventListener("click", () => els.taskDialog.close());
  els.taskDialog.addEventListener("click", (event) => { if (event.target === els.taskDialog) els.taskDialog.close(); });
  els.openPromptEditor.addEventListener("click", openPromptEditor);
  els.resetPrompt.addEventListener("click", resetPrompt);
  els.closePromptEditor.addEventListener("click", () => els.promptEditorDialog.close());
  els.promptEditorDialog.addEventListener("click", (event) => { if (event.target === els.promptEditorDialog) els.promptEditorDialog.close(); });
  els.savePromptEditor.addEventListener("click", savePromptEditor);
  els.form.addEventListener("submit", generate);
  els.previous.addEventListener("click", () => { state.page -= 1; render(); });
  els.next.addEventListener("click", () => { state.page += 1; render(); });
  els.download.addEventListener("click", () => exportSelected("jpg"));
  els.webp.addEventListener("click", () => exportSelected("webp"));
  els.dialogClose.addEventListener("click", () => els.dialog.close());
  els.dialogWrap.addEventListener("wheel", previewWheel, { passive: false });
  els.dialogWrap.addEventListener("pointerdown", previewDown); els.dialogWrap.addEventListener("pointermove", previewMove); els.dialogWrap.addEventListener("pointerup", previewUp); els.dialogWrap.addEventListener("pointercancel", previewUp);
  new ResizeObserver(updatePageSize).observe(els.viewport);
  await loadTemplates();
  render();
}

async function loadTemplates() {
  try {
    const data = await fetchJson("/api/curtain-scene-templates");
    state.templates = Array.isArray(data.templates) ? data.templates : [];
  } catch (error) { setStatus(error.message || "场景图读取失败"); }
}

function renderTemplates() {
  els.templateList.innerHTML = "";
  state.templates.forEach((template) => {
    const card = document.createElement("button"); card.type = "button"; card.className = "creation-template-card"; card.disabled = !template.available; card.setAttribute("role", "radio"); card.setAttribute("aria-checked", String(state.sceneTemplateId === template.id)); card.title = template.label;
    if (template.previewUrl) { const image = document.createElement("img"); image.src = template.previewUrl; image.alt = template.label; card.append(image); }
    else { const label = document.createElement("span"); label.textContent = template.label; card.append(label); }
    card.addEventListener("click", () => selectTemplate(template.id)); els.templateList.append(card);
  });
}

function selectTemplate(sceneTemplateId) {
  state.sceneTemplateId = sceneTemplateId;
  state.rows.filter((row) => row.status === "pending" || row.status === "error").forEach((row) => { row.sceneTemplateId = sceneTemplateId; });
  render();
}

async function openPromptEditor() {
  try {
    els.promptEditorInput.value = await fetchEditablePromptTemplate("curtain_creation");
    els.promptEditorDialog.showModal();
  } catch (error) { setStatus(error.message || "读取内置提示词失败"); }
}

async function savePromptEditor() {
  els.savePromptEditor.disabled = true;
  try {
    els.promptEditorInput.value = await saveEditablePromptTemplate(
      "curtain_creation",
      els.promptEditorInput.value,
    );
    els.promptEditorDialog.close();
    setStatus("场景图提示词已保存");
  } catch (error) {
    setStatus(error.message || "提示词保存失败");
  } finally {
    els.savePromptEditor.disabled = false;
  }
}

async function resetPrompt() {
  if (!window.confirm("确认恢复场景图的源码默认提示词吗？当前保存的场景图提示词将被清除。")) return;
  els.resetPrompt.disabled = true;
  try {
    await resetEditablePromptTemplate("curtain_creation");
    setStatus("场景图提示词已恢复为源码默认值");
  } catch (error) {
    setStatus(error.message || "恢复默认提示词失败");
  } finally {
    els.resetPrompt.disabled = false;
  }
}

function addFabrics(fileList, folder) {
  if (!state.sceneTemplateId) return setStatus("请选择场景图");
  const incoming = imageFilesFromSelection(fileList); if (!incoming.length) return;
  const next = appendUniqueImageFiles(state.files, incoming); const additions = next.slice(state.files.length); state.files = next; state.stagedFiles.push(...additions);
  const summary = folder ? els.folderSummary : els.fabricSummary; const folderName = incoming[0]?.webkitRelativePath?.split("/")[0]; summary.textContent = folder ? `${folderName || "所选文件夹"} 已上传` : `${incoming.length} 个文件已上传`;
  render();
}

async function hydrateCreationPreview(row) { if (!isHeicFile(row.file)) return; try { row.previewUrl = await previewUrlForFile(row.file); } catch (error) { row.error = error.message || "HEIC 预览转换失败"; } render(); }

async function generate(event) {
  event.preventDefault();
  const files = state.stagedFiles.splice(0);
  if (!files.length || !state.sceneTemplateId) return setStatus("请选择场景图和成品帘图");
  const taskSettings = { sceneTemplateId: state.sceneTemplateId, prompt: els.prompt.value, quality: els.quality.value, size: els.size.value };
  const rows = createCreationRows(files);
  applyUploadBatch(rows, createNextUploadBatch({ sourceLabel: "场景图生成", taskCount: rows.length }));
  rows.forEach((row) => { row.taskSettings = { ...taskSettings }; row.sceneTemplateId = taskSettings.sceneTemplateId; void hydrateCreationPreview(row); });
  state.rows.push(...rows);
  state.page = Math.max(1, Math.ceil(state.rows.length / state.pageSize));
  setStatus(`已添加 ${rows.length} 个任务`);
  els.taskDialog.close();
  render();
}

async function startCreationTasks() {
  if (state.submitting) return false;
  const targets = state.rows.filter((row) => row.status === "pending");
  if (!targets.length) return false;
  const apiKey = readSharedApiKey(); if (!apiKey) { setStatus("请输入 API Key"); return false; }
  state.submitting = true; toggleBusy(); targets.forEach((row) => { row.status = "queued"; row.error = ""; }); render();
  let started = false;
  try {
    const batch = await fetchJson("/api/generation-batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    state.activeJobs += targets.length; state.activeBatchIds.add(batch.batchId); state.running = true; setStatus(`已开始 ${targets.length} 个任务`); void runCreationRows(targets, batch.batchId, apiKey); started = true;
  } catch (error) { targets.filter((row) => row.status === "queued").forEach((row) => { row.status = "error"; row.error = error.message; }); setStatus(error.message || "生成失败"); }
  finally { state.submitting = false; toggleBusy(); render(); }
  return started;
}

async function runCreationRows(targets, batchId, apiKey) {
  try {
    await Promise.all(targets.map(async (row) => {
      row.status = "running"; render();
      try {
        const fabric = await filePayload(row.file);
        const submitted = await fetchJson(`/api/generation-batches/${batchId}/jobs`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey }, body: JSON.stringify({ kind: "creation", payload: { ...row.taskSettings, clientHistory: true, fabric } }) });
        const result = await pollJob(submitted.jobId, row); row.imageDataUrl = result.imageDataUrl; row.outputName = result.outputName || row.outputName; row.selected = true;
        try {
          const sceneTemplateId = result.sceneTemplateId || row.taskSettings.sceneTemplateId;
          row.historyEntry = await saveLocalHistoryEntry({
            taskType: "curtain_creation",
            sku: row.outputName.replace(/_sence\.jpg$/i, ""),
            outputName: row.outputName,
            prompt: row.taskSettings.prompt || "",
            resultUrl: row.imageDataUrl,
            sceneUrl: sceneTemplateId ? `/api/curtain-scene-templates/${encodeURIComponent(sceneTemplateId)}/image` : "",
            fabricUrl: fabric.dataUrl,
            options: { sceneTemplateId, quality: row.taskSettings.quality, size: row.taskSettings.size },
            uploadBatchId: row.uploadBatchId,
            uploadBatchLabel: row.uploadBatchLabel,
            uploadBatchCreatedAt: row.uploadBatchCreatedAt,
          });
        } catch (historyError) { row.historyError = historyError.message || "本地历史保存失败"; }
        row.status = "done";
      } catch (error) { row.status = "error"; row.error = error.message || "生成失败"; }
      render();
    }));
    setStatus(targets.some((row) => row.status === "error") ? "部分任务失败" : "生成完成");
  } finally { state.activeBatchIds.delete(batchId); state.activeJobs = Math.max(0, state.activeJobs - targets.length); state.running = state.activeJobs > 0; if (!state.running) state.paused = false; toggleBusy(); render(); }
}

async function pollJob(id, row) { while (true) { const job = await fetchJson(`/api/generation-jobs/${id}`); if (job.status === "paused") { row.status = "paused"; render(); } else if (job.status === "queued" || job.status === "running") { row.status = job.status; render(); } if (job.status === "done") return job.result || {}; if (job.status === "error") throw new Error(job.error || "生成失败"); await new Promise((resolve) => setTimeout(resolve, 400)); } }
async function togglePause(action) {
  if (!state.running || !state.activeBatchIds.size || state.submitting) return false;
  const nextAction = action || (state.paused ? "resume" : "pause");
  try {
    await Promise.all([...state.activeBatchIds].map((batchId) => fetchJson(`/api/generation-batches/${batchId}/${nextAction}`, { method: "POST" })));
    state.paused = nextAction === "pause";
    setStatus(state.paused ? "已暂停待执行任务" : "继续生成");
    render();
    return true;
  } catch (error) {
    setStatus(error.message || "操作失败");
    return false;
  }
}
function render() {
  renderTemplates(); els.outputPreview.textContent = state.rows.find((row) => row.outputName)?.outputName || outputNameForCreation("sample-sku_grommet.webp");
  const page = paginateRows(state.rows, state.page, state.pageSize); state.page = page.currentPage; els.list.innerHTML = "";
  if (!page.rows.length) { const empty = document.createElement("div"); empty.className = "empty-state"; empty.textContent = "尚未添加成品窗帘图"; els.list.append(empty); }
  page.rows.forEach((row) => els.list.append(renderRow(row))); els.page.textContent = `${page.currentPage} / ${page.totalPages}`; els.previous.disabled = page.currentPage <= 1; els.next.disabled = page.currentPage >= page.totalPages;
  const completed = state.rows.filter((row) => row.status === "done" || row.status === "error").length; els.progress.textContent = `${completed} / ${state.rows.length}`; els.progressBar.style.width = `${state.rows.length ? completed / state.rows.length * 100 : 0}%`;
  const selectable = state.rows.some((row) => row.status === "done" && row.selected); els.download.disabled = !selectable; els.webp.disabled = !selectable; workspaceQueue.notify();
}
function renderRow(row) {
  const article = document.createElement("article"); article.className = "queue-row"; const thumb = document.createElement("button"); thumb.className = "thumb"; thumb.type = "button"; thumb.disabled = !row.imageDataUrl; const image = document.createElement("img"); image.src = row.imageDataUrl || row.previewUrl; image.alt = row.outputName; thumb.append(image); thumb.addEventListener("click", () => openPreview(row));
  const main = document.createElement("div"); main.className = "file-main"; const title = document.createElement("strong"); title.textContent = row.outputName; const sub = document.createElement("span"); sub.textContent = row.error || ({ pending: "等待", queued: "队列中", paused: "暂停", running: "生成中", done: "已完成", error: "失败" }[row.status]); main.append(title, sub);
  const actions = document.createElement("div"); actions.className = "result-actions"; const preview = document.createElement("button"); preview.className = "button"; preview.type = "button"; preview.textContent = "预览"; preview.disabled = !row.imageDataUrl; preview.addEventListener("click", () => openPreview(row)); const remove = document.createElement("button"); remove.className = "button ghost"; remove.type = "button"; remove.textContent = "删除"; remove.disabled = row.status === "running" || row.status === "queued"; remove.addEventListener("click", () => removeRow(row)); actions.append(preview, remove);
  const select = document.createElement("input"); select.type = "checkbox"; select.checked = row.selected; select.disabled = row.status !== "done"; select.addEventListener("change", () => { row.selected = select.checked; render(); }); article.append(thumb, main, actions, select); return article;
}
function removeRow(row) { URL.revokeObjectURL(row.previewUrl); state.rows = state.rows.filter((item) => item !== row); state.files = state.rows.map((item) => item.file); render(); }
function removePendingCreationTask(row) { if (!row || row.status !== "pending") return false; removeRow(row); return true; }
function openPreview(row) { if (!row.imageDataUrl) return; state.transform = resetPreviewTransform(); applyTransform(); els.dialogTitle.textContent = row.outputName; els.dialogImage.src = row.imageDataUrl; els.dialog.showModal(); }
function previewWheel(event) { event.preventDefault(); state.transform = zoomPreview(state.transform, event.deltaY); applyTransform(); }
function previewDown(event) { if (state.transform.scale <= 1) return; state.drag = { x: event.clientX, y: event.clientY }; els.dialogWrap.setPointerCapture(event.pointerId); }
function previewMove(event) { if (!state.drag) return; state.transform = dragPreview(state.transform, event.clientX - state.drag.x, event.clientY - state.drag.y); state.drag = { x: event.clientX, y: event.clientY }; applyTransform(); }
function previewUp() { state.drag = null; }
function applyTransform() { els.dialogImage.style.transform = transformStyle(state.transform); els.dialogWrap.classList.toggle("zoomed", state.transform.scale > 1); }
async function exportSelected(format) { try { const rows = state.rows.filter((row) => row.status === "done" && row.selected); const { saved, usedBrowserDownload } = await saveImagesWithBrowserFallback(rows, { format, convertImageDataUrl: format === "webp" ? toWebp : undefined }); setStatus(usedBrowserDownload ? `浏览器开始下载 ${saved} 张` : `已保存 ${saved} 张`); } catch (error) { if (error.name !== "AbortError") setStatus(error.message || "保存失败"); } }
async function toWebp(dataUrl) { const image = await loadImage(dataUrl); const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext("2d").drawImage(image, 0, 0); return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("WebP 转换失败")), "image/webp", 0.9)); }
function loadImage(src) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("读取图片失败")); image.src = src; }); }
function filePayload(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result }); reader.onerror = () => reject(new Error("读取文件失败")); reader.readAsDataURL(file); }); }
async function fetchJson(url, init) { const response = await fetch(url, init); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "请求失败"); return data; }
function updatePageSize() { const size = pageCapacityForHeight(els.viewport.clientHeight); if (size !== state.pageSize) { state.pageSize = size; render(); } }
function setStatus(text) { els.status.textContent = text; }
function toggleBusy() { els.generate.disabled = state.submitting; els.generate.textContent = "添加任务"; }
