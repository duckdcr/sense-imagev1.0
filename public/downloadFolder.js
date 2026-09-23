const directoryLockEntries = [];
let directoryRegistryMutex = Promise.resolve();

export async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error("图片数据转换失败");
  }
  return response.blob();
}

export async function withDirectoryLock(directoryHandle, task) {
  const release = await acquireDirectoryLock(directoryHandle);
  try {
    return await task();
  } finally {
    await release();
  }
}

async function acquireDirectoryLock(directoryHandle) {
  let entry;
  let previous;
  let releaseOperation;

  await withDirectoryRegistryLock(async () => {
    entry = await findDirectoryLockEntry(directoryHandle);
    if (!entry) {
      entry = { handle: directoryHandle, tail: Promise.resolve(), users: 0 };
      directoryLockEntries.push(entry);
    }

    entry.users += 1;
    previous = entry.tail;
    const operation = new Promise((resolve) => { releaseOperation = resolve; });
    entry.tail = previous.catch(() => {}).then(() => operation);
  });

  await previous.catch(() => {});
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    releaseOperation();
    await withDirectoryRegistryLock(() => {
      entry.users -= 1;
      if (entry.users === 0) {
        const index = directoryLockEntries.indexOf(entry);
        if (index >= 0) directoryLockEntries.splice(index, 1);
      }
    });
  };
}

async function findDirectoryLockEntry(directoryHandle) {
  for (const entry of directoryLockEntries) {
    if (entry.handle === directoryHandle) return entry;
    if (await handlesReferToSameDirectory(directoryHandle, entry.handle)) return entry;
  }
  return null;
}

async function handlesReferToSameDirectory(first, second) {
  if (typeof first?.isSameEntry === "function") {
    try {
      if (await first.isSameEntry(second)) return true;
    } catch {
      // Fall back to identity or the other handle implementation.
    }
  }
  if (typeof second?.isSameEntry === "function") {
    try {
      return Boolean(await second.isSameEntry(first));
    } catch {
      // Test and older browser handles may not support equivalence checks.
    }
  }
  return false;
}

async function withDirectoryRegistryLock(task) {
  const previous = directoryRegistryMutex;
  let release;
  directoryRegistryMutex = new Promise((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
}

export function outputNameForFormat(outputName, format = "jpg") {
  if (format === "original") return String(outputName || "image");
  const extension = format === "webp" ? "webp" : format === "png" ? "png" : "jpg";
  return `${String(outputName || "image").replace(/\.[^.]+$/, "")}.${extension}`;
}

export async function assertOutputNamesAvailable(directoryHandle, names) {
  const requested = Array.from(names || [], (name) => String(name));
  const requestedByKey = new Map();
  for (const name of requested) {
    const key = filenameKey(name);
    if (requestedByKey.has(key)) throw new Error(`输出文件名重复：${name}`);
    requestedByKey.set(key, name);
  }

  if (typeof directoryHandle.values === "function") {
    for await (const entry of directoryHandle.values()) {
      if (entry?.kind !== "file") continue;
      const requestedName = requestedByKey.get(filenameKey(entry.name));
      if (requestedName) throw collisionError(requestedName);
    }
    return;
  }

  for (const name of requested) {
    try {
      await directoryHandle.getFileHandle(name);
      throw collisionError(name);
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
    }
  }
}

export async function writeBlobToDirectory(directoryHandle, name, blob, options = {}) {
  if (!options.overwrite) await assertOutputNamesAvailable(directoryHandle, [name]);
  const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
  options.onFileHandle?.();
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    if (typeof writable.abort === "function") {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the original write or close error.
      }
    }
    throw error;
  }
}

export async function saveImagesToDirectory(rows, directoryHandle, options = {}) {
  return withDirectoryLock(directoryHandle, () => saveImagesToDirectoryUnlocked(rows, directoryHandle, options));
}

export async function saveImagesWithBrowserFallback(rows, options = {}, browser = globalThis) {
  if (typeof browser.showDirectoryPicker === "function") {
    return saveImagesToSelectedDirectory(rows, options, browser);
  }

  const saved = await downloadImagesInBrowser(rows, options, browser);
  return { saved, usedBrowserDownload: true };
}

export async function saveImagesToSelectedDirectory(rows, options = {}, browser = globalThis) {
  if (typeof browser.showDirectoryPicker !== "function") {
    throw new Error("无法选择保存文件夹");
  }
  const directoryHandle = await browser.showDirectoryPicker({ mode: "readwrite" });
  return {
    saved: await saveImagesToDirectory(rows, directoryHandle, options),
    usedBrowserDownload: false,
  };
}

async function saveImagesToDirectoryUnlocked(rows, directoryHandle, options) {
  const format = options.format || "jpg";
  const convertImageDataUrl = options.convertImageDataUrl || dataUrlToBlob;
  const outputs = rows.map((row) => outputNameForFormat(row.outputName, format));
  await assertOutputNamesAvailable(directoryHandle, outputs);
  const blobs = [];
  for (const row of rows) {
    blobs.push(await convertImageDataUrl(row.imageDataUrl));
  }

  const created = [];
  try {
    for (const [index, name] of outputs.entries()) {
      let opened = false;
      try {
        await writeBlobToDirectory(directoryHandle, name, blobs[index], {
          onFileHandle() { opened = true; },
        });
        created.push(name);
      } catch (error) {
        if (opened) created.push(name);
        throw error;
      }
    }
  } catch (error) {
    for (const name of created.reverse()) {
      try {
        await directoryHandle.removeEntry(name);
      } catch {
        // Preserve the conversion or write error.
      }
    }
    throw error;
  }

  return outputs.length;
}

async function downloadImagesInBrowser(rows, options, browser) {
  const document = browser.document;
  const urlApi = browser.URL;
  if (!document?.createElement || !document.body?.append || !urlApi?.createObjectURL) {
    throw new Error("浏览器无法下载图片");
  }

  const format = options.format || "jpg";
  const convertImageDataUrl = options.convertImageDataUrl || dataUrlToBlob;
  const outputs = rows.map((row) => outputNameForFormat(row.outputName, format));
  const blobs = [];
  for (const row of rows) blobs.push(await convertImageDataUrl(row.imageDataUrl));

  for (const [index, name] of outputs.entries()) {
    const href = urlApi.createObjectURL(blobs[index]);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    (browser.setTimeout || setTimeout)(() => urlApi.revokeObjectURL?.(href), 1000);
  }

  return outputs.length;
}

function filenameKey(name) {
  return String(name).normalize("NFC").toLocaleLowerCase("en-US");
}

function collisionError(name) {
  return new Error(`文件已存在：${name}`);
}
