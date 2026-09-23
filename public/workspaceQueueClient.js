function defaultDescription(row) {
  return {
    outputName: row.displayName || row.outputName || row.file?.name || "未命名任务",
    detail: row.error || "",
    imageSrc: row.imageDataUrl || row.previewUrl || row.referencePreviewUrl || "",
    selectable: row.status === "done" && Boolean(row.imageDataUrl),
  };
}

export function createWorkspaceQueueAdapter({
  source,
  label,
  getRows,
  describeRow = defaultDescription,
  onSelectionChange = () => {},
  removeTask: onRemoveTask = null,
}) {
  const generatedKeys = new WeakMap();
  let sequence = 0;

  function rows() {
    const value = getRows?.();
    return Array.isArray(value) ? value : [];
  }

  function keyFor(row) {
    if (row?.id !== undefined && row?.id !== null) return String(row.id);
    if (!generatedKeys.has(row)) generatedKeys.set(row, `${source}-${++sequence}`);
    return generatedKeys.get(row);
  }

  function taskFor(row) {
    const description = describeRow(row) || {};
    const selectable = description.selectable ?? (row.status === "done" && Boolean(row.imageDataUrl));
    return {
      key: keyFor(row),
      source,
      label,
      outputName: description.outputName || "未命名任务",
      detail: description.detail || row.error || "",
      imageSrc: description.imageSrc || row.imageDataUrl || "",
      status: row.status || "pending",
      selectable: Boolean(selectable),
      selected: Boolean(selectable && row.selected),
      removable: row.status === "pending" && typeof onRemoveTask === "function",
      uploadBatchId: typeof row.uploadBatchId === "string" ? row.uploadBatchId : "",
      uploadBatchLabel: typeof row.uploadBatchLabel === "string" ? row.uploadBatchLabel : "",
      uploadBatchCreatedAt: typeof row.uploadBatchCreatedAt === "string" ? row.uploadBatchCreatedAt : "",
    };
  }

  return {
    source,
    label,
    getTasks() {
      return rows().map(taskFor);
    },
    setSelected(key, selected) {
      const row = rows().find((candidate) => keyFor(candidate) === String(key));
      if (!row || row.status !== "done" || !row.imageDataUrl) return false;
      row.selected = Boolean(selected);
      onSelectionChange(row);
      return true;
    },
    removeTask(key) {
      const row = rows().find((candidate) => keyFor(candidate) === String(key));
      if (!row || row.status !== "pending" || typeof onRemoveTask !== "function") return false;
      const removed = onRemoveTask(row);
      if (removed) onSelectionChange(row);
      return Boolean(removed);
    },
    getSelectedResults() {
      return resultRows(true).filter((row) => row.selected).map(({ selected, ...row }) => row);
    },
    getResults() {
      return resultRows(false);
    },
  };

  function resultRows(includeSelection) {
    return rows()
      .filter((row) => row.status === "done" && row.imageDataUrl)
      .map((row) => ({
        outputName: row.displayName || row.outputName || row.file?.name || "image.jpg",
        imageDataUrl: row.imageDataUrl,
        ...(includeSelection ? { selected: Boolean(row.selected) } : {}),
        ...(typeof row.uploadBatchId === "string" && row.uploadBatchId ? { uploadBatchId: row.uploadBatchId } : {}),
        ...(typeof row.uploadBatchLabel === "string" && row.uploadBatchLabel ? { uploadBatchLabel: row.uploadBatchLabel } : {}),
        ...(typeof row.uploadBatchCreatedAt === "string" && row.uploadBatchCreatedAt ? { uploadBatchCreatedAt: row.uploadBatchCreatedAt } : {}),
      }));
  }
}

export function installWorkspaceQueueClient(options) {
  if (new URLSearchParams(window.location.search).get("embedded") === "1") {
    document.body.classList.add("workspace-embedded");
  }
  const adapter = createWorkspaceQueueAdapter(options);
  const api = {
    ...adapter,
    getPauseState() {
      return options.getPauseState?.() || { active: false, paused: false, transitioning: false };
    },
    async togglePause(action) {
      if (typeof options.togglePause !== "function") return false;
      return options.togglePause(action);
    },
    async startQueuedTasks() {
      if (typeof options.startQueuedTasks !== "function") return false;
      return options.startQueuedTasks();
    },
    notify() {
      if (window.parent !== window) {
        window.parent.postMessage({ type: "workspace:queue-changed", source: adapter.source }, window.location.origin);
      }
    },
  };
  window.workspaceQueueApi = api;
  queueMicrotask(() => api.notify());
  return api;
}
