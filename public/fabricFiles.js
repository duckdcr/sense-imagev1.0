const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const SUPPORTED_IMAGE_EXTENSION = /\.(jpe?g|png|webp|heic|heif)$/i;

export function imageFilesFromSelection(files) {
  return Array.from(files || []).filter(isSupportedImageFile);
}

export function appendUniqueImageFiles(existingFiles, newFiles) {
  const known = new Set(Array.from(existingFiles || []).map(imageFileIdentity));
  const appended = [...(existingFiles || [])];

  for (const file of newFiles || []) {
    const identity = imageFileIdentity(file);
    if (known.has(identity)) continue;
    known.add(identity);
    appended.push(file);
  }

  return appended;
}

export function appendFilesWithUniqueOutputNames(existingFiles, newFiles, outputNameForFile) {
  const files = [...(existingFiles || [])];
  const added = [];
  const rejected = [];
  const knownOutputNames = new Set(files.flatMap((file) => outputNamesForFile(outputNameForFile, file).map(normalizedOutputName)));

  for (const file of newFiles || []) {
    const outputNames = outputNamesForFile(outputNameForFile, file);
    const duplicateOutputName = outputNames.find((outputName) => knownOutputNames.has(normalizedOutputName(outputName)));
    if (duplicateOutputName) {
      rejected.push({ file, outputName: duplicateOutputName });
      continue;
    }
    outputNames.forEach((outputName) => knownOutputNames.add(normalizedOutputName(outputName)));
    files.push(file);
    added.push(file);
  }

  return { files, added, rejected };
}

export function retainUnfinishedRows(rows) {
  return Array.from(rows || []).filter((row) => row.status !== "done");
}

function imageFileIdentity(file) {
  return [file?.name || "", file?.size || 0, file?.lastModified || 0].join("\\u0000");
}

function normalizedOutputName(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US");
}

function outputNamesForFile(outputNameForFile, file) {
  const values = outputNameForFile(file);
  return Array.from(Array.isArray(values) ? values : [values])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function isSupportedImageFile(file) {
  const type = String(file?.type || "").toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.has(type)) {
    return true;
  }

  const name = String(file?.name || file?.webkitRelativePath || "");
  return !type && SUPPORTED_IMAGE_EXTENSION.test(name);
}
