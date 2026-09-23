const PROMPT_KINDS = new Set([
  "manual_product_plain",
  "manual_product_repeat",
  "curtain_creation",
]);
const LEGACY_FIXED_PROMPT_KEYS = Object.freeze([
  "sence-image-manual-fixed-prompt-v2",
  "sence-image-creation-fixed-prompt-v1",
]);

export async function fetchEditablePromptTemplate(kind, fetchImpl = fetch) {
  assertPromptKind(kind);
  const response = await fetchImpl("/api/editable-prompt-templates");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readError(data, "读取内置提示词失败"));
  if (typeof data[kind] !== "string" || !data[kind].trim()) {
    throw new Error("读取内置提示词失败");
  }
  return data[kind];
}

export async function saveEditablePromptTemplate(kind, prompt, fetchImpl = fetch) {
  assertPromptKind(kind);
  const response = await fetchImpl(`/api/editable-prompt-templates/${encodeURIComponent(kind)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readError(data, "提示词保存失败"));
  if (typeof data.prompt !== "string" || !data.prompt.trim()) {
    throw new Error("提示词保存失败");
  }
  return data.prompt;
}

export async function resetEditablePromptTemplate(kind, fetchImpl = fetch) {
  assertPromptKind(kind);
  const response = await fetchImpl(`/api/editable-prompt-templates/${encodeURIComponent(kind)}`, {
    method: "DELETE",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readError(data, "恢复默认提示词失败"));
  if (typeof data.prompt !== "string" || !data.prompt.trim()) {
    throw new Error("恢复默认提示词失败");
  }
  return data.prompt;
}

export function clearLegacyFixedPromptCache(storage = globalThis.localStorage) {
  if (!storage?.removeItem) return;
  LEGACY_FIXED_PROMPT_KEYS.forEach((key) => storage.removeItem(key));
}

function assertPromptKind(kind) {
  if (!PROMPT_KINDS.has(kind)) throw new Error("不支持的提示词类型");
}

function readError(data, fallback) {
  return typeof data?.error === "string" && data.error.trim() ? data.error : fallback;
}
