export class HistoryPagingError extends Error {
  constructor(message, code = "invalid_response") {
    super(message);
    this.name = "HistoryPagingError";
    this.code = code;
  }
}

export function buildHistoryPageUrl(page, pageSize) {
  return `/api/history?page=${page}&pageSize=${pageSize}`;
}

export function evaluateHistoryPageResponse(data, {
  requestedPage,
  pageSize,
  allowFallback,
}) {
  const valid = data !== null
    && typeof data === "object"
    && !Array.isArray(data)
    && Array.isArray(data.entries)
    && data.entries.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    && Number.isInteger(data.total)
    && data.total >= 0
    && Number.isInteger(data.page)
    && data.page >= 1
    && data.page === requestedPage
    && data.pageSize === pageSize
    && Number.isInteger(data.totalPages)
    && data.totalPages >= 1
    && data.totalPages === Math.max(1, Math.ceil(data.total / data.pageSize))
    && data.entries.length <= data.pageSize
    && data.entries.length <= data.total
    && (data.page <= data.totalPages || data.entries.length === 0);
  if (!valid) throw new HistoryPagingError("历史响应格式无效");

  if (data.page > data.totalPages) {
    if (allowFallback) return { kind: "fallback", page: data.totalPages };
    throw new HistoryPagingError("历史分页回退失败", "fallback_failed");
  }
  return { kind: "success", data };
}

export function historyDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function resolveDeleteReloadResult(result) {
  if (result?.ok === true) return { ok: true, aborted: false, message: "" };
  if (result?.aborted === true) return { ok: false, aborted: true, message: "" };
  return {
    ok: false,
    aborted: false,
    message: result?.error?.message || "删除成功，但刷新历史失败",
  };
}
