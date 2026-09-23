export function markRowsPaused(rows) {
  for (const row of rows || []) {
    if (row.status === "queued" || row.status === "pending") row.status = "paused";
  }
}

export function markRowsResumed(rows) {
  for (const row of rows || []) {
    if (row.status === "paused") row.status = "queued";
  }
}

export function applyBackendJobStatus(row, status, runPaused) {
  if (!row || row.status === "done" || row.status === "error") return;
  if (status === "running") {
    row.status = "running";
    return;
  }
  if (status === "queued" || status === "paused") {
    row.status = runPaused ? "paused" : "queued";
  }
}

export function generationButtonLabel({ active, paused = false, transitioning = false } = {}) {
  if (!active) return "开始生成";
  if (transitioning) return paused ? "继续中" : "停止中";
  return paused ? "继续生成" : "停止";
}
