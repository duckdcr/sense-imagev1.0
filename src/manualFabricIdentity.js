function fileStem(fileName) {
  const baseName = String(fileName || "").split(/[\\/]/).pop() || "";
  return baseName.replace(/\.[^.]+$/, "").trim();
}

export function sampleSizeFromManualFabricName(fileName) {
  const match = fileStem(fileName).match(/_detail_(10|15)$/i);
  return match ? Number(match[1]) : null;
}

export function normalizeManualFabricSku(fileName) {
  return fileStem(fileName)
    .replace(/_detail_(?:10|15)$/i, "")
    .replace(/_detail$/i, "")
    .replace(/\s*[（(]\d+[）)]\s*$/, "")
    .trim();
}
