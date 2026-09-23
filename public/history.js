import { saveImagesToSelectedDirectory } from "./downloadFolder.js";
import { createPreviewViewerController } from "./previewViewerController.js";
import {
  buildHistoryDetailView,
  historyCardResults,
  historyCardSources,
  historyTaskLabel,
} from "./historyPresentation.js";
import {
  evaluateHistoryPageResponse,
  historyDateKey,
  resolveDeleteReloadResult,
} from "./historyPagingState.js";
import { deleteLocalHistoryDay, listLocalHistoryPage } from "./localHistoryStore.js";
import { listLocalHistoryEntries } from "./localHistoryStore.js";
import { groupDownloadRowsByBatch } from "./uploadBatches.js";

const HISTORY_UPDATE_KEY = "sence-image-history-update-v1";

const state = {
  page: 1,
  pageSize: 10,
  total: 0,
  totalPages: 1,
  loading: false,
  requestRevision: 0,
  controller: null,
  deleteBusy: false,
  entry: null,
  results: [],
  resultAvailability: [false, false],
  dualProductResults: false,
  selectedEntries: new Map(),
  batchExporting: false,
  pendingBatchExport: null,
};

const els = {
  closeButton: document.querySelector("#closeHistoryDialogButton"),
  detailFabricImage: document.querySelector("#detailFabricImage"),
  detailFabricFigure: document.querySelector("#detailFabricFigure"),
  detailFabricName: document.querySelector("#detailFabricName"),
  detailFabricUnavailable: document.querySelector("#detailFabricUnavailable"),
  detailPrompt: document.querySelector("#detailPrompt"),
  detailPromptLabel: document.querySelector("#detailPromptLabel"),
  detailPromptSection: document.querySelector("#detailPromptSection"),
  detailUserPrompt: document.querySelector("#detailUserPrompt"),
  detailUserPromptSection: document.querySelector("#detailUserPromptSection"),
  detailProductParameters: document.querySelector("#detailProductParameters"),
  detailParametersLabel: document.querySelector("#detailParametersLabel"),
  detailProductParametersText: document.querySelector("#detailProductParametersText"),
  detailResultImage: document.querySelector("#detailResultImage"),
  detailResultFigure: document.querySelector("#detailResultFigure"),
  detailResultName: document.querySelector("#detailResultName"),
  detailResultUnavailable: document.querySelector("#detailResultUnavailable"),
  detailResultsUnavailable: document.querySelector("#detailResultsUnavailable"),
  detailSecondResultImage: document.querySelector("#detailSecondResultImage"),
  detailSecondResultFigure: document.querySelector("#detailSecondResultFigure"),
  detailSecondResultName: document.querySelector("#detailSecondResultName"),
  detailSecondResultUnavailable: document.querySelector("#detailSecondResultUnavailable"),
  detailSceneImage: document.querySelector("#detailSceneImage"),
  detailSceneLabel: document.querySelector("#detailSceneLabel"),
  detailSceneFigure: document.querySelector("#detailSceneFigure"),
  detailSceneName: document.querySelector("#detailSceneName"),
  detailTitle: document.querySelector("#detailTitle"),
  detailCreationOptions: document.querySelector("#detailCreationOptions"),
  detailTaskType: document.querySelector("#detailTaskType"),
  detailOptionsText: document.querySelector("#detailOptionsText"),
  downloadButton: document.querySelector("#downloadHistoryButton"),
  downloadSecondButton: document.querySelector("#downloadSecondHistoryButton"),
  downloadSelectedButton: document.querySelector("#downloadSelectedHistoryButton"),
  dialog: document.querySelector("#historyDialog"),
  historyList: document.querySelector("#historyList"),
  nextPageButton: document.querySelector("#nextHistoryPageButton"),
  pageIndicator: document.querySelector("#historyPageIndicator"),
  prevPageButton: document.querySelector("#prevHistoryPageButton"),
  refreshButton: document.querySelector("#refreshHistoryButton"),
  retryButton: document.querySelector("#retryHistoryButton"),
  status: document.querySelector("#historyStatus"),
  total: document.querySelector("#historyTotal"),
  previewCloseButton: document.querySelector("#closeHistoryPreviewButton"),
  previewDialog: document.querySelector("#historyPreviewDialog"),
  previewImage: document.querySelector("#historyPreviewImage"),
  previewTitle: document.querySelector("#historyPreviewTitle"),
  previewWrap: document.querySelector("#historyPreviewWrap"),
  webpButton: document.querySelector("#webpHistoryButton"),
  webpSecondButton: document.querySelector("#webpSecondHistoryButton"),
  exportSelectedWebpButton: document.querySelector("#exportSelectedHistoryWebpButton"),
  downloadBatchesButton: document.querySelector("#downloadHistoryBatchesButton"),
  exportBatchesWebpButton: document.querySelector("#exportHistoryBatchesWebpButton"),
  batchDownloadDialog: document.querySelector("#historyBatchDownloadDialog"),
  batchDownloadTitle: document.querySelector("#historyBatchDownloadTitle"),
  batchDownloadList: document.querySelector("#historyBatchDownloadList"),
  batchDownloadStatus: document.querySelector("#historyBatchDownloadStatus"),
  batchDownloadClose: document.querySelector("#closeHistoryBatchDownloadButton"),
  batchDownloadCancel: document.querySelector("#cancelHistoryBatchDownloadButton"),
  batchDownloadConfirm: document.querySelector("#confirmHistoryBatchDownloadButton"),
};

const previewViewer = createPreviewViewerController({
  dialog: els.previewDialog,
  viewport: els.previewWrap,
  image: els.previewImage,
  closeButton: els.previewCloseButton,
  windowTarget: window,
  titleElement: els.previewTitle,
  formatTitle: ({ label, name }) => `${label} · ${name}`,
});

init();

function init() {
  if (new URLSearchParams(window.location.search).get("embedded") === "1") {
    document.body.classList.add("history-embedded");
  }
  els.closeButton.addEventListener("click", () => els.dialog.close());
  els.refreshButton.addEventListener("click", () => loadHistoryPage(state.page));
  els.prevPageButton.addEventListener("click", () => loadHistoryPage(state.page - 1));
  els.nextPageButton.addEventListener("click", () => loadHistoryPage(state.page + 1));
  els.retryButton.addEventListener("click", () => loadHistoryPage(state.page));
  els.downloadButton.addEventListener("click", () => saveCurrentResult(0, "original"));
  els.downloadSecondButton.addEventListener("click", () => saveCurrentResult(1, "original"));
  els.webpButton.addEventListener("click", () => saveCurrentResult(0, "webp"));
  els.webpSecondButton.addEventListener("click", () => saveCurrentResult(1, "webp"));
  els.downloadSelectedButton.addEventListener("click", () => exportSelectedHistoryResults("original"));
  els.exportSelectedWebpButton.addEventListener("click", () => exportSelectedHistoryResults("webp"));
  els.downloadBatchesButton.addEventListener("click", () => void openHistoryBatchDownload("original"));
  els.exportBatchesWebpButton.addEventListener("click", () => void openHistoryBatchDownload("webp"));
  els.batchDownloadClose.addEventListener("click", () => els.batchDownloadDialog.close());
  els.batchDownloadCancel.addEventListener("click", () => els.batchDownloadDialog.close());
  els.batchDownloadDialog.addEventListener("click", (event) => { if (event.target === els.batchDownloadDialog) els.batchDownloadDialog.close(); });
  els.batchDownloadConfirm.addEventListener("click", () => void confirmHistoryBatchDownload());
  els.detailResultImage.addEventListener("click", () => openHistoryPreview(state.results[0]));
  els.detailSecondResultImage.addEventListener("click", () => openHistoryPreview(state.results[1]));
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.data?.type !== "workspace:history-updated") return;
    void loadHistoryPage(1);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === HISTORY_UPDATE_KEY) void loadHistoryPage(1);
  });
  loadHistoryPage(1);
}

async function loadHistoryPage(page, allowFallback = true) {
  if (!Number.isInteger(page) || page < 1) {
    return { ok: false, error: new Error("无效历史页码") };
  }
  state.controller?.abort();
  const controller = new AbortController();
  const revision = ++state.requestRevision;
  state.controller = controller;
  state.loading = true;
  clearHistoryError();
  if (!els.historyList.children.length) renderLoading();
  updateHistoryPagination();

  try {
    const data = await listLocalHistoryPage({ page, pageSize: state.pageSize });
    if (revision !== state.requestRevision || controller.signal.aborted) {
      return { ok: false, aborted: true };
    }
    const decision = evaluateHistoryPageResponse(data, {
      requestedPage: page,
      pageSize: state.pageSize,
      allowFallback,
    });
    if (decision.kind === "fallback") return loadHistoryPage(decision.page, false);

    const pageData = decision.data;
    state.page = pageData.page;
    state.total = pageData.total;
    state.totalPages = pageData.totalPages;
    state.loading = false;
    state.controller = null;
    renderHistory(pageData.entries);
    clearHistoryError();
    updateHistoryPagination();
    return { ok: true, page: pageData.page };
  } catch (error) {
    if (revision !== state.requestRevision || error?.name === "AbortError") {
      return { ok: false, aborted: true };
    }
    state.loading = false;
    state.controller = null;
    showHistoryError(error.message || "读取历史失败");
    updateHistoryPagination();
    return { ok: false, error };
  }
}

function renderHistory(entries) {
  els.historyList.innerHTML = "";

  if (!entries.length) {
    renderMessage("暂无生成历史");
    return;
  }

  const groups = groupByDate(entries);
  for (const group of groups) {
    const section = document.createElement("section");
    section.className = "date-section";

    const title = document.createElement("h2");
    title.textContent = group.label;

    const deleteButton = document.createElement("button");
    deleteButton.className = "button ghost delete-day-button";
    deleteButton.type = "button";
    deleteButton.textContent = "删除当天";
    deleteButton.addEventListener("click", () => deleteHistoryDay(group, deleteButton));

    const header = document.createElement("div");
    header.className = "date-section-head";
    header.append(title, deleteButton);

    const grid = document.createElement("div");
    grid.className = "history-grid";

    for (const entry of group.entries) {
      grid.append(createHistoryCard(entry));
    }

    section.append(header, grid);
    els.historyList.append(section);
  }
}

async function deleteHistoryDay(group, button) {
  if (state.deleteBusy) return { ok: false, busy: true };
  if (!window.confirm(`确定删除 ${group.label} 的全部历史吗？`)) {
    return { ok: false, cancelled: true };
  }

  const originalText = button.textContent;
  state.controller?.abort();
  const revision = ++state.requestRevision;
  state.controller = null;
  state.deleteBusy = true;
  clearHistoryError();
  updateHistoryPagination();
  button.disabled = true;
  button.textContent = "删除中";
  try {
    const data = await deleteLocalHistoryDay(group.dateKey);
    if (!Number.isInteger(data.deleted) || data.deleted < 0) {
      throw new Error("删除历史响应格式无效");
    }
    if (revision !== state.requestRevision) return { ok: false, aborted: true };
    if (state.entry && historyDateKey(state.entry.createdAt) === group.dateKey) {
      state.entry = null;
      if (els.dialog.open) els.dialog.close();
    }
    const reloadResult = await loadHistoryPage(state.page);
    const reloadDecision = resolveDeleteReloadResult(reloadResult);
    if (!reloadDecision.ok) {
      if (!reloadDecision.aborted) showHistoryError(reloadDecision.message);
      return reloadResult;
    }
    return { ok: true, deleted: data.deleted };
  } catch (error) {
    if (revision !== state.requestRevision || error?.name === "AbortError") {
      return { ok: false, aborted: true };
    }
    showHistoryError(error.message || "删除历史失败");
    return { ok: false, error };
  } finally {
    state.deleteBusy = false;
    button.disabled = false;
    button.textContent = originalText;
    updateHistoryPagination();
  }
}

function createHistoryCard(entry) {
  const key = historyEntryKey(entry);
  const wrapper = document.createElement("div");
  wrapper.className = "history-card-selection";
  wrapper.classList.toggle("selected", state.selectedEntries.has(key));

  const button = document.createElement("button");
  button.className = "history-card";
  button.type = "button";
  button.addEventListener("click", () => openDetail(entry));

  const results = historyCardResults(entry);
  if (entry.taskType === "curtain_product") {
    const media = document.createElement("span");
    media.className = "history-card-media";
    const dualSchema = hasProductResultSchema(entry);
    media.dataset.dual = String(dualSchema);
    media.classList.toggle("history-card-media-single", !dualSchema && results.length === 1);
    const unavailable = createUnavailableState("图片不可用", "history-card-unavailable");
    unavailable.hidden = results.length > 0;
    const cardResults = dualSchema
      ? ["grommet", "doublePinch"].map((kind) => results.find((result) => result.kind === kind) || { kind })
      : results;
    for (const result of cardResults) {
      const figure = document.createElement("span");
      figure.className = `history-card-source history-card-source-${result.kind}`;
      const sideUnavailable = createUnavailableState("图片不可用", "history-card-side-unavailable");
      sideUnavailable.hidden = Boolean(result.url);
      const image = document.createElement("img");
      image.hidden = true;
      image.alt = result.name || "成品图";
      image.addEventListener("load", () => { image.hidden = false; }, { once: true });
      image.addEventListener("error", () => {
        image.hidden = true;
        figure.dataset.unavailable = "true";
        sideUnavailable.hidden = false;
        showCardUnavailableState(media, unavailable);
      }, { once: true });
      const label = document.createElement("span");
      label.className = "history-card-source-label";
      label.textContent = result.label || (result.kind === "grommet" ? "圆孔帘" : "韩式双捏褶帘");
      figure.append(image, sideUnavailable, label);
      media.append(figure);
      if (result.url) image.src = result.url;
      else figure.dataset.unavailable = "true";
    }
    showCardUnavailableState(media, unavailable);
    media.append(unavailable);
    button.append(media);
  } else {
    const sources = historyCardSources(entry);
    const unavailable = createUnavailableState("图片不可用", "history-card-unavailable");
    if (sources.length) {
      const image = document.createElement("img");
      image.hidden = true;
      image.alt = sources[0].name;
      image.addEventListener("load", () => { image.hidden = false; }, { once: true });
      image.addEventListener("error", () => {
        image.hidden = true;
        unavailable.hidden = false;
      }, { once: true });
      image.src = sources[0].url;
      unavailable.hidden = true;
      button.append(image, unavailable);
    } else {
      button.append(unavailable);
    }
  }

  const body = document.createElement("span");
  body.className = "history-card-body";

  const name = document.createElement("strong");
  name.textContent = entry.outputName || "生成图";

  const taskType = document.createElement("span");
  taskType.className = "history-task-type";
  taskType.textContent = historyTaskLabel(entry.taskType);

  const meta = document.createElement("span");
  const sourceName = entry.taskType === "custom_generation"
    ? entry.sceneName || "参考图"
    : entry.fabricName || "面料图";
  meta.textContent = `${formatTime(entry.createdAt)} · ${sourceName}`;

  body.append(name, taskType, meta);
  button.append(body);

  const select = document.createElement("input");
  select.className = "history-card-select";
  select.type = "checkbox";
  select.checked = state.selectedEntries.has(key);
  select.setAttribute("aria-label", `选择 ${entry.outputName || "生成图"}`);
  select.addEventListener("change", () => {
    if (select.checked) state.selectedEntries.set(key, entry);
    else state.selectedEntries.delete(key);
    wrapper.classList.toggle("selected", select.checked);
    updateHistoryBatchActions();
  });
  wrapper.append(button, select);
  return wrapper;
}

function openDetail(entry) {
  const view = buildHistoryDetailView(entry);
  const custom = entry.taskType === "custom_generation";
  els.dialog.classList.toggle("history-product-dialog", view.showProductParameters);
  state.entry = entry;
  const dualSchema = view.showProductParameters && hasProductResultSchema(entry);
  state.dualProductResults = dualSchema;
  const firstResult = dualSchema
    ? view.results.find((result) => result.kind === "grommet") || null
    : view.results[0] || null;
  const secondResult = dualSchema
    ? view.results.find((result) => result.kind === "doublePinch") || null
    : null;
  state.results = [firstResult, secondResult];
  state.resultAvailability = [firstResult ? "pending" : false, secondResult ? "pending" : false];
  els.detailSecondResultFigure.hidden = !dualSchema;
  setExportBusy(false);
  els.downloadButton.textContent = entry.taskType === "curtain_product" ? "下载原图" : "下载 JPG";
  els.detailTitle.textContent = entry.outputName || "历史详情";
  bindDetailResult(0, firstResult, {
    figure: els.detailResultFigure,
    image: els.detailResultImage,
    unavailable: els.detailResultUnavailable,
    name: els.detailResultName,
    visible: true,
    fallbackLabel: "圆孔帘",
    createdAt: entry.createdAt,
  });
  bindDetailResult(1, secondResult, {
    figure: els.detailSecondResultFigure,
    image: els.detailSecondResultImage,
    unavailable: els.detailSecondResultUnavailable,
    name: els.detailSecondResultName,
    visible: dualSchema,
    fallbackLabel: "韩式双捏褶帘",
    createdAt: entry.createdAt,
  });
  setDetailImage({
    figure: els.detailSceneFigure,
    image: els.detailSceneImage,
    url: view.sceneUrl,
    alt: entry.sceneName || view.sceneLabel || "场景图",
    hideFigureWhenUnavailable: true,
  });
  els.detailSceneLabel.textContent = view.sceneLabel || "场景图";
  els.detailSceneName.textContent = view.showScene ? entry.sceneName || view.sceneLabel || "场景图" : "";
  setDetailImage({
    figure: els.detailFabricFigure,
    image: els.detailFabricImage,
    unavailable: els.detailFabricUnavailable,
    url: view.fabricUrl,
    alt: entry.fabricName || "面料图",
  });
  if (custom) els.detailFabricFigure.hidden = true;
  els.detailFabricName.textContent = entry.fabricName || "面料图";
  els.detailPrompt.textContent = view.prompt || "无";
  els.detailPromptLabel.textContent = entry.taskType === "curtain_product" ? "完整提示词" : "提示词";
  els.detailUserPromptSection.hidden = entry.taskType !== "curtain_product" || !view.userPrompt;
  els.detailUserPrompt.textContent = view.userPrompt;
  els.detailProductParameters.hidden = !view.showProductParameters;
  els.detailParametersLabel.textContent = custom ? "生成参数" : "成品规格";
  els.detailProductParametersText.textContent = view.productParameters;
  const creation = entry.taskType === "curtain_creation";
  els.detailCreationOptions.hidden = !creation;
  if (creation) {
    const labels = {
      installation: { ceiling: "顶装", wall: "墙装", recess: "窗框内安装" },
      length: { floor: "落地", below_sill: "窗台下", sill: "窗台齐" },
      opening: { center: "左右对开", left: "左单开", right: "右单开", closed: "完全闭合" },
    };
    els.detailTaskType.textContent = "新增窗帘";
    els.detailOptionsText.textContent = [labels.installation[entry.options?.installation], labels.length[entry.options?.length], labels.opening[entry.options?.opening]].filter(Boolean).join(" · ");
  }
  els.dialog.showModal();
}

function bindDetailResult(index, result, binding) {
  binding.figure.hidden = !binding.visible;
  binding.name.textContent = result
    ? `${result.label} · ${result.name} · ${formatDateTime(binding.createdAt)}`
    : binding.fallbackLabel;
  if (!binding.visible) {
    state.resultAvailability[index] = false;
    return;
  }
  setDetailImage({
    figure: binding.figure,
    image: binding.image,
    unavailable: binding.unavailable,
    url: result?.url || "",
    alt: result?.name || binding.fallbackLabel,
    onLoad: () => {
      state.resultAvailability[index] = true;
      updateDetailResultAvailability();
    },
    onUnavailable: () => {
      state.resultAvailability[index] = false;
      updateDetailResultAvailability();
    },
  });
  updateDetailResultAvailability();
}

function updateDetailResultAvailability() {
  const visibleIndexes = [els.detailResultFigure, els.detailSecondResultFigure]
    .map((figure, index) => ({ figure, index }))
    .filter(({ figure }) => !figure.hidden);
  const allUnavailable = state.dualProductResults && visibleIndexes.length > 0
    && visibleIndexes.every(({ index }) => state.resultAvailability[index] === false);
  els.detailResultsUnavailable.hidden = !allUnavailable;
  for (const { figure } of visibleIndexes) figure.hidden = allUnavailable;
  setExportBusy(false);
}

async function saveCurrentResult(index, format) {
  const target = state.results[index];
  if (!target || state.resultAvailability[index] !== true) return;
  const buttons = index === 0
    ? { original: els.downloadButton, webp: els.webpButton }
    : { original: els.downloadSecondButton, webp: els.webpSecondButton };
  const button = buttons[format];
  const originalText = button.textContent;
  try {
    setExportBusy(true);
    button.textContent = "保存中";
    const imageDataUrl = await fetchImageDataUrl(target.url);
    const outputFormat = format === "webp" ? "webp" : originalOutputFormat(target.name, state.entry.taskType);
    await saveImagesToSelectedDirectory(
      [{ selected: true, imageDataUrl, outputName: target.name }],
      format === "webp"
        ? { format: outputFormat, convertImageDataUrl: convertToWebpBlob }
        : state.entry.taskType === "curtain_product"
          ? { format: outputFormat }
          : { format: outputFormat, convertImageDataUrl: convertToJpegBlob },
    );
  } catch (error) {
    if (error?.name !== "AbortError") {
      window.alert(error.message || "保存失败");
    }
  } finally {
    button.textContent = originalText;
    setExportBusy(false);
  }
}

async function exportSelectedHistoryResults(format) {
  if (state.batchExporting) return;
  const results = [...state.selectedEntries.values()]
    .flatMap((entry) => historyCardResults(entry))
    .filter((result) => result.url);
  if (!results.length) return;

  state.batchExporting = true;
  updateHistoryBatchActions();
  try {
    const rows = await Promise.all(results.map(async (result) => ({
      outputName: result.name || "生成图.jpg",
      imageDataUrl: await fetchImageDataUrl(result.url),
    })));
    const options = format === "webp"
      ? { format, convertImageDataUrl: convertToWebpBlob }
      : { format };
    const { saved } = await saveImagesToSelectedDirectory(rows, options);
    els.status.textContent = `已保存 ${saved} 张`;
  } catch (error) {
    if (error?.name !== "AbortError") els.status.textContent = error?.message || "保存失败";
  } finally {
    state.batchExporting = false;
    updateHistoryBatchActions();
  }
}

async function openHistoryBatchDownload(format) {
  if (state.batchExporting) return;
  try {
    const entries = await listLocalHistoryEntries();
    const rows = entries.flatMap((entry) => historyCardResults(entry)
      .filter((result) => result.url)
      .map((result) => ({
        outputName: result.name || "生成图.jpg",
        url: result.url,
        uploadBatchId: entry.uploadBatchId,
        uploadBatchLabel: entry.uploadBatchLabel,
        uploadBatchCreatedAt: entry.uploadBatchCreatedAt,
      })));
    const groups = groupDownloadRowsByBatch(rows);
    if (!groups.length) return;
    state.pendingBatchExport = { format, groups, selectedBatchIds: new Set(groups.map((group) => group.id)) };
    renderHistoryBatchDownloadDialog();
    els.batchDownloadDialog.showModal();
  } catch (error) {
    els.status.textContent = error?.message || "读取批次失败";
  }
}

function renderHistoryBatchDownloadDialog() {
  const pending = state.pendingBatchExport;
  if (!pending) return;
  els.batchDownloadTitle.textContent = `选择 ${pending.format === "webp" ? "WebP" : "原图"} 批次`;
  els.batchDownloadStatus.textContent = "";
  els.batchDownloadList.replaceChildren();
  for (const group of pending.groups) {
    const label = document.createElement("label");
    label.className = "batch-download-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = pending.selectedBatchIds.has(group.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) pending.selectedBatchIds.add(group.id);
      else pending.selectedBatchIds.delete(group.id);
      updateHistoryBatchDownloadConfirm();
    });
    const text = document.createElement("span");
    text.textContent = group.label;
    const count = document.createElement("small");
    count.textContent = `${group.rows.length} 张`;
    label.append(checkbox, text, count);
    els.batchDownloadList.append(label);
  }
  updateHistoryBatchDownloadConfirm();
}

function updateHistoryBatchDownloadConfirm() {
  const selectedCount = state.pendingBatchExport?.selectedBatchIds.size || 0;
  els.batchDownloadConfirm.disabled = selectedCount === 0;
  els.batchDownloadConfirm.textContent = selectedCount ? `选择文件夹并保存 (${selectedCount})` : "选择文件夹并保存";
}

async function confirmHistoryBatchDownload() {
  const pending = state.pendingBatchExport;
  if (!pending) return;
  const selectedRows = pending.groups
    .filter((group) => pending.selectedBatchIds.has(group.id))
    .flatMap((group) => group.rows);
  if (!selectedRows.length) return;
  state.batchExporting = true;
  updateHistoryBatchDownloadConfirm();
  els.batchDownloadConfirm.textContent = "保存中";
  try {
    const rows = await Promise.all(selectedRows.map(async (row) => ({
      outputName: row.outputName,
      imageDataUrl: await fetchImageDataUrl(row.url),
    })));
    const options = pending.format === "webp" ? { format: "webp", convertImageDataUrl: convertToWebpBlob } : { format: "jpg" };
    const { saved } = await saveImagesToSelectedDirectory(rows, options);
    els.status.textContent = `已保存 ${saved} 张`;
    els.batchDownloadDialog.close();
  } catch (error) {
    if (error?.name === "AbortError") {
      els.status.textContent = "已取消选择文件夹";
      els.batchDownloadDialog.close();
    } else {
      els.batchDownloadStatus.textContent = error?.message || "保存失败";
    }
  } finally {
    state.batchExporting = false;
    updateHistoryBatchDownloadConfirm();
  }
}

function setExportBusy(isBusy) {
  const buttons = [
    [els.downloadButton, els.webpButton],
    [els.downloadSecondButton, els.webpSecondButton],
  ];
  buttons.forEach((pair, index) => {
    for (const button of pair) button.disabled = isBusy || state.resultAvailability[index] !== true;
  });
}

function originalOutputFormat(name, taskType) {
  if (taskType !== "curtain_product") return "jpg";
  return /\.webp$/i.test(name) ? "webp" : "jpg";
}

function createUnavailableState(text, className = "") {
  const unavailable = document.createElement("span");
  unavailable.className = `history-image-unavailable ${className}`.trim();
  unavailable.textContent = text;
  return unavailable;
}

function showCardUnavailableState(media, unavailable) {
  const visibleSources = Array.from(media.querySelectorAll(".history-card-source"))
    .filter((source) => source.dataset.unavailable !== "true");
  media.classList.toggle("history-card-media-single", media.dataset.dual !== "true" && visibleSources.length === 1);
  for (const source of media.querySelectorAll(".history-card-source")) {
    source.hidden = visibleSources.length === 0;
  }
  unavailable.hidden = visibleSources.length > 0;
}

function hasProductResultSchema(entry) {
  return Boolean(entry.results && typeof entry.results === "object")
    || ["grommetResultUrl", "grommetOutputName", "doublePinchResultUrl", "doublePinchOutputName"]
      .some((key) => Object.hasOwn(entry, key));
}

function setDetailImage({
  figure,
  image,
  unavailable = null,
  url,
  alt,
  hideFigureWhenUnavailable = false,
  onLoad = () => {},
  onUnavailable = () => {},
}) {
  image.removeAttribute("src");
  image.hidden = true;
  image.alt = "";
  if (unavailable) unavailable.hidden = true;

  if (!url) {
    figure.hidden = hideFigureWhenUnavailable;
    if (!hideFigureWhenUnavailable && unavailable) unavailable.hidden = false;
    onUnavailable();
    return;
  }

  figure.hidden = false;
  image.alt = alt;
  image.addEventListener("load", () => {
    image.hidden = false;
    if (unavailable) unavailable.hidden = true;
    onLoad();
  }, { once: true });
  image.addEventListener("error", () => {
    image.hidden = true;
    if (hideFigureWhenUnavailable) figure.hidden = true;
    else if (unavailable) unavailable.hidden = false;
    onUnavailable();
  }, { once: true });
  image.src = url;
}

async function fetchImageDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("读取生成图片失败");
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取生成图片失败"));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function convertToWebpBlob(dataUrl) {
  const sourceResponse = await fetch(dataUrl);
  const sourceBlob = await sourceResponse.blob();
  if (sourceBlob.type === "image/webp") return sourceBlob;

  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d").drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("WebP 转换失败"));
    }, "image/webp", 0.9);
  });
}

async function convertToJpegBlob(dataUrl) {
  const sourceResponse = await fetch(dataUrl);
  const sourceBlob = await sourceResponse.blob();
  if (sourceBlob.type === "image/jpeg") return sourceBlob;

  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("JPG 转换失败"));
    }, "image/jpeg", 0.95);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("读取生成图片失败"));
    image.src = src;
  });
}

function openHistoryPreview(result) {
  if (!result?.url) return;
  previewViewer.open({ ...result, src: result.url });
}

function groupByDate(entries) {
  const map = new Map();
  const sorted = [...entries].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  for (const entry of sorted) {
    const dateKey = historyDateKey(entry.createdAt);
    const label = formatDate(entry.createdAt);
    if (!map.has(dateKey)) {
      map.set(dateKey, { dateKey, label, entries: [] });
    }
    map.get(dateKey).entries.push(entry);
  }

  return Array.from(map.values());
}

function historyEntryKey(entry) {
  return String(entry.id || `${entry.createdAt || ""}|${entry.outputName || ""}|${entry.fabricName || ""}`);
}

function renderLoading() {
  els.status.textContent = "读取中";
}

function updateHistoryPagination() {
  const displayedTotalPages = Math.max(state.totalPages, 1);
  els.total.textContent = `共 ${state.total} 张`;
  els.pageIndicator.textContent = `第 ${state.page} / ${displayedTotalPages} 页`;
  els.prevPageButton.disabled = state.loading || state.deleteBusy || state.page <= 1;
  els.nextPageButton.disabled = state.loading
    || state.deleteBusy
    || state.totalPages === 0
    || state.page >= state.totalPages;
  els.refreshButton.disabled = state.loading || state.deleteBusy;
  for (const button of els.historyList.querySelectorAll?.(".delete-day-button") || []) {
    button.disabled = state.deleteBusy;
  }
  updateHistoryBatchActions();
}

function updateHistoryBatchActions() {
  const count = state.selectedEntries.size;
  const disabled = count === 0 || state.batchExporting;
  els.downloadSelectedButton.disabled = disabled;
  els.exportSelectedWebpButton.disabled = disabled;
  els.downloadSelectedButton.textContent = count ? `下载选中 (${count})` : "下载选中";
  els.exportSelectedWebpButton.textContent = count ? `导出 WebP (${count})` : "导出 WebP";
}

function clearHistoryError() {
  els.status.textContent = "";
  els.retryButton.hidden = true;
}

function showHistoryError(message) {
  els.status.textContent = message;
  els.retryButton.hidden = false;
  if (!els.historyList.children.length) {
    renderMessage(message);
  }
}

function renderMessage(text) {
  els.historyList.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = text;
  els.historyList.append(empty);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知日期";
  return date.toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${formatDate(value)} ${formatTime(value)}`;
}
