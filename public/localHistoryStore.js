const DATABASE_NAME = "sence-image-local-history";
const DATABASE_VERSION = 1;
const STORE_NAME = "entries";

export function normalizeLocalHistoryEntry(entry = {}) {
  const createdAt = typeof entry.createdAt === "string" && Number.isFinite(Date.parse(entry.createdAt))
    ? entry.createdAt
    : new Date().toISOString();
  return {
    ...entry,
    id: typeof entry.id === "string" && entry.id ? entry.id : createId(),
    createdAt,
    outputName: String(entry.outputName || "生成图"),
    taskType: String(entry.taskType || "scene_replacement"),
    prompt: typeof entry.prompt === "string" ? entry.prompt : "",
    effectivePrompt: typeof entry.effectivePrompt === "string" ? entry.effectivePrompt : "",
    resultUrl: stringValue(entry.resultUrl),
    sceneUrl: stringValue(entry.sceneUrl),
    fabricUrl: stringValue(entry.fabricUrl),
  };
}

export async function saveLocalHistoryEntry(entry) {
  const normalized = normalizeLocalHistoryEntry(entry);
  const database = await openHistoryDatabase();
  await transactionComplete(database, "readwrite", (store) => store.put(normalized));
  return normalized;
}

export async function listLocalHistoryPage({ page = 1, pageSize = 10 } = {}) {
  const normalizedPage = positiveInteger(page, 1);
  const normalizedPageSize = positiveInteger(pageSize, 10);
  const database = await openHistoryDatabase();
  const entries = await transactionResult(database, "readonly", (store) => store.getAll()) || [];
  const sorted = entries
    .map(normalizeLocalHistoryEntry)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / normalizedPageSize));
  const actualPage = Math.min(normalizedPage, totalPages);
  const start = (actualPage - 1) * normalizedPageSize;
  return {
    entries: sorted.slice(start, start + normalizedPageSize),
    total,
    page: actualPage,
    pageSize: normalizedPageSize,
    totalPages,
  };
}

export async function listLocalHistoryEntries() {
  const database = await openHistoryDatabase();
  const entries = await transactionResult(database, "readonly", (store) => store.getAll()) || [];
  return entries
    .map(normalizeLocalHistoryEntry)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export async function deleteLocalHistoryDay(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) throw new Error("历史日期无效");
  const database = await openHistoryDatabase();
  const entries = await transactionResult(database, "readonly", (store) => store.getAll()) || [];
  const matching = entries.filter((entry) => localHistoryDateKey(entry.createdAt) === dateKey);
  if (!matching.length) return { deleted: 0 };
  await transactionComplete(database, "readwrite", (store) => {
    matching.forEach((entry) => store.delete(entry.id));
  });
  return { deleted: matching.length };
}

export function localHistoryDateKey(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function openHistoryDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("当前浏览器不支持本地历史记录"));
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地历史记录打开失败"));
  });
}

function transactionResult(database, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地历史记录读取失败"));
  });
}

function transactionComplete(database, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("本地历史记录保存失败"));
    transaction.onabort = () => reject(transaction.error || new Error("本地历史记录保存失败"));
    operation(transaction.objectStore(STORE_NAME));
  });
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function createId() {
  return globalThis.crypto?.randomUUID?.() || `history-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
