import { readSharedApiKey } from "./sharedApiKey.js";
import { createGenerationQueue } from "./concurrency.js";
import {
  SHARED_CONCURRENCY_EVENT,
  SHARED_CONCURRENCY_KEY,
  readSharedConcurrency,
} from "./sharedConcurrency.js";
import {
  assertDatabaseOutputsAvailable,
  commitDatabaseResult,
  filterJobsForProgress,
  readDatabaseProgress,
} from "./databaseOutput.js";
import {
  assertCurtainProductOutputsAvailable,
  commitCurtainProductResult,
  filterCurtainProductJobs,
  readCurtainProductProgress,
} from "./curtainProductOutput.js";
import { createDatabaseLoadGuard } from "./databaseLoadState.js";
import { saveImagesWithBrowserFallback } from "./downloadFolder.js";
import { isHeicFile, nativePreviewUrl, previewUrlForFile } from "./imagePreview.js";
import { appendFilesWithUniqueOutputNames, imageFilesFromSelection } from "./fabricFiles.js";
import {
  expandManualCurtainRows,
  normalizeManualCurtainHeadingStyles,
} from "./manualCurtainHeadings.js";
import {
  applyBackendJobStatus,
  generationButtonLabel,
  markRowsPaused,
  markRowsResumed,
} from "./generationPauseState.js";
import { createGenerationBatchPoller } from "./generationBatchPoller.js";
import {
  pageCapacityForHeight,
  paginateRows,
  partitionQueueRows,
  runnableQueueRows,
} from "./queueViews.js";
import { createPreviewViewerController } from "./previewViewerController.js";
import {
  createSkuSelection,
  selectedSkuJobs,
  setAllFilteredSkuSelected,
  setCurrentSkuPageSelected,
  setSkuSearch,
  setSkuSelectionPage,
  skuSelectionCounts,
  skuSelectionPage,
  toggleSkuSelection,
} from "./skuSelection.js";
import { installWorkspaceQueueClient } from "./workspaceQueueClient.js";
import { saveLocalHistoryEntry } from "./localHistoryStore.js";
import { applyUploadBatch, createNextUploadBatch } from "./uploadBatches.js";
import {
  clearLegacyFixedPromptCache,
  fetchEditablePromptTemplate,
  resetEditablePromptTemplate,
  saveEditablePromptTemplate,
} from "./editablePromptSettings.js";

const PROMPT_KEY = "sence-image-extra-prompt-v2";
const QUALITY_KEY = "sence-image-quality";
const SIZE_KEY = "sence-image-size";
const MANUAL_FABRIC_CATALOG_ROOT_KEY = "sence-image-manual-fabric-catalog-root-v1";
const DEFAULT_MANUAL_FABRIC_CATALOG_ROOT = "/Users/wangyuanzi/Documents/code/work2/test/32";
const REAL_OUTPUT_SIZE_ALIASES = new Set([
  "2048x2048",
  "2880x2880",
  "3840x2160",
  "2160x3840",
  "1536x1024",
  "1024x1536",
  "2048x1152",
  "1152x2048",
]);

export function databaseTaskControlState(taskType) {
  const product = taskType === "curtain_product";
  return {
    product,
    showSceneDirectory: !product,
    showProductDirectories: product,
    showSaveFormat: !product,
    saveFormatDisabled: product,
  };
}

export function databaseSaveFormatForTask(taskType, selectedFormat) {
  return taskType === "curtain_product" ? "webp" : selectedFormat;
}

export function generationSizeControlState(mode, taskType, selectedSize) {
  const supported = ["2048x2048", "2880x2880", "3840x2160", "2160x3840", "1536x1024", "1024x1536", "2048x1152", "1152x2048"];
  const productSupported = ["2048x2048", "2880x2880"];
  const databaseProduct = mode === "database" && taskType === "curtain_product";
  const allowed = databaseProduct ? productSupported : supported;
  return {
    value: allowed.includes(selectedSize) ? selectedSize : allowed[0],
    disabled: false,
  };
}

export function normalizeGenerationSize(size) {
  return REAL_OUTPUT_SIZE_ALIASES.has(size) ? size : "2048x2048";
}

export function createCurtainProductDirectorySelectionCoordinator() {
  let active = false;
  return {
    async run(task) {
      if (active) return { accepted: false };
      active = true;
      try {
        return { accepted: true, value: await task() };
      } finally {
        active = false;
      }
    },
    isActive() {
      return active;
    },
  };
}

export function beginStartingRun(runState) {
  if (runState.startingRun) return false;
  runState.startingRun = true;
  return true;
}

export function finishStartingRun(runState) {
  runState.startingRun = false;
}

export function batchSemanticActionsBlocked(runState, coordinator) {
  return Boolean(runState.startingRun || coordinator.isActive());
}

export function canStartDirectorySelection(runState, coordinator) {
  return !runState.startingRun
    && !runState.running
    && !runState.loadingDatabase
    && !coordinator.isActive();
}

export function requireCurtainProductHistoryEntry(data) {
  if (!data?.entry || typeof data.entry !== "object" || Array.isArray(data.entry)) {
    throw new Error("历史保存响应无效");
  }
  return data.entry;
}

export function createCurtainProductOutput(sku, headingStyle) {
  const styleSuffix = headingStyle === "doublePinch" ? "double-pinch" : "grommet";
  return { outputName: buildOutputName(sku, `_${styleSuffix}`, "webp"), imageDataUrl: "" };
}

const state = {
  mode: "manual",
  fabricFiles: [],
  stagedFabricFiles: [],
  manualRows: [],
  databaseRows: [],
  databaseOutputDirectory: null,
  databaseProgress: { version: 2, completed: { scene_replacement: {}, curtain_product: {} } },
  curtainProductOutputDirectory: null,
  curtainProductProgress: null,
  progressWriteQueue: Promise.resolve(),
  rows: [],
  resultView: "queue",
  pageSize: 1,
  pages: { queue: 1, completed: 1 },
  running: false,
  startingRun: false,
  activeRun: null,
  loadingDatabase: false,
  skuSelection: null,
  skuSelectionContext: null,
  renderQueued: false,
};

const workspaceQueue = installWorkspaceQueueClient({
  source: "main",
  label: "白底图生成",
  getRows: () => [...state.manualRows, ...state.databaseRows],
  describeRow: (row) => ({
    outputName: row.displayName || row.outputName || row.job?.factorySku || "未命名任务",
    detail: row.error || statusText(row),
    imageSrc: row.imageDataUrl || row.previewUrl || "",
    selectable: row.status === "done" && Boolean(row.imageDataUrl),
  }),
  onSelectionChange: () => renderQueue(),
  getPauseState: () => ({
    active: Boolean(state.activeRun),
    paused: Boolean(state.activeRun?.paused),
    transitioning: Boolean(state.activeRun?.transitioning),
  }),
  togglePause: (action) => handlePauseGeneration(action),
  startQueuedTasks: startMainQueuedTasks,
  removeTask: removePendingMainTask,
});

const els = {
  apiForm: document.querySelector("#apiForm"),
  checkModelButton: document.querySelector("#checkModelButton"),
  closeHistoryBrowserButton: document.querySelector("#closeHistoryBrowserButton"),
  closeDialogButton: document.querySelector("#closeDialogButton"),
  completedCount: document.querySelector("#completedCount"),
  completedList: document.querySelector("#completedList"),
  completedViewButton: document.querySelector("#completedViewButton"),
  databaseControls: document.querySelector("#databaseControls"),
  databaseSaveFormatField: document.querySelector("#databaseSaveFormatField"),
  databaseSceneOutputControls: document.querySelector("#databaseSceneOutputControls"),
  databaseModeButton: document.querySelector("#databaseModeButton"),
  databaseOutputSummary: document.querySelector("#databaseOutputSummary"),
  databaseRunMode: document.querySelector("#databaseRunMode"),
  databaseSaveFormat: document.querySelector("#databaseSaveFormat"),
  databaseSummary: document.querySelector("#databaseSummary"),
  databaseTaskType: document.querySelector("#databaseTaskType"),
  curtainProductDirectoryControls: document.querySelector("#curtainProductDirectoryControls"),
  curtainProductDirectorySummary: document.querySelector("#curtainProductDirectorySummary"),
  curtainProductHeading: document.querySelector("#curtainProductHeading"),
  dialogImage: document.querySelector("#dialogImage"),
  dialogImageWrap: document.querySelector("#dialogImageWrap"),
  dialogTitle: document.querySelector("#dialogTitle"),
  downloadButton: document.querySelector("#downloadButton"),
  fabricFolderInput: document.querySelector("#fabricFolderInput"),
  fabricFolderInputSummary: document.querySelector("#fabricFolderInputSummary"),
  fabricInput: document.querySelector("#fabricInput"),
  fabricInputSummary: document.querySelector("#fabricInputSummary"),
  generateButton: document.querySelector("#generateButton"),
  historyBrowserDialog: document.querySelector("#historyBrowserDialog"),
  historyFrame: document.querySelector("#historyFrame"),
  loadDatabaseButton: document.querySelector("#loadDatabaseButton"),
  manualControls: document.querySelector("#manualControls"),
  manualCurtainProductHeadings: Array.from(document.querySelectorAll('input[name="manualCurtainProductHeading"]')),
  manualFabricCatalogRoot: document.querySelector("#manualFabricCatalogRoot"),
  manualFabricSampleSize: document.querySelector("#manualFabricSampleSize"),
  manualModeButton: document.querySelector("#manualModeButton"),
  mainTaskDialog: document.querySelector("#mainTaskDialog"),
  openMainTaskDialog: document.querySelector("#openMainTaskDialog"),
  closeMainTaskDialog: document.querySelector("#closeMainTaskDialog"),
  mainPromptEditorDialog: document.querySelector("#mainPromptEditorDialog"),
  openMainPromptEditor: document.querySelector("#openMainPromptEditor"),
  resetMainPrompt: document.querySelector("#resetMainPrompt"),
  closeMainPromptEditor: document.querySelector("#closeMainPromptEditor"),
  mainPromptEditorKind: document.querySelector("#mainPromptEditorKind"),
  mainPromptEditorInput: document.querySelector("#mainPromptEditorInput"),
  saveMainPromptEditor: document.querySelector("#saveMainPromptEditor"),
  openHistoryButton: document.querySelector("#openHistoryButton"),
  outputNamePreview: document.querySelector("#outputNamePreview"),
  nextPageButton: document.querySelector("#nextPageButton"),
  pageIndicator: document.querySelector("#pageIndicator"),
  previewDialog: document.querySelector("#previewDialog"),
  previousPageButton: document.querySelector("#previousPageButton"),
  progressBar: document.querySelector("#progressBar"),
  progressText: document.querySelector("#progressText"),
  promptInput: document.querySelector("#promptInput"),
  qualityInput: document.querySelector("#qualityInput"),
  queueCount: document.querySelector("#queueCount"),
  queueList: document.querySelector("#queueList"),
  queueViewButton: document.querySelector("#queueViewButton"),
  resultListViewport: document.querySelector("#resultListViewport"),
  resultPagination: document.querySelector("#resultPagination"),
  selectDatabaseOutputButton: document.querySelector("#selectDatabaseOutputButton"),
  selectCurtainProductDirectoryButton: document.querySelector("#selectCurtainProductDirectoryButton"),
  sizeInput: document.querySelector("#sizeInput"),
  skuSelectionDialog: document.querySelector("#skuSelectionDialog"),
  closeSkuSelectionButton: document.querySelector("#closeSkuSelectionButton"),
  skuSelectionTitle: document.querySelector("#skuSelectionTitle"),
  skuSelectionCounts: document.querySelector("#skuSelectionCounts"),
  skuSearchInput: document.querySelector("#skuSearchInput"),
  toggleAllFilteredSkuButton: document.querySelector("#toggleAllFilteredSkuButton"),
  toggleCurrentSkuPageButton: document.querySelector("#toggleCurrentSkuPageButton"),
  skuSelectionList: document.querySelector("#skuSelectionList"),
  previousSkuPageButton: document.querySelector("#previousSkuPageButton"),
  skuPageIndicator: document.querySelector("#skuPageIndicator"),
  nextSkuPageButton: document.querySelector("#nextSkuPageButton"),
  cancelSkuSelectionButton: document.querySelector("#cancelSkuSelectionButton"),
  confirmSkuSelectionButton: document.querySelector("#confirmSkuSelectionButton"),
  statusText: document.querySelector("#statusText"),
  toolForm: document.querySelector("#toolForm"),
  webpDownloadButton: document.querySelector("#webpDownloadButton"),
};

const databaseLoadGuard = createDatabaseLoadGuard();
const generationBatchPoller = createGenerationBatchPoller();
const curtainProductDirectorySelection = createCurtainProductDirectorySelectionCoordinator();
const previewViewer = createPreviewViewerController({
  dialog: els.previewDialog,
  viewport: els.dialogImageWrap,
  image: els.dialogImage,
  closeButton: els.closeDialogButton,
  windowTarget: window,
  titleElement: els.dialogTitle,
});

init();

function init() {
  clearLegacyFixedPromptCache(localStorage);
  state.rows = state.manualRows;
  els.promptInput.value = localStorage.getItem(PROMPT_KEY) || "";
  els.qualityInput.value = localStorage.getItem(QUALITY_KEY) || "high";
  els.sizeInput.value = normalizeGenerationSize(localStorage.getItem(SIZE_KEY));
  localStorage.setItem(SIZE_KEY, els.sizeInput.value);
  els.manualFabricCatalogRoot.value = localStorage.getItem(MANUAL_FABRIC_CATALOG_ROOT_KEY)
    || DEFAULT_MANUAL_FABRIC_CATALOG_ROOT;
  applySourceMode();
  renderQueue();

  els.promptInput.addEventListener("input", () => {
    localStorage.setItem(PROMPT_KEY, els.promptInput.value);
  });
  els.qualityInput.addEventListener("change", () => localStorage.setItem(QUALITY_KEY, els.qualityInput.value));
  els.sizeInput.addEventListener("change", () => localStorage.setItem(SIZE_KEY, els.sizeInput.value));
  els.manualFabricCatalogRoot.addEventListener("change", () => {
    localStorage.setItem(MANUAL_FABRIC_CATALOG_ROOT_KEY, selectedManualFabricCatalogRoot());
  });
  els.apiForm.addEventListener("submit", (event) => event.preventDefault());
  window.addEventListener(SHARED_CONCURRENCY_EVENT, (event) => {
    state.activeRun?.queue?.setConcurrency(event.detail?.concurrency);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === SHARED_CONCURRENCY_KEY) {
      state.activeRun?.queue?.setConcurrency(readSharedConcurrency());
    }
  });
  els.databaseModeButton.addEventListener("click", () => switchSourceMode("database"));
  els.manualModeButton.addEventListener("click", () => switchSourceMode("manual"));
  els.loadDatabaseButton.addEventListener("click", loadDatabaseJobs);
  els.databaseRunMode.addEventListener("change", handleDatabaseRunModeChange);
  els.databaseTaskType.addEventListener("change", handleDatabaseTaskTypeChange);
  els.databaseSaveFormat.addEventListener("change", handleDatabaseSaveFormatChange);
  els.selectDatabaseOutputButton.addEventListener("click", selectDatabaseOutputDirectory);
  els.selectCurtainProductDirectoryButton.addEventListener("click", selectCurtainProductDirectory);
  els.curtainProductHeading.addEventListener("change", handleCurtainProductHeadingChange);
  els.fabricInput.addEventListener("change", handleFabricChange);
  els.fabricFolderInput.addEventListener("change", handleFabricChange);
  els.manualCurtainProductHeadings.forEach((input) => input.addEventListener("change", handleManualHeadingOptionsChange));
  els.manualFabricSampleSize.addEventListener("change", handleManualProductOptionsChange);
  els.openMainTaskDialog.addEventListener("click", () => els.mainTaskDialog.showModal());
  els.closeMainTaskDialog.addEventListener("click", () => els.mainTaskDialog.close());
  els.mainTaskDialog.addEventListener("click", (event) => { if (event.target === els.mainTaskDialog) els.mainTaskDialog.close(); });
  els.openMainPromptEditor.addEventListener("click", openMainPromptEditor);
  els.resetMainPrompt.addEventListener("click", resetMainPrompt);
  els.closeMainPromptEditor.addEventListener("click", () => els.mainPromptEditorDialog.close());
  els.mainPromptEditorDialog.addEventListener("click", (event) => { if (event.target === els.mainPromptEditorDialog) els.mainPromptEditorDialog.close(); });
  els.mainPromptEditorKind.addEventListener("change", () => void loadMainPromptEditorKind());
  els.saveMainPromptEditor.addEventListener("click", saveMainPromptEditor);
  els.toolForm.addEventListener("submit", handleGenerate);
  els.downloadButton.addEventListener("click", downloadSelected);
  els.webpDownloadButton.addEventListener("click", exportSelectedWebp);
  els.checkModelButton.addEventListener("click", checkModel);
  els.openHistoryButton.addEventListener("click", openHistoryBrowser);
  els.closeHistoryBrowserButton.addEventListener("click", closeHistoryBrowser);
  els.queueViewButton.addEventListener("click", () => setResultView("queue"));
  els.completedViewButton.addEventListener("click", () => setResultView("completed"));
  els.previousPageButton.addEventListener("click", () => changeResultPage(-1));
  els.nextPageButton.addEventListener("click", () => changeResultPage(1));
  els.closeSkuSelectionButton.addEventListener("click", cancelSkuSelection);
  els.cancelSkuSelectionButton.addEventListener("click", cancelSkuSelection);
  els.confirmSkuSelectionButton.addEventListener("click", confirmSkuSelection);
  els.skuSearchInput.addEventListener("input", handleSkuSearch);
  els.toggleAllFilteredSkuButton.addEventListener("click", toggleAllFilteredSkuResults);
  els.toggleCurrentSkuPageButton.addEventListener("click", toggleCurrentSkuPage);
  els.previousSkuPageButton.addEventListener("click", () => changeSkuSelectionPage(-1));
  els.nextSkuPageButton.addEventListener("click", () => changeSkuSelectionPage(1));
  els.skuSelectionDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelSkuSelection();
  });
  els.skuSelectionDialog.addEventListener("click", (event) => {
    if (event.target === els.skuSelectionDialog) cancelSkuSelection();
  });
  const resultResizeObserver = new ResizeObserver(updateResultPageCapacity);
  resultResizeObserver.observe(els.resultListViewport);
  requestAnimationFrame(updateResultPageCapacity);
}

function switchSourceMode(mode) {
  if (batchSemanticActionsBlocked(state, curtainProductDirectorySelection)) return;
  if (state.skuSelection || state.loadingDatabase) {
    invalidateSkuSelection();
    return;
  }
  if (mode === state.mode) return;
  state.mode = mode;
  state.rows = mode === "database" ? state.databaseRows : state.manualRows;
  setResultView("queue");
  applySourceMode();
  if (state.activeRun) {
    updateActiveRunPresentation(state.activeRun);
  } else {
    const completed = state.rows.filter((row) => row.status === "done").length;
    setProgress(completed, state.rows.length);
    setStatus(state.rows.length ? "待开始" : mode === "database" ? "请读取数据库" : "待选择");
  }
  renderQueue();
}

function applySourceMode() {
  const databaseMode = state.mode === "database";
  els.databaseModeButton.setAttribute("aria-pressed", String(databaseMode));
  els.manualModeButton.setAttribute("aria-pressed", String(!databaseMode));
  els.databaseControls.hidden = !databaseMode;
  els.manualControls.hidden = databaseMode;
  els.openMainPromptEditor.hidden = databaseMode;
  els.resetMainPrompt.hidden = databaseMode;
  applyDatabaseTaskControls();
}

function replaceDatabaseRows(rows) {
  state.databaseRows = rows;
  if (state.mode === "database") state.rows = state.databaseRows;
}

async function loadDatabaseJobs() {
  if (batchSemanticActionsBlocked(state, curtainProductDirectorySelection)) return;
  if (skuSelectionBlocksSemanticActions()) return;
  if (state.running || state.loadingDatabase || state.mode !== "database") return;
  const taskType = els.databaseTaskType.value;
  const productTask = taskType === "curtain_product";
  if (productTask && !hasCurtainProductOutputDirectory()) {
    setStatus("请先选择保存目录");
    return;
  }
  if (!productTask && !state.databaseOutputDirectory) {
    setStatus("请先选择保存目录");
    return;
  }
  state.loadingDatabase = true;
  refreshGenerationControls();
  const generationMode = els.databaseRunMode.value;
  const load = databaseLoadGuard.begin({ generationMode, taskType });
  els.loadDatabaseButton.disabled = true;
  els.databaseSummary.textContent = "读取中";
  setStatus("读取数据库");

  try {
    const response = await fetch(
      `/api/database/jobs?mode=${encodeURIComponent(generationMode)}&taskType=${encodeURIComponent(taskType)}`,
      { signal: load.controller.signal },
    );
    const data = await response.json().catch(() => ({}));
    if (!databaseLoadGuard.isCurrent(load)) return;
    if (!response.ok) throw new Error(readApiError(data));
    const databaseJobs = Array.isArray(data.jobs) ? data.jobs : [];
    const jobs = productTask
      ? filterCurtainProductJobs(databaseJobs, state.curtainProductProgress, generationMode, selectedCurtainProductHeading(), (job) => createCurtainProductOutput(job.factorySku, selectedCurtainProductHeading()).outputName)
      : filterJobsForProgress(databaseJobs, state.databaseProgress, generationMode, taskType);
    if (productTask) {
      await assertCurtainProductOutputsAvailable({
        directory: state.curtainProductOutputDirectory,
        jobs,
        progress: state.curtainProductProgress,
        generationMode,
        headingStyle: selectedCurtainProductHeading(),
        outputNameForJob: (job) => createCurtainProductOutput(job.factorySku, selectedCurtainProductHeading()).outputName,
      });
    } else if (generationMode !== "regenerate") {
      await assertDatabaseOutputsAvailable(
        state.databaseOutputDirectory,
        jobs,
        els.databaseSaveFormat.value,
        taskType,
        jobs.flatMap((job) => databaseOutputNamesForRow({ sku: job.factorySku }, els.databaseSaveFormat.value)),
      );
    }
    if (!databaseLoadGuard.isCurrent(load)) return;
    const directoryCompleted = databaseJobs.length - jobs.length;
    state.skuSelection = createSkuSelection(jobs, 50);
    state.skuSelectionContext = createSkuSelectionContext(generationMode, taskType);
    const progress = data.progress || {};
    els.databaseSummary.textContent = `${jobs.length} 个候选，目录已记录 ${directoryCompleted} 个，共 ${progress.total ?? databaseJobs.length} 个`;
    renderSkuSelection();
    if (!els.skuSelectionDialog.open) els.skuSelectionDialog.showModal();
    setStatus(jobs.length ? "请选择 SKU" : "没有待生成 SKU");
  } catch (error) {
    if (!databaseLoadGuard.isCurrent(load) || error.name === "AbortError") return;
    els.databaseSummary.textContent = "读取失败";
    setStatus(error.message || "数据库读取失败");
  } finally {
    if (databaseLoadGuard.finish(load)) {
      state.loadingDatabase = false;
      refreshGenerationControls();
    }
  }
}

function createSkuSelectionContext(generationMode, taskType) {
  return {
    sourceMode: state.mode,
    generationMode,
    taskType,
    saveFormat: databaseSaveFormatForTask(taskType, els.databaseSaveFormat.value),
    databaseOutputDirectory: state.databaseOutputDirectory,
    curtainProductOutputDirectory: state.curtainProductOutputDirectory,
    curtainProductHeading: selectedCurtainProductHeading(),
  };
}

function skuSelectionContextIsCurrent(context) {
  if (!context) return false;
  return context.sourceMode === state.mode
    && context.generationMode === els.databaseRunMode.value
    && context.taskType === els.databaseTaskType.value
    && context.saveFormat === databaseSaveFormatForTask(context.taskType, els.databaseSaveFormat.value)
    && context.databaseOutputDirectory === state.databaseOutputDirectory
    && context.curtainProductOutputDirectory === state.curtainProductOutputDirectory
    && context.curtainProductHeading === selectedCurtainProductHeading();
}

function skuSelectionBlocksSemanticActions() {
  return Boolean(state.loadingDatabase || state.skuSelection || els.skuSelectionDialog.open);
}

function renderSkuSelection() {
  if (!state.skuSelection) return;
  const view = skuSelectionPage(state.skuSelection);
  const counts = skuSelectionCounts(state.skuSelection);
  els.skuSelectionTitle.textContent = state.skuSelectionContext?.taskType === "curtain_product"
    ? "选择白底成品 SKU"
    : "选择场景替换 SKU";
  els.skuSelectionCounts.textContent = `已选 ${counts.selected} / 候选 ${counts.total} · 搜索结果 ${counts.filtered}`;
  els.skuSearchInput.value = state.skuSelection.search;
  els.skuSelectionList.replaceChildren();

  if (!view.pageItems.length) {
    const empty = document.createElement("span");
    empty.className = "sku-selection-empty";
    empty.textContent = "没有匹配的 SKU";
    els.skuSelectionList.append(empty);
  }

  for (const job of view.pageItems) {
    const label = document.createElement("label");
    label.className = "sku-selection-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.skuSelection.selected.has(String(job.factorySku || "").trim().toLowerCase());
    checkbox.addEventListener("change", () => {
      state.skuSelection = toggleSkuSelection(state.skuSelection, job.factorySku, checkbox.checked);
      renderSkuSelection();
    });
    const item = document.createElement("span");
    const details = [job.factoryName || job.factory, job.seriesName || job.series].filter(Boolean);
    item.textContent = details.length ? `${job.factorySku} · ${details.join(" · ")}` : String(job.factorySku);
    item.title = item.textContent;
    label.append(checkbox, item);
    els.skuSelectionList.append(label);
  }

  els.toggleAllFilteredSkuButton.textContent = counts.filtered > 0 && counts.filteredSelected === counts.filtered
    ? "取消全部搜索结果"
    : "全选全部搜索结果";
  els.toggleCurrentSkuPageButton.textContent = counts.currentPageItems > 0 && counts.currentPageSelected === counts.currentPageItems
    ? "取消当前页"
    : "全选当前页";
  els.skuPageIndicator.textContent = `${view.currentPage} / ${view.totalPages}`;
  els.previousSkuPageButton.disabled = view.currentPage <= 1;
  els.nextSkuPageButton.disabled = view.currentPage >= view.totalPages;
  els.confirmSkuSelectionButton.disabled = counts.selected === 0;
  els.confirmSkuSelectionButton.textContent = counts.selected ? `确认入队 (${counts.selected})` : "确认入队";
}

function handleSkuSearch() {
  if (!state.skuSelection) return;
  state.skuSelection = setSkuSearch(state.skuSelection, els.skuSearchInput.value);
  renderSkuSelection();
}

function toggleAllFilteredSkuResults() {
  if (!state.skuSelection) return;
  const counts = skuSelectionCounts(state.skuSelection);
  state.skuSelection = setAllFilteredSkuSelected(
    state.skuSelection,
    counts.filteredSelected !== counts.filtered || counts.filtered === 0,
  );
  renderSkuSelection();
}

function toggleCurrentSkuPage() {
  if (!state.skuSelection) return;
  const counts = skuSelectionCounts(state.skuSelection);
  state.skuSelection = setCurrentSkuPageSelected(
    state.skuSelection,
    counts.currentPageSelected !== counts.currentPageItems || counts.currentPageItems === 0,
  );
  renderSkuSelection();
}

function changeSkuSelectionPage(delta) {
  if (!state.skuSelection) return;
  const view = skuSelectionPage(state.skuSelection);
  state.skuSelection = setSkuSelectionPage(state.skuSelection, view.currentPage + delta);
  renderSkuSelection();
}

function clearSkuSelectionCandidate() {
  state.skuSelection = null;
  state.skuSelectionContext = null;
  if (els.skuSelectionDialog.open) els.skuSelectionDialog.close();
  refreshGenerationControls();
}

function cancelSkuSelection() {
  clearSkuSelectionCandidate();
  setStatus("已取消 SKU 选择");
}

function invalidateSkuSelection() {
  databaseLoadGuard.invalidate();
  state.loadingDatabase = false;
  if (state.skuSelection || els.skuSelectionDialog.open) clearSkuSelectionCandidate();
  else refreshGenerationControls();
}

function confirmSkuSelection() {
  if (!state.skuSelection) return;
  if (!skuSelectionContextIsCurrent(state.skuSelectionContext)) {
    clearSkuSelectionCandidate();
    els.databaseSummary.textContent = "请重新读取";
    setStatus("设置或目录已变化，请重新读取数据库");
    return;
  }
  const jobs = selectedSkuJobs(state.skuSelection);
  if (!jobs.length) return;
  const context = state.skuSelectionContext;
  const candidateCount = state.skuSelection.jobs.length;
  const { generationMode, taskType } = context;
  const rows = jobs.map((job) => createDatabaseRow(job, generationMode, databaseSaveFormatForTask(taskType, els.databaseSaveFormat.value), taskType));
  clearSkuSelectionCandidate();
  replaceDatabaseRows(rows);
  state.pages = { queue: 1, completed: 1 };
  state.resultView = "queue";
  els.databaseSummary.textContent = `已选择 ${rows.length} / 候选 ${candidateCount}`;
  setProgress(0, rows.length);
  setStatus("待开始");
  renderQueue();
}

async function selectDatabaseOutputDirectory() {
  if (batchSemanticActionsBlocked(state, curtainProductDirectorySelection)) return;
  if (!canStartDirectorySelection(state, curtainProductDirectorySelection)) return;
  if (!window.showDirectoryPicker) {
    setStatus("当前浏览器不支持选择文件夹");
    return;
  }

  let accepted = false;
  try {
    await curtainProductDirectorySelection.run(async () => {
      accepted = true;
      setCurtainProductDirectorySelectionBusy(true);
      try {
        const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        const progress = await readDatabaseProgress(directoryHandle);
        invalidateSkuSelection();
        state.databaseOutputDirectory = directoryHandle;
        state.databaseProgress = progress;
        state.progressWriteQueue = Promise.resolve();
        resetDatabaseRows();
        const completed = completedDatabaseCount(els.databaseTaskType.value);
        els.databaseOutputSummary.textContent = `${directoryHandle.name} · 已记录 ${completed} 个`;
        els.databaseSummary.textContent = "请读取数据库";
        setStatus("保存目录已选择");
      } catch (error) {
        if (error.name === "AbortError") {
          setStatus("已取消选择文件夹");
          return;
        }
        setStatus(error.message || "读取保存目录失败");
      } finally {
        setCurtainProductDirectorySelectionBusy(false);
      }
    });
  } finally {
    if (accepted) refreshGenerationControls();
  }
}

async function selectCurtainProductDirectory() {
  if (batchSemanticActionsBlocked(state, curtainProductDirectorySelection)) return;
  if (!canStartDirectorySelection(state, curtainProductDirectorySelection)) return;
  if (!window.showDirectoryPicker) {
    setStatus("当前浏览器不支持选择文件夹");
    return;
  }

  let accepted = false;
  try {
    await curtainProductDirectorySelection.run(async () => {
      accepted = true;
      setCurtainProductDirectorySelectionBusy(true);
      try {
        const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        const progress = await readCurtainProductProgress(directoryHandle);
        invalidateSkuSelection();
        state.curtainProductOutputDirectory = directoryHandle;
        state.curtainProductProgress = progress;
        resetDatabaseRows();
        updateCurtainProductDirectorySummaries();
        els.databaseSummary.textContent = "请读取数据库";
        setStatus("保存目录已选择");
      } catch (error) {
        if (error.name === "AbortError") {
          setStatus("已取消选择文件夹");
          return;
        }
        setStatus(error.message || "读取保存目录失败");
      } finally {
        setCurtainProductDirectorySelectionBusy(false);
      }
    });
  } finally {
    if (accepted) refreshGenerationControls();
  }
}

function setCurtainProductDirectorySelectionBusy(selecting) {
  const semanticBusy = selecting
    || curtainProductDirectorySelection.isActive()
    || state.startingRun
    || skuSelectionBlocksSemanticActions();
  const directoryDisabled = semanticBusy || state.running || state.loadingDatabase;
  els.generateButton.disabled = semanticBusy || Boolean(state.activeRun?.transitioning);
  els.loadDatabaseButton.disabled = semanticBusy || state.running || state.loadingDatabase;
  els.databaseRunMode.disabled = semanticBusy || state.running;
  els.databaseTaskType.disabled = semanticBusy || state.running;
  els.databaseSaveFormat.disabled = semanticBusy || state.running || els.databaseTaskType.value === "curtain_product";
  els.manualModeButton.disabled = semanticBusy;
  els.databaseModeButton.disabled = semanticBusy;
  els.selectDatabaseOutputButton.disabled = directoryDisabled;
  els.selectCurtainProductDirectoryButton.disabled = directoryDisabled;
  els.curtainProductHeading.disabled = semanticBusy || state.running;
}

function handleDatabaseRunModeChange() {
  if (batchSemanticActionsBlocked(state, curtainProductDirectorySelection)) return;
  if (state.running) return;
  invalidateSkuSelection();
  invalidateDatabaseLoad();
}

function handleDatabaseTaskTypeChange() {
  if (batchSemanticActionsBlocked(state, curtainProductDirectorySelection)) return;
  if (state.running) return;
  invalidateSkuSelection();
  invalidateDatabaseLoad();
  applyDatabaseTaskControls();
  updateDatabaseDirectorySummaries();
}

function handleCurtainProductHeadingChange() {
  if (batchSemanticActionsBlocked(state, curtainProductDirectorySelection) || state.running) return;
  invalidateSkuSelection();
  resetDatabaseRows();
  updateCurtainProductDirectorySummaries();
  els.databaseSummary.textContent = "请重新读取";
}

function applyDatabaseTaskControls() {
  const controls = databaseTaskControlState(els.databaseTaskType.value);
  const sizeControls = generationSizeControlState(
    state.mode,
    els.databaseTaskType.value,
    localStorage.getItem(SIZE_KEY) || "2048x2048",
  );
  els.databaseSceneOutputControls.hidden = !controls.showSceneDirectory;
  els.curtainProductDirectoryControls.hidden = !controls.showProductDirectories;
  els.databaseSaveFormatField.hidden = !controls.showSaveFormat;
  els.databaseSaveFormat.disabled = controls.saveFormatDisabled || state.running;
  updateSizeOptionAvailability(sizeControls.value);
  els.sizeInput.value = sizeControls.value;
  els.sizeInput.disabled = sizeControls.disabled || state.running;
}

function updateSizeOptionAvailability(selectedSize) {
  const databaseProduct = state.mode === "database" && els.databaseTaskType.value === "curtain_product";
  for (const option of els.sizeInput.options) {
    option.disabled = databaseProduct && !["2048x2048", "2880x2880"].includes(option.value);
  }
  if (databaseProduct && !["2048x2048", "2880x2880"].includes(selectedSize)) {
    els.sizeInput.value = "2048x2048";
  }
}

function hasCurtainProductOutputDirectory() {
  return Boolean(state.curtainProductOutputDirectory);
}

function updateDatabaseDirectorySummaries() {
  els.databaseOutputSummary.textContent = state.databaseOutputDirectory
    ? `${state.databaseOutputDirectory.name} · 已记录 ${completedDatabaseCount("scene_replacement")} 个`
    : "未选择";
  updateCurtainProductDirectorySummaries();
}

function updateCurtainProductDirectorySummaries() {
  const completed = completedCurtainProductCount();
  els.curtainProductDirectorySummary.textContent = state.curtainProductOutputDirectory
    ? `${state.curtainProductOutputDirectory.name} · 已记录 ${completed} 个`
    : "未选择";
}

function completedCurtainProductCount() {
  if (!state.curtainProductProgress) return 0;
  const completed = state.curtainProductProgress.completed?.curtain_product || {};
  return Object.entries(completed).filter(([sku, record]) => (
    record?.files?.includes(createCurtainProductOutput(sku, selectedCurtainProductHeading()).outputName)
  )).length;
}

function selectedCurtainProductHeading() {
  return els.curtainProductHeading.value === "doublePinch" ? "doublePinch" : "grommet";
}

function invalidateDatabaseLoad() {
  databaseLoadGuard.invalidate();
  state.loadingDatabase = false;
  if (state.skuSelection || els.skuSelectionDialog.open) clearSkuSelectionCandidate();
  else refreshGenerationControls();
  resetDatabaseRows();
  els.databaseSummary.textContent = "请重新读取";
  setStatus("请读取数据库");
}

function completedDatabaseCount(taskType) {
  return Object.keys(state.databaseProgress.completed?.[taskType] || {}).length;
}

function resetDatabaseRows() {
  state.databaseRows = [];
  if (state.mode === "database") state.rows = state.databaseRows;
  state.pages = { queue: 1, completed: 1 };
  state.resultView = "queue";
  setProgress(0, 0);
  renderQueue();
}

function handleDatabaseSaveFormatChange() {
  if (batchSemanticActionsBlocked(state, curtainProductDirectorySelection)) return;
  invalidateSkuSelection();
  for (const row of state.databaseRows) {
    const saveFormat = databaseSaveFormatForTask(row.taskType, els.databaseSaveFormat.value);
    row.displayName = databaseOutputLabel(row.sku, saveFormat, row.taskType);
  }
  if (state.mode === "database") renderQueue();
}

function createDatabaseRow(job, generationMode, saveFormat, taskType) {
  const productOutput = taskType === "curtain_product"
    ? createCurtainProductOutput(job.factorySku, selectedCurtainProductHeading())
    : null;
  return {
    source: "database",
    job,
    sku: job.factorySku,
    taskType,
    outputName: productOutput?.outputName || buildOutputName(job.factorySku, "_sence", "jpg"),
    displayName: databaseOutputLabel(job.factorySku, saveFormat, taskType),
    previewUrl: job.detailAssetUrl,
    seriesSceneAssetUrl: job.seriesSceneAssetUrl,
    patternRepeatVerticalCm: job.patternRepeatVerticalCm,
    patternRepeatHorizontalCm: job.patternRepeatHorizontalCm,
    generationMode,
    status: "pending",
    selected: true,
    imageDataUrl: "",
    headingStyle: taskType === "curtain_product" ? selectedCurtainProductHeading() : "",
    productOutput,
    sceneImageUrl: "",
    error: "",
    historyEntry: null,
    historyError: "",
  };
}

function handleFabricChange(event) {
  const files = imageFilesFromSelection(event.target.files || []);
  const result = appendFabricFiles(files);
  updateFabricSelectionSummary(event.target, files, result);
  event.target.value = "";
}

function updateFabricSelectionSummary(input, files, result) {
  const summary = input === els.fabricFolderInput ? els.fabricFolderInputSummary : els.fabricInputSummary;
  summary.title = "";
  if (result?.rejected.length) {
    const [{ file, outputName }] = result.rejected;
    summary.title = `${file.name} → ${outputName} 重复`;
    summary.textContent = result.added.length
      ? `上传 ${result.added.length}，跳过 ${result.rejected.length}：输出名重复`
      : "已跳过：输出名重复";
    return;
  }

  if (input === els.fabricFolderInput) {
    if (!files.length) {
      els.fabricFolderInputSummary.textContent = "文件夹中没有图片";
      return;
    }
    const relativePath = files[0].webkitRelativePath || "";
    const folderName = relativePath.split("/")[0] || "所选文件夹";
    els.fabricFolderInputSummary.textContent = `${folderName} 已上传 · ${files.length} 个图片`;
    return;
  }

  if (!files.length) {
    els.fabricInputSummary.textContent = "未找到图片";
  } else if (files.length === 1) {
    els.fabricInputSummary.textContent = `${files[0].name} 已上传`;
  } else {
    els.fabricInputSummary.textContent = `${files.length} 个文件已上传`;
  }
}

function appendFabricFiles(files) {
  if (!files.length) return { files: state.fabricFiles, added: [], rejected: [] };
  const result = appendFilesWithUniqueOutputNames(
    state.fabricFiles,
    files,
    (file) => manualCurtainProductOutputNames(file.name, selectedManualCurtainProductHeadings()),
  );
  state.fabricFiles = result.files;
  state.stagedFabricFiles.push(...result.added);
  return result;
}

function addManualTasks() {
  const files = state.stagedFabricFiles.splice(0);
  const headings = selectedManualCurtainProductHeadings();
  if (!files.length || !headings.length) return false;
  const taskSettings = {
    fabricCatalogRoot: selectedManualFabricCatalogRoot(),
    fabricSampleSizeCm: selectedManualFabricSampleSize(),
    quality: els.qualityInput.value,
    size: els.sizeInput.value,
  };
  const rows = expandManualCurtainRows(files, headings, createFabricRow);
  applyUploadBatch(rows, createNextUploadBatch({ sourceLabel: "白底图生成", taskCount: rows.length }));
  rows.forEach((row) => {
    row.taskSettings = { ...taskSettings };
    void hydrateManualPreview(row);
  });
  state.manualRows.push(...rows);
  void hydrateManualFabricMetadata(rows, taskSettings.fabricSampleSizeCm, taskSettings.fabricCatalogRoot);
  if (state.mode === "manual") state.rows = state.manualRows;
  setStatus(`已添加 ${rows.length} 个任务`);
  renderQueue();
  return true;
}

function createFabricRow(file, headingStyle) {
  return {
    source: "manual",
    file,
    sku: skuFromFabricName(file.name),
    outputName: manualCurtainProductOutputName(file.name, headingStyle),
    headingStyle,
    previewUrl: isHeicFile(file) ? "" : nativePreviewUrl(file),
    status: "pending",
    selected: true,
    imageDataUrl: "",
    error: "",
    historyEntry: null,
    historyError: "",
    fabricMetadata: null,
    fabricMetadataError: "",
  };
}

async function hydrateManualFabricMetadata(rows, fallbackSampleSizeCm, fabricCatalogRoot) {
  try {
    const response = await fetch("/api/manual-product/fabric-metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fabricCatalogRoot,
        fallbackSampleSizeCm,
        fileNames: [...new Set(rows.map((row) => row.file.name))],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(readApiError(data));
    const resultByName = new Map((data.items || []).map((item) => [item.fileName, item]));
    for (const row of rows) {
      const result = resultByName.get(row.file.name);
      if (result?.ok) {
        row.fabricMetadata = result.metadata;
        row.fabricMetadataError = "";
        row.sku = result.metadata.sku || row.sku;
      } else {
        row.fabricMetadata = null;
        row.fabricMetadataError = result?.error || "面料信息预检失败";
      }
    }
  } catch (error) {
    for (const row of rows) row.fabricMetadataError = error.message || "面料信息预检失败";
  }
  renderQueue();
}

async function hydrateManualPreview(row) {
  if (!isHeicFile(row.file)) return;
  try {
    row.previewUrl = await previewUrlForFile(row.file);
  } catch (error) {
    row.error = error.message || "HEIC 预览转换失败";
  }
  renderQueue();
}

function selectedManualCurtainProductHeadings() {
  return normalizeManualCurtainHeadingStyles(
    els.manualCurtainProductHeadings.filter((input) => input.checked).map((input) => input.value),
  );
}

function selectedManualFabricSampleSize() {
  return els.manualFabricSampleSize.value === "15" ? 15 : 10;
}

function selectedManualFabricCatalogRoot() {
  return els.manualFabricCatalogRoot.value.trim() || DEFAULT_MANUAL_FABRIC_CATALOG_ROOT;
}

function updateOutputNamePreview() {
  const row = state.rows.find((item) => item.outputName);
  if (row) {
    els.outputNamePreview.textContent = row.outputName;
    return;
  }
  if (state.mode === "manual") {
    const [headingStyle] = selectedManualCurtainProductHeadings();
    els.outputNamePreview.textContent = manualCurtainProductOutputName("sample-sku_detail.jpg", headingStyle || "grommet");
    return;
  }
  els.outputNamePreview.textContent = databaseOutputLabel("sample-sku", els.databaseSaveFormat.value, els.databaseTaskType.value);
}

function outputNameForRow(row) {
  if (row.taskType === "scene_replacement") return buildOutputName(row.sku, "_sence", "jpg");
  if (row.source === "manual") return manualCurtainProductOutputName(row.file.name, row.headingStyle);
  return createCurtainProductOutput(row.sku, row.headingStyle || selectedCurtainProductHeading()).outputName;
}

function manualCurtainProductOutputName(fileName, headingStyle) {
  const sku = skuFromFabricName(fileName);
  const heading = headingStyle === "doublePinch" ? "double-pinch" : "grommet";
  return buildOutputName(sku, `_${heading}`, "webp");
}

function manualCurtainProductOutputNames(fileName, headingStyles) {
  return headingStyles.map((headingStyle) => manualCurtainProductOutputName(fileName, headingStyle));
}

function manualCurtainRowKey(file, headingStyle) {
  return `${String(file?.name || "").toLocaleLowerCase("en-US")}\u0000${headingStyle}`;
}

function handleManualHeadingOptionsChange(event) {
  if (!selectedManualCurtainProductHeadings().length) {
    event.currentTarget.checked = true;
  }
  updateOutputNamePreview();
}

function handleManualProductOptionsChange() {
  renderQueue();
}

async function handleGenerate(event) {
  event.preventDefault();
  if (batchSemanticActionsBlocked(state, curtainProductDirectorySelection) || skuSelectionBlocksSemanticActions()) return;
  const accepted = state.mode === "manual" ? addManualTasks() : state.databaseRows.length > 0;
  if (!accepted) {
    setStatus(state.mode === "manual" ? "请选择面料图" : "请先读取并确认 SKU");
    return;
  }
  els.mainTaskDialog.close();
}

async function handlePauseGeneration(requestedAction) {
  const run = state.activeRun;
  if (!run || run.transitioning) return false;
  if (requestedAction === "pause" || (!requestedAction && !run.paused)) await pauseGenerationRun(run);
  else await resumeGenerationRun(run);
  return true;
}

async function openMainPromptEditor() {
  if (state.mode !== "manual") return;
  try {
    await loadMainPromptEditorKind();
    els.mainPromptEditorDialog.showModal();
  } catch (error) {
    setStatus(error.message || "读取内置提示词失败");
  }
}

async function saveMainPromptEditor() {
  els.saveMainPromptEditor.disabled = true;
  try {
    els.mainPromptEditorInput.value = await saveEditablePromptTemplate(
      selectedMainPromptEditorKind(),
      els.mainPromptEditorInput.value,
    );
    els.mainPromptEditorDialog.close();
    setStatus("白底图提示词已保存");
  } catch (error) {
    setStatus(error.message || "提示词保存失败");
  } finally {
    els.saveMainPromptEditor.disabled = false;
  }
}

async function resetMainPrompt() {
  if (!window.confirm("确认恢复白底图的源码默认提示词吗？当前保存的白底图提示词将被清除。")) return;
  els.resetMainPrompt.disabled = true;
  try {
    await resetEditablePromptTemplate(selectedMainPromptEditorKind());
    await loadMainPromptEditorKind();
    setStatus("白底图提示词已恢复为源码默认值");
  } catch (error) {
    setStatus(error.message || "恢复默认提示词失败");
  } finally {
    els.resetMainPrompt.disabled = false;
  }
}

function selectedMainPromptEditorKind() {
  return els.mainPromptEditorKind.value === "manual_product_repeat"
    ? "manual_product_repeat"
    : "manual_product_plain";
}

async function loadMainPromptEditorKind() {
  els.mainPromptEditorInput.value = await fetchEditablePromptTemplate(selectedMainPromptEditorKind());
}

async function generateManualRows() {
  const rows = state.manualRows.filter((row) => row.status === "pending");
  if (!rows.length) {
    setStatus(state.manualRows.length ? "没有可追加的面料" : "请选择面料图");
    return false;
  }
  const blockedRows = rows.filter((row) => row.fabricMetadataError);
  if (blockedRows.length) {
    setStatus(`有 ${blockedRows.length} 个面料 SKU/花位信息预检失败，请先处理后再生成`);
    renderQueue();
    return false;
  }

  const groups = new Map();
  for (const row of rows) {
    const settings = row.taskSettings || {};
    const key = JSON.stringify(settings);
    if (!groups.has(key)) groups.set(key, { settings, rows: [] });
    groups.get(key).rows.push(row);
  }
  for (const { rows: groupRows, settings } of groups.values()) {
    runGenerationQueue(groupRows, generateManualRow, settings);
  }
  return true;
}

async function startMainQueuedTasks() {
  if (state.startingRun || skuSelectionBlocksSemanticActions()) return false;
  const hasManual = state.manualRows.some((row) => row.status === "pending");
  const hasDatabase = state.databaseRows.some((row) => row.status === "pending");
  if (!hasManual && !hasDatabase) return false;
  if (!beginStartingRun(state)) return false;
  refreshGenerationControls();
  try {
    let started = false;
    if (hasManual) started = await generateManualRows() || started;
    if (hasDatabase) started = await generateDatabaseRows() || started;
    return started;
  } finally {
    finishStartingRun(state);
    refreshGenerationControls();
  }
}

async function generateDatabaseRows() {
  const taskType = els.databaseTaskType.value;
  const productTask = taskType === "curtain_product";
  const curtainProductOutputDirectory = productTask ? state.curtainProductOutputDirectory : null;
  const curtainProductHeading = productTask ? selectedCurtainProductHeading() : "";
  if (productTask && !curtainProductOutputDirectory) {
    setStatus("请先选择保存目录");
    return false;
  }
  if (!productTask && !state.databaseOutputDirectory) {
    setStatus("请先选择保存目录");
    return false;
  }
  const rows = state.databaseRows.filter((row) => row.status === "pending");
  if (!rows.length) {
    setStatus(state.databaseRows.length ? "没有可追加的 SKU" : "请先读取数据库");
    return false;
  }
  const regenerate = rows[0].generationMode === "regenerate";
  try {
    if (productTask) {
      if (!regenerate) {
        await assertCurtainProductOutputsAvailable({
          directory: curtainProductOutputDirectory,
          jobs: rows.map((row) => row.job),
          progress: state.curtainProductProgress,
          generationMode: rows[0].generationMode,
          headingStyle: curtainProductHeading,
          outputNameForJob: (job) => createCurtainProductOutput(job.factorySku, curtainProductHeading).outputName,
        });
      }
    } else if (!regenerate) {
      await assertDatabaseOutputsAvailable(
        state.databaseOutputDirectory,
        rows.map((row) => row.job),
        els.databaseSaveFormat.value,
        rows[0].taskType,
        rows.flatMap((row) => databaseOutputNamesForRow(row, els.databaseSaveFormat.value)),
      );
    }
  } catch (error) {
    setStatus(error.message || "输出文件冲突");
    return false;
  }
  const confirmation = state.running
    ? `将 ${rows.length} 个 SKU 追加到当前生成队列末尾，是否继续？`
    : regenerate
    ? `将重新生成 ${rows.length} 个 SKU，并覆盖所选目录中的同名文件，是否继续？`
    : `将继续生成 ${rows.length} 个未完成 SKU。成功项会立即保存并记录，是否继续？`;
  if (!window.confirm(confirmation)) {
    setStatus("已取消");
    return false;
  }

  if (productTask) {
    const unbatchedRows = rows.filter((row) => !row.uploadBatchId);
    if (unbatchedRows.length) applyUploadBatch(unbatchedRows, createNextUploadBatch({ sourceLabel: "数据库白底图生成", taskCount: unbatchedRows.length }));
    runGenerationQueue(rows, generateDatabaseRow, { curtainProductOutputDirectory, curtainProductHeading });
  } else {
    const unbatchedRows = rows.filter((row) => !row.uploadBatchId);
    if (unbatchedRows.length) applyUploadBatch(unbatchedRows, createNextUploadBatch({ sourceLabel: "数据库场景图生成", taskCount: unbatchedRows.length }));
    runGenerationQueue(rows, generateDatabaseRow);
  }
  return true;
}

function runGenerationQueue(rows, generateRow, extraSettings = {}) {
  const prompt = state.mode === "database" ? els.promptInput.value : "";
  const settings = {
    apiKey: readApiKey(),
    prompt,
    quality: els.qualityInput.value,
    size: els.sizeInput.value,
    ...extraSettings,
  };
  localStorage.setItem(PROMPT_KEY, prompt);

  let run = state.activeRun;
  if (!run) {
    run = {
      rows: [],
      total: 0,
      completed: 0,
      failed: 0,
      obsolete: 0,
      paused: false,
      pauseRequested: false,
      pauseError: "",
      transitioning: false,
      queue: null,
      batchPromise: createBackendGenerationBatch(),
    };
    run.queue = createGenerationQueue({
      concurrency: readSharedConcurrency(),
      worker: (task) => processGenerationTask(run, task),
      onIdle: () => finishGenerationRun(run),
    });
    state.activeRun = run;
    state.running = true;
    setBusy(true);
  }

  for (const row of rows) {
    row.status = "queued";
    row.error = "";
    row.historyEntry = null;
    row.historyError = "";
  }
  run.rows.push(...rows);
  run.total += rows.length;
  const queuedSettings = { ...settings, batchPromise: run.batchPromise };
  run.queue.enqueue(rows.map((row) => ({ row, generateRow, settings: queuedSettings })));
  updateActiveRunPresentation(run);
  renderQueue();
}

async function processGenerationTask(run, { row, generateRow, settings }) {
  try {
    await generateRow(row, {
      ...settings,
      onJobStatus: (status, jobId) => {
        row.generationJobId = jobId;
        applyBackendJobStatus(row, status, run.paused || run.pauseRequested);
        scheduleQueueRender();
      },
    });
    row.status = "done";
  } catch (error) {
    if (error.code === "OBSOLETE_SCENE") {
      row.status = "pending";
      row.selected = true;
      row.imageDataUrl = "";
      row.error = "";
      run.obsolete += 1;
    } else {
      row.status = "error";
      row.error = error.message || "生成失败";
      run.failed += 1;
    }
  }

  run.completed += 1;
  updateActiveRunPresentation(run);
  if (row.source === "database") {
    updateDatabaseRunSummary(run.rows.filter((item) => item.source === "database"));
  }
  scheduleQueueRender();
}

function finishGenerationRun(run) {
  if (state.activeRun !== run) return;
  state.running = false;
  state.activeRun = null;
  setBusy(false);
  renderQueue();
  updateDownloadButton();
  setProgress(run.completed, run.total);
  const historyFailed = run.rows.filter((row) => row.status === "done" && row.historyError).length;
  const completionDetails = [
    run.failed ? `失败 ${run.failed}` : "",
    historyFailed ? `历史保存失败 ${historyFailed}` : "",
  ].filter(Boolean).join("，");
  setStatus(run.obsolete
    ? "场景已更换，请重新生成"
    : completionDetails ? `完成 ${run.total - run.failed}，${completionDetails}` : "已完成");
}

function updateActiveRunPresentation(run) {
  setProgress(run.completed, run.total);
  if (run.paused || run.pauseRequested) {
    const warning = run.pauseError ? `；${run.pauseError}` : "";
    setStatus(`已暂停，已完成 ${run.completed} / ${run.total}${warning}`);
    return;
  }
  setStatus(`生成中 ${run.completed} / ${run.total}`);
}

async function pauseGenerationRun(run) {
  if (state.activeRun !== run || run.transitioning) return;
  run.transitioning = true;
  run.pauseRequested = true;
  run.pauseError = "";
  run.queue.pause();
  markRowsPaused(run.rows);
  setBusy(true);
  updateActiveRunPresentation(run);
  renderQueue();

  try {
    const batch = await controlBackendBatch(run, "pause");
    const queuedJobIds = new Set(batch.queuedJobIds || []);
    markRowsPaused(run.rows.filter((row) => !row.generationJobId || queuedJobIds.has(row.generationJobId)));
    run.paused = true;
  } catch (error) {
    run.paused = true;
    run.pauseError = `后端暂停失败：${error.message || "未知错误"}`;
  } finally {
    run.pauseRequested = false;
    run.transitioning = false;
    setBusy(true);
    updateActiveRunPresentation(run);
    renderQueue();
  }
}

async function resumeGenerationRun(run) {
  if (state.activeRun !== run || run.transitioning) return;
  run.transitioning = true;
  setBusy(true);

  try {
    await controlBackendBatch(run, "resume");
    run.paused = false;
    run.pauseError = "";
    markRowsResumed(run.rows);
    run.queue.resume();
  } catch (error) {
    run.pauseError = `继续失败：${error.message || "未知错误"}`;
  } finally {
    run.transitioning = false;
    setBusy(true);
    updateActiveRunPresentation(run);
    renderQueue();
  }
}

async function controlBackendBatch(run, action) {
  const batchId = await run.batchPromise;
  const response = await fetch(`/api/generation-batches/${batchId}/${action}`, { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readApiError(data));
  return data;
}

function updateDatabaseRunSummary(rows) {
  const done = rows.filter((row) => row.status === "done").length;
  const failed = rows.filter((row) => row.status === "error").length;
  const historyFailed = rows.filter((row) => row.status === "done" && row.historyError).length;
  const failures = [
    failed ? `失败 ${failed}` : "",
    historyFailed ? `历史保存失败 ${historyFailed}` : "",
  ].filter(Boolean).join("，");
  els.databaseSummary.textContent = `本次已记录 ${done} / ${rows.length}${failures ? `，${failures}` : ""}`;
}

async function generateManualRow(row, settings) {
  const fabricDataUrl = await fileToDataUrl(row.file);
  const fabricPayload = {
    name: row.file.name,
    type: row.file.type,
    dataUrl: fabricDataUrl,
  };
  const result = await requestManualCurtainProductGeneration({
    ...settings,
    clientHistory: true,
    fabric: fabricPayload,
    headingStyle: row.headingStyle,
    outputName: row.outputName,
  });
  row.imageDataUrl = result.imageDataUrl;
  row.outputName = result.outputName || manualCurtainProductOutputName(row.file.name, row.headingStyle);
  row.displayName = row.outputName;
  try {
    row.historyEntry = await saveLocalHistoryEntry({
      taskType: "curtain_product",
      sku: row.sku,
      outputName: row.outputName,
      resultUrl: row.imageDataUrl,
      fabricUrl: fabricDataUrl,
      prompt: "",
      product: { headingStyle: row.headingStyle, fabricSampleSizeCm: settings.fabricSampleSizeCm },
      uploadBatchId: row.uploadBatchId,
      uploadBatchLabel: row.uploadBatchLabel,
      uploadBatchCreatedAt: row.uploadBatchCreatedAt,
    });
    row.historyError = "";
  } catch (error) {
    row.historyEntry = null;
    row.historyError = error.message || "本地历史保存失败";
  }
}

async function generateDatabaseRow(row, settings) {
  if (row.taskType === "curtain_product") {
    await generateCurtainProductRow(row, settings);
    return;
  }
  await generateSceneDatabaseRow(row, settings);
}

async function generateSceneDatabaseRow(row, settings) {
  const result = await requestDatabaseGeneration({
    ...settings,
    clientHistory: true,
    factorySku: row.job.factorySku,
    generationMode: row.generationMode,
    outputName: row.outputName,
  }, row.taskType);
  const jpegDataUrl = await convertToJpegDataUrl(result.imageDataUrl);
  const files = await recordDatabaseCompletion(row, {
    jpegDataUrl,
    webpDataUrl: result.imageDataUrl,
  });
  row.imageDataUrl = jpegDataUrl;
  row.savedFiles = files;
  try {
    row.historyEntry = await saveLocalHistoryEntry({
      taskType: "scene_replacement",
      sku: row.sku,
      outputName: row.outputName,
      prompt: settings.prompt || "",
      resultUrl: jpegDataUrl,
      sceneUrl: row.seriesSceneAssetUrl,
      fabricUrl: row.previewUrl,
      uploadBatchId: row.uploadBatchId,
      uploadBatchLabel: row.uploadBatchLabel,
      uploadBatchCreatedAt: row.uploadBatchCreatedAt,
    });
    row.historyError = "";
  } catch (error) {
    row.historyEntry = null;
    row.historyError = error.message || "本地历史保存失败";
  }
}

async function generateCurtainProductRow(row, settings) {
  const result = await requestDatabaseGeneration({
    ...settings,
    clientHistory: true,
    factorySku: row.job.factorySku,
    generationMode: row.generationMode,
    headingStyle: row.headingStyle,
    outputName: row.outputName,
  }, "curtain_product");
  const committed = await commitCurtainProductResult({
    directory: settings.curtainProductOutputDirectory,
    sku: row.sku,
    outputName: result.output.outputName,
    imageDataUrl: result.output.imageDataUrl,
    generationMode: row.generationMode,
    progress: state.curtainProductProgress,
    row,
  });
  state.curtainProductProgress = committed.progress;
  row.productOutput = result.output;
  row.imageDataUrl = result.output.imageDataUrl;
  row.outputName = result.output.outputName;
  row.displayName = result.output.outputName;
  row.savedFiles = committed.files;
  updateCurtainProductDirectorySummaries();

  if (!committed.alreadyComplete) {
    try {
      row.historyEntry = await saveLocalHistoryEntry({
        taskType: "curtain_product",
        sku: row.sku,
        outputName: row.outputName,
        prompt: settings.prompt || "",
        effectivePrompt: result.effectivePrompt || "",
        resultUrl: row.imageDataUrl,
        fabricUrl: row.previewUrl,
        product: result.product || { headingStyle: row.headingStyle },
        uploadBatchId: row.uploadBatchId,
        uploadBatchLabel: row.uploadBatchLabel,
        uploadBatchCreatedAt: row.uploadBatchCreatedAt,
      });
      row.historyError = "";
    } catch (error) {
      row.historyEntry = null;
      row.historyError = error.message || "本地历史保存失败";
    }
  }
}

async function recordDatabaseCompletion(row, imageData) {
  const writeTask = state.progressWriteQueue.catch(() => {}).then(async () => {
    const committed = await commitDatabaseResult({
      directoryHandle: state.databaseOutputDirectory,
      sku: row.sku,
      format: els.databaseSaveFormat.value,
      taskType: row.taskType,
      generationMode: row.generationMode,
      progress: state.databaseProgress,
      row,
      outputNames: databaseOutputNamesForRow(row, els.databaseSaveFormat.value),
      ...imageData,
    });
    state.databaseProgress = committed.progress;
    return committed.files;
  });
  state.progressWriteQueue = writeTask;
  return writeTask;
}

async function checkModel() {
  setStatus("检查中");
  try {
    const response = await fetch("/api/models", {
      headers: apiHeaders(readApiKey()),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(readApiError(data));
    }
    const ids = Array.isArray(data.data) ? data.data.map((item) => item.id) : [];
    setStatus(ids.includes("gpt-image-2") ? "模型可用" : "模型不可用");
  } catch (error) {
    setStatus(error.message || "检查失败");
  }
}

async function requestGeneration(payload) {
  const result = await requestQueuedGeneration("manual", payload);
  if (!result.imageDataUrl) throw new Error("没有返回图片");
  return result.imageDataUrl;
}

async function requestManualCurtainProductGeneration(payload) {
  const result = await requestQueuedGeneration("manual_product", payload);
  if (!result.imageDataUrl) throw new Error("没有返回白底成品图");
  return result;
}

async function requestDatabaseGeneration(payload, taskType = "scene_replacement") {
  const result = taskType === "curtain_product"
    ? await requestQueuedGeneration("database_product", payload)
    : await requestQueuedGeneration("database", payload);
  if (taskType === "curtain_product") {
    if (!result.output?.imageDataUrl || !result.output.outputName) throw new Error("没有返回产品图片");
    if (!result.effectivePrompt || (!payload.clientHistory && !result.generationId)) throw new Error("产品生成元数据不完整");
  } else if (!result.imageDataUrl) {
    throw new Error("没有返回图片");
  }
  return result;
}

async function createBackendGenerationBatch() {
  const response = await fetch("/api/generation-batches", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readApiError(data));
  if (!data.batchId) throw new Error("创建后端生成队列失败");
  return data.batchId;
}

async function requestQueuedGeneration(kind, payload) {
  const { apiKey, batchPromise, onJobStatus, ...generationPayload } = payload;
  const batchId = await batchPromise;
  const submitResponse = await fetch(`/api/generation-batches/${batchId}/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...apiHeaders(apiKey),
    },
    body: JSON.stringify({ kind, payload: generationPayload }),
  });
  const submitted = await submitResponse.json().catch(() => ({}));
  if (!submitResponse.ok) throw new Error(readApiError(submitted));
  if (!submitted.jobId) throw new Error("提交生成任务失败");
  onJobStatus?.(submitted.status, submitted.jobId);
  return generationBatchPoller.waitFor(batchId, submitted.jobId, onJobStatus);
}

function apiHeaders(apiKey) {
  return apiKey ? { "x-api-key": apiKey } : {};
}

function renderQueue() {
  updateOutputNamePreview();
  els.queueList.innerHTML = "";
  els.completedList.innerHTML = "";
  const rows = displayRows();
  const { active, completed } = partitionQueueRows(rows);
  els.queueCount.textContent = String(active.length);
  els.completedCount.textContent = String(completed.length);

  const activeEmptyText = rows.length
    ? "当前没有未完成任务"
    : state.mode === "database" ? "尚未读取数据库" : "未选择面料图";
  const activePage = paginateRows(active, state.pages.queue, state.pageSize);
  const completedPage = paginateRows(completed, state.pages.completed, state.pageSize);
  state.pages.queue = activePage.currentPage;
  state.pages.completed = completedPage.currentPage;
  renderRows(activePage.rows, els.queueList, activeEmptyText);
  renderRows(completedPage.rows, els.completedList, "暂无已完成任务");
  applyResultView();
  updatePaginationControls(activePage, completedPage);
  updateDownloadButton();
  workspaceQueue.notify();
}

function displayRows() {
  return state.activeRun?.rows?.length ? state.activeRun.rows : state.rows;
}

function renderRows(rows, list, emptyText) {
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = emptyText;
    list.append(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("article");
    const productDone = row.taskType === "curtain_product" && row.status === "done" && row.imageDataUrl;
    item.className = "queue-row";

    const thumb = document.createElement("button");
    thumb.className = "thumb";
    thumb.type = "button";
    thumb.disabled = !row.imageDataUrl;
    const image = document.createElement("img");
    image.loading = "lazy";
    image.decoding = "async";
    image.src = row.imageDataUrl || row.previewUrl;
    image.alt = row.displayName || row.outputName;
    thumb.append(image);
    thumb.addEventListener("click", () => openPreview(row));
    const previewCell = thumb;

    const fileMain = document.createElement("div");
    fileMain.className = "file-main";
    const title = document.createElement("strong");
    title.textContent = row.displayName || row.outputName;
    const sub = document.createElement("span");
    sub.textContent = rowSubtitle(row);
    fileMain.append(title, sub);

    const status = document.createElement("div");
    status.className = `status ${row.status}`;
    status.textContent = statusText(row);

    const actions = document.createElement("div");
    actions.className = "result-actions";
    const zoomButton = document.createElement("button");
    zoomButton.className = "button";
    zoomButton.type = "button";
    zoomButton.textContent = "预览";
    zoomButton.disabled = !row.imageDataUrl;
    zoomButton.addEventListener("click", () => openPreview(row));
    const deleteButton = document.createElement("button");
    deleteButton.className = "button ghost";
    deleteButton.type = "button";
    deleteButton.textContent = "删除";
    deleteButton.disabled = state.running;
    deleteButton.addEventListener("click", () => removeFabricRow(row));
    actions.append(zoomButton, deleteButton);

    const selectCell = document.createElement("label");
    selectCell.className = "select-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = row.selected;
    checkbox.disabled = row.status !== "done" || row.taskType === "curtain_product";
    checkbox.addEventListener("change", () => {
      row.selected = checkbox.checked;
      updateDownloadButton();
    });
    selectCell.append(checkbox);

    item.append(previewCell, fileMain, status, actions, selectCell);
    list.append(item);
  }
}

function setResultView(view) {
  state.resultView = view === "completed" ? "completed" : "queue";
  renderQueue();
}

function applyResultView() {
  const completedView = state.resultView === "completed";
  els.queueViewButton.setAttribute("aria-selected", String(!completedView));
  els.completedViewButton.setAttribute("aria-selected", String(completedView));
  els.queueList.hidden = completedView;
  els.completedList.hidden = !completedView;
}

function updateResultPageCapacity() {
  const pageSize = pageCapacityForHeight(els.resultListViewport.clientHeight);
  if (pageSize === state.pageSize) return;
  state.pageSize = pageSize;
  renderQueue();
}

function changeResultPage(delta) {
  state.pages[state.resultView] += delta;
  renderQueue();
}

function updatePaginationControls(activePage, completedPage) {
  const page = state.resultView === "completed" ? completedPage : activePage;
  els.pageIndicator.textContent = `${page.currentPage} / ${page.totalPages}`;
  els.previousPageButton.disabled = page.currentPage <= 1;
  els.nextPageButton.disabled = page.currentPage >= page.totalPages;
}

function scheduleQueueRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderQueue();
  });
}

function removeFabricRow(row) {
  if (state.running) return;
  if (row.source === "manual" && row.previewUrl) URL.revokeObjectURL(row.previewUrl);
  state.rows = state.rows.filter((item) => item !== row);
  if (state.mode === "database") {
    state.databaseRows = state.rows;
  } else {
    state.manualRows = state.rows;
    state.fabricFiles = state.rows.map((item) => item.file).filter(Boolean);
  }
  setProgress(0, state.rows.length);
  setStatus(state.rows.length ? "待开始" : "待选择");
  renderQueue();
}

function removePendingMainTask(row) {
  if (!row || row.status !== "pending") return false;
  if (row.source === "manual") {
    if (!state.manualRows.includes(row)) return false;
    if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
    state.manualRows = state.manualRows.filter((item) => item !== row);
  } else {
    if (!state.databaseRows.includes(row)) return false;
    state.databaseRows = state.databaseRows.filter((item) => item !== row);
  }
  state.rows = state.mode === "manual" ? state.manualRows : state.databaseRows;
  updateOutputNamePreview();
  setStatus("已删除任务");
  renderQueue();
  return true;
}

function openPreview(row) {
  if (!row.imageDataUrl) return;
  openPreviewImage(row.imageDataUrl, row.displayName || row.outputName);
}

function openPreviewImage(imageDataUrl, title) {
  if (!imageDataUrl) return;
  previewViewer.open({ src: imageDataUrl, name: title });
}

function openHistoryBrowser() {
  els.historyFrame.src = `/history.html?embedded=1&opened=${Date.now()}`;
  if (!els.historyBrowserDialog.open) els.historyBrowserDialog.showModal();
}

function closeHistoryBrowser() {
  els.historyBrowserDialog.close();
}

async function downloadSelected() {
  await saveSelectedImages({
    format: "jpg",
    statusLabel: "已保存",
  });
}

async function exportSelectedWebp() {
  await saveSelectedImages({
    format: "webp",
    statusLabel: "已导出 WebP",
    convertImageDataUrl: convertToWebpBlob,
  });
}

async function saveSelectedImages({ format, statusLabel, convertImageDataUrl }) {
  const selected = downloadableRows();
  if (!selected.length) {
    setStatus("未选择图片");
    return;
  }

  try {
    const { saved, usedBrowserDownload } = await saveImagesWithBrowserFallback(selected, {
      format,
      convertImageDataUrl,
    });
    setStatus(usedBrowserDownload ? `浏览器开始下载 ${saved} 张` : `${statusLabel} ${saved} 张`);
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("已取消选择文件夹");
      return;
    }
    setStatus(error.message || "保存失败");
  }
}

function updateDownloadButton() {
  const count = downloadableRows().length;
  els.downloadButton.disabled = count === 0;
  els.downloadButton.textContent = count ? `下载选中 (${count})` : "下载选中";
  els.webpDownloadButton.disabled = count === 0;
  els.webpDownloadButton.textContent = count ? `导出WebP (${count})` : "导出WebP";
}

function downloadableRows() {
  return displayRows().filter((row) => (
    row.taskType !== "curtain_product"
    && row.status === "done"
    && row.selected
    && row.imageDataUrl
  ));
}

function setBusy(isBusy) {
  const run = state.activeRun;
  const semanticBusy = state.startingRun || skuSelectionBlocksSemanticActions();
  const sizeControls = generationSizeControlState(
    state.mode,
    els.databaseTaskType.value,
    localStorage.getItem(SIZE_KEY) || "2048x2048",
  );
  const label = run ? "追加任务" : "开始生成";
  els.generateButton.disabled = state.startingRun || Boolean(run?.transitioning);
  els.generateButton.textContent = label;
  els.generateButton.setAttribute("aria-label", label);
  els.generateButton.dataset.runState = !run ? "idle" : run.paused ? "paused" : "running";
  els.checkModelButton.disabled = semanticBusy;
  els.promptInput.disabled = semanticBusy;
  els.qualityInput.disabled = semanticBusy;
  els.sizeInput.disabled = semanticBusy || sizeControls.disabled;
  els.fabricInput.disabled = semanticBusy;
  els.fabricFolderInput.disabled = semanticBusy;
  els.manualFabricCatalogRoot.disabled = semanticBusy;
  els.manualCurtainProductHeadings.forEach((input) => { input.disabled = semanticBusy; });
  els.manualFabricSampleSize.disabled = semanticBusy;
  els.databaseRunMode.disabled = semanticBusy;
  els.databaseTaskType.disabled = semanticBusy;
  els.databaseSaveFormat.disabled = semanticBusy || els.databaseTaskType.value === "curtain_product";
  els.loadDatabaseButton.disabled = semanticBusy || state.loadingDatabase;
  els.selectDatabaseOutputButton.disabled = semanticBusy || state.loadingDatabase;
  els.manualModeButton.disabled = semanticBusy;
  els.databaseModeButton.disabled = semanticBusy;
  setCurtainProductDirectorySelectionBusy(curtainProductDirectorySelection.isActive());
  updateDownloadButton();
}

function refreshGenerationControls() {
  setBusy(state.running);
}

function readApiKey() {
  return readSharedApiKey();
}

function setProgress(done, total) {
  els.progressText.textContent = `${done} / ${total}`;
  const percent = total ? Math.round((done / total) * 100) : 0;
  els.progressBar.style.width = `${percent}%`;
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function statusText(row) {
  if (row.status === "done") {
    if (row.source === "database") {
      return row.historyError ? "完成，已保存；历史保存失败" : "完成，已保存";
    }
    return row.historyError ? "完成，历史未保存" : "完成";
  }
  if (row.status === "queued") return "队列中";
  if (row.status === "running") return "生成中";
  if (row.status === "paused") return "暂停";
  if (row.status === "error") return row.error || "失败";
  return "等待";
}

function readApiError(data) {
  if (typeof data.error === "string") {
    try {
      const parsed = JSON.parse(data.error);
      return parsed?.error?.message || parsed?.message || data.error;
    } catch {
      return data.error;
    }
  }
  return data?.error?.message || data?.message || "请求失败";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error || new Error("读取文件失败")));
    reader.readAsDataURL(file);
  });
}

function convertToJpegDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      resolve(canvas.toDataURL("image/jpeg", 0.95));
    });
    image.addEventListener("error", () => reject(new Error("图片转换失败")));
    image.src = dataUrl;
  });
}

function convertToWebpBlob(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("WebP 转换失败"));
            return;
          }
          resolve(blob);
        },
        "image/webp",
        0.9,
      );
    });
    image.addEventListener("error", () => reject(new Error("WebP 转换失败")));
    image.src = dataUrl;
  });
}

function skuFromFabricName(fileName) {
  const name = String(fileName || "").split(/[\\/]/).pop() || "fabric";
  const withoutExt = name.replace(/\.[^.]+$/, "");
  return sanitizeSku(withoutExt.replace(/_detail(?:_10|_15)?$/i, "") || "fabric");
}

function outputNameForFabric(fileName) {
  return `${skuFromFabricName(fileName)}_sence.jpg`;
}

function databaseOutputLabel(sku, format, taskType = "scene_replacement") {
  if (taskType === "curtain_product") return createCurtainProductOutput(sku, selectedCurtainProductHeading()).outputName;
  const jpg = buildOutputName(sku, "_sence", "jpg");
  if (format === "webp") return buildOutputName(sku, "_sence", "webp");
  if (format === "both") return `${jpg} + .webp`;
  return jpg;
}

function databaseOutputNamesForRow(row, format) {
  if (format === "both") return [buildOutputName(row.sku, "_sence", "jpg"), buildOutputName(row.sku, "_sence", "webp")];
  return [buildOutputName(row.sku, "_sence", format)];
}

function buildOutputName(sku, suffix, extension) {
  const clean = (value) => String(value ?? "").trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, "_");
  return `${sanitizeSku(sku || "fabric")}${clean(suffix)}.${String(extension || "jpg").replace(/^\.+/, "")}`;
}

function rowSubtitle(row) {
  if (row.source === "manual") {
    if (row.fabricMetadataError) return `${row.file.name} · 预检失败：${row.fabricMetadataError}`;
    if (!row.fabricMetadata) return `${row.file.name} · 正在读取 SKU 面料信息`;
    const metadata = row.fabricMetadata;
    if (metadata.fabricMode === "repeat") {
      return `${row.file.name} · 有花位 ${metadata.repeatVerticalCm} × ${metadata.repeatHorizontalCm} cm · Image 3 已匹配`;
    }
    return `${row.file.name} · 无花位 · ${metadata.composition || "成分未提供"}`;
  }
  const vertical = row.patternRepeatVerticalCm ? `${row.patternRepeatVerticalCm}cm` : "--";
  const horizontal = row.patternRepeatHorizontalCm ? `${row.patternRepeatHorizontalCm}cm` : "--";
  return `${row.job.factoryName} · ${row.job.seriesCode} · ${vertical} × ${horizontal}`;
}

function sanitizeSku(value) {
  return String(value)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_");
}
