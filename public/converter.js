import {
  appendUniqueJpgFiles,
  conversionSummary,
  fitWithinLongEdge,
  formatBytes,
  jpgFilesFromSelection,
  saveConvertedBatch,
  webpOutputName,
} from "./converterCore.js";
import { pageCapacityForHeight, paginateRows } from "./queueViews.js";
import { installWorkspaceQueueClient } from "./workspaceQueueClient.js";

const state = {
  rows: [],
  outputDirectory: null,
  running: false,
  pageSize: 1,
  page: 1,
};
const workspaceQueue = installWorkspaceQueueClient({
  source: "converter",
  label: "格式转换",
  getRows: () => state.rows,
  describeRow: (row) => ({
    outputName: webpOutputName(row.file.name),
    detail: row.error || (row.status === "done"
      ? `${formatBytes(row.file.size)} → ${formatBytes(row.outputSize)}`
      : rowStatusText(row)),
    imageSrc: "",
    selectable: false,
  }),
});

const els = {
  clearButton: document.querySelector("#clearConverterButton"),
  fileInput: document.querySelector("#jpgInput"),
  fileInputSummary: document.querySelector("#jpgInputSummary"),
  folderInput: document.querySelector("#jpgFolderInput"),
  folderInputSummary: document.querySelector("#jpgFolderInputSummary"),
  outputPreview: document.querySelector("#converterOutputPreview"),
  list: document.querySelector("#converterList"),
  listViewport: document.querySelector("#converterListViewport"),
  nextPageButton: document.querySelector("#converterNextPageButton"),
  outputButton: document.querySelector("#selectConverterOutputButton"),
  outputSummary: document.querySelector("#converterOutputSummary"),
  pageIndicator: document.querySelector("#converterPageIndicator"),
  previousPageButton: document.querySelector("#converterPreviousPageButton"),
  progressBar: document.querySelector("#converterProgressBar"),
  progressText: document.querySelector("#converterProgressText"),
  sizeSummary: document.querySelector("#converterSizeSummary"),
  startButton: document.querySelector("#startConversionButton"),
  statusText: document.querySelector("#converterStatusText"),
};

init();

function init() {
  els.fileInput.addEventListener("change", handleFileSelection);
  els.folderInput.addEventListener("change", handleFileSelection);
  els.outputButton.addEventListener("click", selectOutputDirectory);
  els.clearButton.addEventListener("click", clearRows);
  els.startButton.addEventListener("click", startConversion);
  els.previousPageButton.addEventListener("click", () => changePage(-1));
  els.nextPageButton.addEventListener("click", () => changePage(1));
  render();

  const listResizeObserver = new ResizeObserver(updatePageCapacity);
  listResizeObserver.observe(els.listViewport);
  requestAnimationFrame(updatePageCapacity);
}

function handleFileSelection(event) {
  const selectedFiles = jpgFilesFromSelection(event.target.files || []);
  appendRows(selectedFiles);
  updateSelectionSummary(event.target, selectedFiles);
  event.target.value = "";
}

function updateSelectionSummary(input, selectedFiles) {
  if (input === els.folderInput) {
    if (!selectedFiles.length) {
      els.folderInputSummary.textContent = "文件夹中没有 JPG";
      return;
    }
    const relativePath = selectedFiles[0].webkitRelativePath || "";
    const folderName = relativePath.split("/")[0] || "所选文件夹";
    els.folderInputSummary.textContent = `${folderName} 已上传 · ${selectedFiles.length} 个 JPG`;
    return;
  }

  if (!selectedFiles.length) {
    els.fileInputSummary.textContent = "未找到 JPG 文件";
  } else if (selectedFiles.length === 1) {
    els.fileInputSummary.textContent = `${selectedFiles[0].name} 已上传`;
  } else {
    els.fileInputSummary.textContent = `${selectedFiles.length} 个文件已上传`;
  }
}

function appendRows(files) {
  const existingFiles = state.rows.map((row) => row.file);
  const mergedFiles = appendUniqueJpgFiles(existingFiles, files);
  const addedFiles = mergedFiles.slice(existingFiles.length);

  state.rows.push(...addedFiles.map((file) => ({
    id: crypto.randomUUID(),
    file,
    status: "pending",
    outputSize: 0,
    error: "",
  })));
  render();
}

function removeRow(rowId) {
  if (state.running) return;
  state.rows = state.rows.filter((row) => row.id !== rowId);
  render();
}

function clearRows() {
  if (state.running) return;
  state.rows = [];
  els.fileInputSummary.textContent = "未选择文件";
  els.folderInputSummary.textContent = "未选择文件夹";
  render();
}

async function selectOutputDirectory() {
  if (!window.showDirectoryPicker) {
    window.alert("当前浏览器不支持选择输出文件夹");
    return;
  }

  try {
    state.outputDirectory = await window.showDirectoryPicker({ mode: "readwrite" });
    els.outputSummary.textContent = state.outputDirectory.name;
    render();
  } catch (error) {
    if (error?.name !== "AbortError") window.alert("无法打开输出文件夹");
  }
}

async function startConversion() {
  if (state.running) return;
  if (!state.outputDirectory) {
    els.statusText.textContent = "请先选择输出文件夹";
    return;
  }

  const rowsToConvert = state.rows.filter((row) => row.status !== "done");
  if (!rowsToConvert.length) {
    els.statusText.textContent = state.rows.length ? "没有待转换文件" : "请先选择 JPG";
    return;
  }

  state.running = true;
  for (const row of rowsToConvert) {
    row.status = "pending";
    row.outputSize = 0;
    row.error = "";
  }
  setBusy(true);
  render();

  try {
    await saveConvertedBatch(
      rowsToConvert,
      state.outputDirectory,
      (row) => convertJpegToWebp(row.file),
      {
        continueOnError: true,
        onStart(row) {
          row.status = "running";
          els.statusText.textContent = `正在转换 ${row.file.name}`;
          render();
        },
        onSuccess({ item: row, blob }) {
          row.outputSize = blob.size;
          row.status = "done";
          render();
        },
        onError({ item: row, error }) {
          row.status = "error";
          row.error = error?.message || "转换失败";
          render();
        },
      },
    );
  } catch (error) {
    const message = error?.message || "输出文件冲突";
    for (const row of rowsToConvert) {
      row.status = "error";
      row.error = message;
    }
    state.running = false;
    setBusy(false);
    els.statusText.textContent = `无法开始：${message}`;
    render();
    return;
  }

  state.running = false;
  setBusy(false);
  const summary = conversionSummary(state.rows);
  els.statusText.textContent = summary.failed
    ? `完成 ${summary.completed}，失败 ${summary.failed}`
    : "转换完成";
  render();
}

async function convertJpegToWebp(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const targetSize = fitWithinLongEdge(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = targetSize.width;
    canvas.height = targetSize.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理图片");
    context.drawImage(bitmap, 0, 0, targetSize.width, targetSize.height);

    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("转换失败")),
        "image/webp",
        0.9,
      );
    });
  } finally {
    bitmap.close();
  }
}

function setBusy(isBusy) {
  els.fileInput.disabled = isBusy;
  els.folderInput.disabled = isBusy;
  els.outputButton.disabled = isBusy;
  els.clearButton.disabled = isBusy || !state.rows.length;
  els.startButton.disabled = isBusy || !state.rows.length;
}

function render() {
  els.outputPreview.textContent = webpOutputName(state.rows[0]?.file?.name || "sample-image.jpg");
  renderList();
  renderProgress();
  renderSizeSummary();
  if (!state.running) {
    els.clearButton.disabled = !state.rows.length;
    els.startButton.disabled = !state.rows.length;
  }
  workspaceQueue.notify();
}

function renderList() {
  els.list.innerHTML = "";
  const page = paginateRows(state.rows, state.page, state.pageSize);
  state.page = page.currentPage;
  if (!state.rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "未选择 JPG 文件";
    els.list.append(empty);
    updatePagination(page);
    return;
  }

  for (const row of page.rows) {
    const item = document.createElement("article");
    item.className = `converter-row ${row.status}`;

    const name = document.createElement("strong");
    name.className = "converter-file-name";
    name.textContent = row.file.name;

    const sizes = document.createElement("span");
    sizes.className = "converter-file-size";
    sizes.textContent = row.status === "done"
      ? `${formatBytes(row.file.size)} → ${formatBytes(row.outputSize)}`
      : formatBytes(row.file.size);

    const status = document.createElement("span");
    status.className = "converter-row-status";
    status.textContent = rowStatusText(row);

    const removeButton = document.createElement("button");
    removeButton.className = "icon-button converter-remove";
    removeButton.type = "button";
    removeButton.textContent = "×";
    removeButton.title = "删除";
    removeButton.setAttribute("aria-label", `删除 ${row.file.name}`);
    removeButton.disabled = state.running;
    removeButton.addEventListener("click", () => removeRow(row.id));

    item.append(name, sizes, status, removeButton);
    els.list.append(item);
  }
  updatePagination(page);
}

function updatePageCapacity() {
  const pageSize = pageCapacityForHeight(els.listViewport.clientHeight, 58, 8);
  if (pageSize === state.pageSize) return;
  state.pageSize = pageSize;
  renderList();
}

function changePage(delta) {
  state.page += delta;
  renderList();
}

function updatePagination(page) {
  els.pageIndicator.textContent = `${page.currentPage} / ${page.totalPages}`;
  els.previousPageButton.disabled = page.currentPage <= 1;
  els.nextPageButton.disabled = page.currentPage >= page.totalPages;
}

function renderProgress() {
  const summary = conversionSummary(state.rows);
  const finished = summary.completed + summary.failed;
  const percent = summary.total ? Math.round((finished / summary.total) * 100) : 0;
  els.progressText.textContent = `${finished} / ${summary.total}`;
  els.progressBar.style.width = `${percent}%`;
  if (!state.running && !state.rows.length) els.statusText.textContent = "待选择";
  if (!state.running && state.rows.length && !finished) els.statusText.textContent = "待转换";
}

function renderSizeSummary() {
  const summary = conversionSummary(state.rows);
  if (!summary.total) {
    els.sizeSummary.textContent = "0 个文件";
    return;
  }

  const output = summary.outputBytes ? ` · WebP ${formatBytes(summary.outputBytes)}` : "";
  els.sizeSummary.textContent = `${summary.total} 个 · 原图 ${formatBytes(summary.sourceBytes)}${output}`;
}

function rowStatusText(row) {
  if (row.status === "running") return "转换中";
  if (row.status === "done") return "已完成";
  if (row.status === "error") return row.error || "失败";
  return "等待";
}
