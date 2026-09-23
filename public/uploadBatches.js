export function createUploadBatch({
  sourceLabel,
  taskCount,
  order = 1,
  id = createBatchId(),
  now = new Date(),
} = {}) {
  const createdAt = validDate(now).toISOString();
  const count = positiveInteger(taskCount, 1);
  const batchOrder = positiveInteger(order, 1);
  const label = `${formatShanghaiDateTime(createdAt)} · ${String(sourceLabel || "生成任务")} · 第 ${batchOrder} 批 · ${count} 个任务`;
  return {
    id: String(id),
    label,
    sourceLabel: String(sourceLabel || "生成任务"),
    taskCount: count,
    order: batchOrder,
    createdAt,
  };
}

const BATCH_SEQUENCE_KEY = "sence-image-upload-batch-sequence-v1";

export function createNextUploadBatch({ storage = globalThis.localStorage, now = new Date(), ...options } = {}) {
  const createdAt = validDate(now).toISOString();
  const previous = readSequence(storage);
  const order = previous.order + 1;
  writeSequence(storage, { order });
  return createUploadBatch({ ...options, now: createdAt, order });
}

export function assignUploadBatch(rows, batch) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    uploadBatchId: batch.id,
    uploadBatchLabel: batch.label,
    uploadBatchCreatedAt: batch.createdAt,
  }));
}

export function applyUploadBatch(rows, batch) {
  for (const row of Array.isArray(rows) ? rows : []) {
    row.uploadBatchId = batch.id;
    row.uploadBatchLabel = batch.label;
    row.uploadBatchCreatedAt = batch.createdAt;
  }
  return rows;
}

export function groupDownloadRowsByBatch(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = typeof row?.uploadBatchId === "string" && row.uploadBatchId ? row.uploadBatchId : "legacy";
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        label: typeof row?.uploadBatchLabel === "string" && row.uploadBatchLabel
          ? row.uploadBatchLabel
          : "未分类历史",
        createdAt: row?.uploadBatchCreatedAt || "",
        rows: [],
      });
    }
    groups.get(id).rows.push(row);
  }
  return [...groups.values()];
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function formatShanghaiDateTime(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}/${values.month}/${values.day} ${values.hour}:${values.minute}`;
}

function createBatchId() {
  return globalThis.crypto?.randomUUID?.() || `upload-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readSequence(storage) {
  try {
    const value = JSON.parse(storage?.getItem?.(BATCH_SEQUENCE_KEY) || "{}");
    return {
      order: positiveInteger(value.order, 0),
    };
  } catch {
    return { order: 0 };
  }
}

function writeSequence(storage, value) {
  try {
    storage?.setItem?.(BATCH_SEQUENCE_KEY, JSON.stringify(value));
  } catch {
    // Storage being unavailable must not block task creation.
  }
}
