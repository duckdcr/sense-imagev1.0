import { assertOutputNamesAvailable, writeBlobToDirectory } from "./downloadFolder.js";

const JPG_EXTENSION = /\.jpe?g$/i;

export function jpgFilesFromSelection(files) {
  return Array.from(files || []).filter((file) =>
    file?.type === "image/jpeg" || JPG_EXTENSION.test(file?.name || ""),
  );
}

export function appendUniqueJpgFiles(existing, incoming) {
  const result = [...existing];
  const identities = new Set(result.map(fileIdentity));

  for (const file of jpgFilesFromSelection(incoming)) {
    const identity = fileIdentity(file);
    if (identities.has(identity)) continue;
    identities.add(identity);
    result.push(file);
  }

  return result;
}

export function webpOutputName(fileName) {
  const base = String(fileName || "image").replace(/\.jpe?g$/i, "");
  const clean = (value) => String(value ?? "").trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, "_");
  return `${clean(base)}.webp`;
}

export async function saveConvertedOutput(directoryHandle, fileName, convert) {
  await assertOutputNamesAvailable(directoryHandle, [fileName]);
  const blob = await convert();
  await writeBlobToDirectory(directoryHandle, fileName, blob);
  return blob;
}

export async function saveConvertedBatch(items, directoryHandle, convert, hooks = {}) {
  const jobs = Array.from(items || [], (item) => {
    const file = item?.file || item;
    return { item, fileName: webpOutputName(file?.name) };
  });
  await assertOutputNamesAvailable(directoryHandle, jobs.map((job) => job.fileName));

  const results = [];
  for (const job of jobs) {
    hooks.onStart?.(job.item, job.fileName);
    try {
      const blob = await saveConvertedOutput(
        directoryHandle,
        job.fileName,
        () => convert(job.item),
      );
      const result = { item: job.item, fileName: job.fileName, blob };
      results.push(result);
      hooks.onSuccess?.(result);
    } catch (error) {
      const result = { item: job.item, fileName: job.fileName, error };
      results.push(result);
      hooks.onError?.(result);
      if (!hooks.continueOnError) throw error;
    }
  }
  return results;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${formatNumber(value / 1024)} KB`;
  return `${formatNumber(value / 1024 ** 2)} MB`;
}

export function conversionSummary(rows) {
  return rows.reduce(
    (summary, row) => {
      summary.total += 1;
      summary.sourceBytes += Number(row.file?.size) || 0;
      if (row.status === "done") {
        summary.completed += 1;
        summary.outputBytes += Number(row.outputSize) || 0;
      }
      if (row.status === "error") summary.failed += 1;
      return summary;
    },
    { total: 0, completed: 0, failed: 0, sourceBytes: 0, outputBytes: 0 },
  );
}

export function fitWithinLongEdge(width, height, maxLongEdge = 4000) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 1));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 1));
  const limit = Math.max(1, Math.round(Number(maxLongEdge) || 4000));
  const longestEdge = Math.max(sourceWidth, sourceHeight);

  if (longestEdge <= limit) {
    return { width: sourceWidth, height: sourceHeight };
  }

  const scale = limit / longestEdge;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function fileIdentity(file) {
  return [
    file.webkitRelativePath || file.name,
    Number(file.size) || 0,
    Number(file.lastModified) || 0,
  ].join("|");
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}
