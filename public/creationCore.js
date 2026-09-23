const OPTIONS = Object.freeze({
  installation: new Set(["ceiling", "wall", "recess"]),
  length: new Set(["floor", "below_sill", "sill"]),
  opening: new Set(["center", "left", "right", "closed"]),
  sceneMode: new Set(["empty", "with_curtains"]),
});

export function skuFromCreationFabric(fileName) {
  const name = String(fileName || "").split(/[\\/]/).pop() || "fabric";
  return (name.replace(/\.[^.]+$/, "").replace(/_(?:detail|grommet|double-pinch)$/i, "") || "fabric")
    .trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, "_");
}

export function outputNameForCreation(fileName) {
  return buildOutputName(skuFromCreationFabric(fileName), "", "_sence", "jpg");
}

export function normalizeCreationSettings(settings = {}) {
  const source = { ...settings, sceneMode: settings.sceneMode ?? "empty" };
  const result = {};
  for (const [key, values] of Object.entries(OPTIONS)) {
    if (!values.has(source[key])) throw new Error(`${key} 选项无效`);
    result[key] = source[key];
  }
  return result;
}

export function createCreationRows(files) {
  return Array.from(files || []).map((file, index) => ({
    id: `${file.name}-${file.size || 0}-${file.lastModified || 0}-${index}`,
    file,
    outputName: outputNameForCreation(file.name),
    previewUrl: URL.createObjectURL(file),
    imageDataUrl: "",
    status: "pending",
    error: "",
    selected: false,
  }));
}

export function buildOutputName(sku, prefix = "", suffix = "", extension = "jpg") {
  const clean = (value) => String(value ?? "").trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, "_");
  return `${clean(prefix)}${clean(sku || "fabric")}${clean(suffix)}.${String(extension || "jpg").replace(/^\.+/, "")}`;
}
