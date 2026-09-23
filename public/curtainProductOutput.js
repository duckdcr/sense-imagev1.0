import {
  DATABASE_PROGRESS_FILE,
  addCompletedDatabaseJob,
  readDatabaseProgress,
} from "./databaseOutput.js";
import {
  assertOutputNamesAvailable,
  dataUrlToBlob,
  withDirectoryLock,
  writeBlobToDirectory,
} from "./downloadFolder.js";

const fileStateByProgress = new WeakMap();

export async function readCurtainProductProgress(directory) {
  if (!directory) throw new Error("输出目录必填");
  const [progress, files] = await Promise.all([
    readDatabaseProgress(directory),
    listFiles(directory),
  ]);
  fileStateByProgress.set(progress, files);
  return progress;
}

export function filterCurtainProductJobs(jobs, progress, generationMode, headingStyle, outputNameForJob = null) {
  if (generationMode === "regenerate") return [...jobs];
  const fileState = fileStateByProgress.get(progress);
  return jobs.filter((job) => {
    const outputName = outputNameForJob?.(job) || curtainProductOutputName(job.factorySku, headingStyle);
    return !(
      curtainRecord(progress, job.factorySku)?.files?.includes(outputName)
      && fileState?.has(outputName)
    );
  });
}

export async function assertCurtainProductOutputsAvailable({
  directory,
  jobs,
  progress,
  generationMode,
  headingStyle,
  outputNameForJob = null,
}) {
  if (!directory) throw new Error("输出目录必填");
  if (generationMode === "regenerate") return;

  for (const job of jobs) {
    const outputName = outputNameForJob?.(job) || curtainProductOutputName(job.factorySku, headingStyle);
    const completed = curtainRecord(progress, job.factorySku)?.files?.includes(outputName);
    if (!completed) await assertOutputNamesAvailable(directory, [outputName]);
  }
}

export async function commitCurtainProductResult({
  directory,
  sku,
  outputName,
  imageDataUrl,
  generationMode,
  progress,
  row,
}) {
  if (!directory) throw new Error("输出目录必填");
  if (!/^[^<>:"/\\|?*\u0000-\u001F]+\.webp$/i.test(outputName)) {
    throw new Error("白底成品文件名无效");
  }
  assertWebpDataUrl(imageDataUrl);
  const imageBlob = await dataUrlToBlob(imageDataUrl);
  await assertWebp(imageBlob);

  return withDirectoryLock(directory, async () => {
    const latestProgress = await readDatabaseProgress(directory);
    if (
      generationMode !== "regenerate"
      && await isCompleteLocked(directory, latestProgress, sku, outputName)
    ) {
      return { files: [outputName], progress: latestProgress, alreadyComplete: true };
    }

    const previousFiles = curtainRecord(latestProgress, sku)?.files ?? [];
    if (generationMode !== "regenerate" && !previousFiles.includes(outputName)) {
      await assertOutputNamesAvailable(directory, [outputName]);
    }
    const files = [...new Set([...previousFiles, outputName])];
    const nextProgress = addCompletedDatabaseJob(
      latestProgress,
      { ...row, sku },
      files,
      new Date().toISOString(),
      "curtain_product",
    );
    const entries = [
      { name: outputName, blob: imageBlob },
      { name: DATABASE_PROGRESS_FILE, blob: progressBlob(nextProgress) },
    ];
    await commitEntries(directory, entries);
    return { files: [outputName], progress: nextProgress };
  });
}

function curtainProductOutputName(sku, headingStyle) {
  const normalizedSku = String(sku ?? "").trim();
  if (!normalizedSku) throw new Error("SKU 无效");
  if (headingStyle === "grommet") return `${normalizedSku}_grommet.webp`;
  if (headingStyle === "doublePinch") return `${normalizedSku}_double-pinch.webp`;
  throw new Error("帘头样式无效");
}

function curtainRecord(progress, sku) {
  return progress?.completed?.curtain_product && Object.hasOwn(progress.completed.curtain_product, sku)
    ? progress.completed.curtain_product[sku]
    : null;
}

async function isCompleteLocked(directory, progress, sku, outputName) {
  return Boolean(curtainRecord(progress, sku)?.files?.includes(outputName))
    && await fileExists(directory, outputName);
}

async function commitEntries(directory, entries) {
  const snapshots = [];
  for (const entry of entries) snapshots.push(await snapshotFile(directory, entry.name));
  const touched = [];
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      let opened = false;
      try {
        await writeBlobToDirectory(directory, entry.name, entry.blob, {
          overwrite: true,
          onFileHandle() { opened = true; },
        });
        if (opened) touched.push(index);
      } catch (error) {
        if (opened) touched.push(index);
        throw error;
      }
    }
  } catch (error) {
    await rollbackEntries(directory, entries, snapshots, touched);
    throw error;
  }
}

async function snapshotFile(directory, name) {
  try {
    const handle = await directory.getFileHandle(name);
    return { exists: true, blob: await handle.getFile() };
  } catch (error) {
    if (error?.name === "NotFoundError") return { exists: false, blob: null };
    throw error;
  }
}

async function rollbackEntries(directory, entries, snapshots, touched) {
  for (const index of [...touched].reverse()) {
    const snapshot = snapshots[index];
    try {
      if (snapshot.exists) {
        await writeBlobToDirectory(directory, entries[index].name, snapshot.blob, { overwrite: true });
      } else {
        await directory.removeEntry(entries[index].name);
      }
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
    }
  }
}

async function listFiles(directory) {
  const files = new Set();
  if (typeof directory.values !== "function") return files;
  for await (const entry of directory.values()) {
    if (entry?.kind === "file") files.add(entry.name);
  }
  return files;
}

async function fileExists(directory, name) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (error?.name === "NotFoundError") return false;
    throw error;
  }
}

function assertWebpDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("WebP 图片数据必须是 base64 data URL");
  const match = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[1].length % 4 !== 0) throw new Error("WebP 图片数据必须是 base64 data URL");
}

async function assertWebp(blob) {
  if (blob?.type?.toLowerCase() !== "image/webp") throw new Error("输出图片必须为 image/webp");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") {
    throw new Error("WebP 图片数据签名无效");
  }
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function progressBlob(progress) {
  return new Blob([JSON.stringify(progress, null, 2)], { type: "application/json" });
}
