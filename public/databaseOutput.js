import {
  assertOutputNamesAvailable,
  dataUrlToBlob,
  withDirectoryLock,
  writeBlobToDirectory,
} from "./downloadFolder.js";

export const DATABASE_PROGRESS_FILE = "sence-image-progress.json";

const DEFAULT_TASK_TYPE = "scene_replacement";
const TASK_TYPES = [DEFAULT_TASK_TYPE, "curtain_product"];

export async function readDatabaseProgress(directoryHandle) {
  let fileHandle;
  try {
    fileHandle = await directoryHandle.getFileHandle(DATABASE_PROGRESS_FILE);
  } catch (error) {
    if (error?.name === "NotFoundError") return emptyProgress();
    throw error;
  }

  try {
    const file = await fileHandle.getFile();
    const parsed = JSON.parse(await file.text());
    return migrateProgress(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("进度清单格式无效", { cause: error });
    throw error;
  }
}

export async function writeDatabaseProgress(directoryHandle, progress) {
  const canonicalProgress = migrateProgress(progress);
  const blob = new Blob([JSON.stringify(canonicalProgress, null, 2)], { type: "application/json" });
  await commitFileTransaction(directoryHandle, [{ name: DATABASE_PROGRESS_FILE, blob }]);
}

export function filterJobsForProgress(jobs, progress, mode, taskType = DEFAULT_TASK_TYPE) {
  validateTaskType(taskType);
  const completed = normalizeProgress(progress).completed[taskType];
  if (mode === "regenerate") return [...jobs];
  return jobs.filter((job) => !Object.hasOwn(completed, job.factorySku));
}

export function addCompletedDatabaseJob(
  progress,
  row,
  files,
  completedAt = new Date().toISOString(),
  taskType = DEFAULT_TASK_TYPE,
) {
  validateTaskType(taskType);
  const canonicalProgress = normalizeProgress(progress);
  return {
    version: 2,
    completed: {
      ...canonicalProgress.completed,
      [taskType]: {
        ...canonicalProgress.completed[taskType],
        [row.sku]: {
          completedAt,
          factoryName: row.job?.factoryName || "",
          seriesCode: row.job?.seriesCode || "",
          files: [...files],
        },
      },
    },
  };
}

export async function saveDatabaseResult({
  directoryHandle,
  sku,
  format,
  jpegDataUrl,
  webpDataUrl,
  taskType = DEFAULT_TASK_TYPE,
  generationMode = "continue",
}) {
  validateTaskType(taskType);
  const files = databaseOutputNames(sku, format, taskType);
  if (!files.length) throw new Error("保存格式无效");
  const overwrite = generationMode === "regenerate";
  if (!overwrite) await assertOutputNamesAvailable(directoryHandle, files);

  const entries = await databaseOutputEntries(files, format, jpegDataUrl, webpDataUrl);
  await commitFileTransaction(directoryHandle, entries, overwrite ? [] : files);
  return files;
}

export async function commitDatabaseResult({
  directoryHandle,
  sku,
  format,
  jpegDataUrl,
  webpDataUrl,
  taskType = DEFAULT_TASK_TYPE,
  generationMode = "continue",
  progress,
  row,
  outputNames = null,
}) {
  validateTaskType(taskType);
  const files = Array.isArray(outputNames) && outputNames.length
    ? outputNames
    : databaseOutputNames(sku, format, taskType);
  if (!files.length) throw new Error("保存格式无效");
  if (generationMode !== "regenerate") await assertOutputNamesAvailable(directoryHandle, files);

  const nextProgress = addCompletedDatabaseJob(progress, row, files, undefined, taskType);
  const entries = await databaseOutputEntries(files, format, jpegDataUrl, webpDataUrl);
  entries.push({
    name: DATABASE_PROGRESS_FILE,
    blob: new Blob([JSON.stringify(nextProgress, null, 2)], { type: "application/json" }),
  });
  await commitFileTransaction(
    directoryHandle,
    entries,
    generationMode === "regenerate" ? [] : files,
  );
  return { files, progress: nextProgress };
}

export async function assertDatabaseOutputsAvailable(directoryHandle, jobs, format, taskType = DEFAULT_TASK_TYPE, outputNames = null) {
  validateTaskType(taskType);
  const names = Array.isArray(outputNames) && outputNames.length
    ? outputNames
    : jobs.flatMap((job) => databaseOutputNames(job.factorySku, format, taskType));
  await assertOutputNamesAvailable(directoryHandle, names);
}

export function databaseOutputNames(sku, format, taskType = DEFAULT_TASK_TYPE) {
  validateTaskType(taskType);
  const outputKind = taskType === "curtain_product" ? "curtain" : "scene";
  const names = [];
  if (format === "jpg" || format === "both") names.push(`${sku}_${outputKind}.jpg`);
  if (format === "webp" || format === "both") names.push(`${sku}_${outputKind}.webp`);
  return names;
}

async function databaseOutputEntries(files, format, jpegDataUrl, webpDataUrl) {
  const blobs = [];
  if (format === "jpg" || format === "both") blobs.push(await dataUrlToBlob(jpegDataUrl));
  if (format === "webp" || format === "both") blobs.push(await dataUrlToBlob(webpDataUrl));
  return files.map((name, index) => ({ name, blob: blobs[index] }));
}

async function commitFileTransaction(directoryHandle, entries, requiredAbsent = []) {
  return withDirectoryLock(directoryHandle, async () => {
    const snapshots = new Map();
    for (const { name } of entries) snapshots.set(name, await snapshotFile(directoryHandle, name));

    if (requiredAbsent.length) {
      await assertOutputNamesAvailable(directoryHandle, requiredAbsent);
    }

    const requiredAbsentSet = new Set(requiredAbsent);
    const owned = [];
    try {
      for (const { name, blob } of entries) {
        let opened = false;
        try {
          await writeBlobToDirectory(directoryHandle, name, blob, {
            overwrite: !requiredAbsentSet.has(name),
            onFileHandle() { opened = true; },
          });
          if (opened) owned.push(name);
        } catch (error) {
          if (opened) owned.push(name);
          throw error;
        }
      }
    } catch (error) {
      const rollbackErrors = await rollbackFiles(directoryHandle, owned, snapshots);
      if (rollbackErrors.length && error && typeof error === "object") {
        try {
          Object.defineProperty(error, "rollbackErrors", { value: rollbackErrors });
        } catch {
          // Preserve the original transaction error.
        }
      }
      throw error;
    }
  });
}

async function snapshotFile(directoryHandle, name) {
  try {
    const fileHandle = await directoryHandle.getFileHandle(name);
    return { exists: true, blob: await fileHandle.getFile() };
  } catch (error) {
    if (error?.name === "NotFoundError") return { exists: false, blob: null };
    throw error;
  }
}

async function rollbackFiles(directoryHandle, touched, snapshots) {
  const errors = [];
  for (const name of [...touched].reverse()) {
    const snapshot = snapshots.get(name);
    try {
      if (snapshot.exists) {
        await writeBlobToDirectory(directoryHandle, name, snapshot.blob, { overwrite: true });
      } else {
        await directoryHandle.removeEntry(name);
      }
    } catch (error) {
      if (error?.name !== "NotFoundError") errors.push(error);
    }
  }
  return errors;
}


function emptyProgress() {
  return {
    version: 2,
    completed: { scene_replacement: {}, curtain_product: {} },
  };
}

function migrateProgress(progress) {
  if (!progress || !isPlainObject(progress.completed)) throw invalidProgressError();

  if (progress.version === 1) {
    return {
      version: 2,
      completed: { scene_replacement: progress.completed, curtain_product: {} },
    };
  }

  if (
    progress.version !== 2
    || !isPlainObject(progress.completed.scene_replacement)
    || !isPlainObject(progress.completed.curtain_product)
  ) {
    throw invalidProgressError();
  }

  return {
    version: 2,
    completed: {
      scene_replacement: progress.completed.scene_replacement,
      curtain_product: progress.completed.curtain_product,
    },
  };
}

function normalizeProgress(progress) {
  if (progress == null) return emptyProgress();
  return migrateProgress(progress);
}

function validateTaskType(taskType) {
  if (!TASK_TYPES.includes(taskType)) {
    throw new Error(`数据库任务类型无效，仅支持 ${TASK_TYPES.join(" 或 ")}`);
  }
}

function invalidProgressError() {
  return new Error("进度清单格式无效");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
