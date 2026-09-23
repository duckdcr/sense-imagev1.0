import { normalizeManualFabricSku } from "./manualFabricIdentity.js";

export function skuFromFabricName(fileName) {
  const sku = normalizeManualFabricSku(fileName)
    .replace(/_(?:grommet|double-pinch)$/i, "");
  return sanitizeSku(sku || "fabric");
}

export function outputNameForFabric(fileName) {
  return buildOutputName(skuFromFabricName(fileName), "_sence", "jpg");
}

export function outputNameForCurtainCreation(fileName) {
  return buildOutputName(skuFromFabricName(fileName), "_sence", "jpg");
}

export function outputNameForCurtainProduct(fileName) {
  return buildOutputName(skuFromFabricName(fileName), "_curtain", "jpg");
}

export function sanitizeFileNamePart(value) {
  return String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_");
}

export function buildOutputName(sku, suffix = "", extension = "jpg") {
  const normalizedSku = sanitizeSku(sku || "fabric");
  const normalizedExtension = String(extension || "jpg").replace(/^\.+/, "").toLowerCase();
  return `${normalizedSku}${sanitizeFileNamePart(suffix)}.${normalizedExtension}`;
}

function sanitizeSku(value) {
  return String(value)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_");
}
