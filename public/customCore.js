let nextPromptId = 1;

function newPromptRow(prompt = "") {
  return {
    id: `prompt-${Date.now().toString(36)}-${nextPromptId++}`,
    prompt: String(prompt),
  };
}

export function createPromptRows(prompts = []) {
  const rows = Array.from(prompts || [], (prompt) => newPromptRow(prompt));
  return rows.length ? rows : [newPromptRow()];
}

export function addPromptRow(rows) {
  return [...rows, newPromptRow()];
}

export function updatePromptRow(rows, id, prompt) {
  return rows.map((row) => row.id === id ? { ...row, prompt: String(prompt) } : row);
}

export function removePromptRow(rows, id) {
  if (rows.length <= 1) return rows;
  return rows.filter((row) => row.id !== id);
}

export function customOutputName(referenceName, index) {
  const base = String(referenceName || "")
    .split(/[\\/]/).pop()
    .replace(/\.[^.]+$/, "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_") || "reference";
  return `${base}_${String(Number(index) + 1).padStart(2, "0")}.jpg`;
}

export function createCustomTaskRows(promptRows, referenceName, existingRows = []) {
  const startIndex = Array.from(existingRows || [])
    .filter((row) => row.referenceName === referenceName)
    .length;

  return Array.from(promptRows || [])
    .filter((row) => String(row?.prompt || "").trim())
    .map((row, index) => ({
      id: `${row.id}-task`,
      promptId: row.id,
      prompt: String(row.prompt),
      referenceName,
      outputName: customOutputName(referenceName, startIndex + index),
      status: "pending",
      error: "",
      imageDataUrl: "",
      selected: false,
    }));
}

export function customTaskStatusText(status) {
  return {
    pending: "等待生成",
    queued: "等待生成",
    running: "生成中",
    paused: "已暂停",
    error: "生成失败",
    done: "已完成",
  }[status] || "等待生成";
}
