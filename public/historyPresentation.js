const PRODUCT_TASK_TYPE = "curtain_product";
const CUSTOM_TASK_TYPE = "custom_generation";
const STANDARD_PRODUCT = Object.freeze({
  finishedWidthCm: 330,
  finishedHeightCm: 270,
  fullness: 2,
  flatWidthCm: 660,
});

export function historyTaskLabel(taskType) {
  if (taskType === PRODUCT_TASK_TYPE) return "白底成品窗帘";
  if (taskType === "curtain_creation") return "新增窗帘";
  if (taskType === CUSTOM_TASK_TYPE) return "自定义生图";
  return "白底图生成";
}

export function historyCardSources(entry = {}) {
  const result = {
    kind: "result",
    url: imageUrl(entry.resultUrl),
    name: entry.outputName || "生成图",
    label: "成品图",
  };
  if (entry.taskType !== PRODUCT_TASK_TYPE) return result.url ? [result] : [];

  return [
    result,
    {
      kind: "fabric",
      url: imageUrl(entry.fabricUrl),
      name: entry.fabricName || "面料图",
      label: "面料图",
    },
  ].filter((source) => source.url);
}

export function historyProductResults(entry = {}) {
  if (entry.taskType !== PRODUCT_TASK_TYPE) return [];

  const nested = entry.results && typeof entry.results === "object" ? entry.results : {};
  const hasDualResultSchema = [
    "grommetResultUrl",
    "grommetOutputName",
    "doublePinchResultUrl",
    "doublePinchOutputName",
  ].some((key) => Object.hasOwn(entry, key))
    || Object.hasOwn(nested, "grommet")
    || Object.hasOwn(nested, "doublePinch");

  const definitions = [
    {
      kind: "grommet",
      url: nested.grommet?.url ?? entry.grommetResultUrl,
      name: nested.grommet?.outputName ?? entry.grommetOutputName,
      label: "圆孔帘",
    },
    {
      kind: "doublePinch",
      url: nested.doublePinch?.url ?? entry.doublePinchResultUrl,
      name: nested.doublePinch?.outputName ?? entry.doublePinchOutputName,
      label: "韩式双捏褶帘",
    },
  ];

  if (hasDualResultSchema) {
    return definitions
      .map((result) => ({
        ...result,
        url: imageUrl(result.url),
        name: imageName(result.name, result.label),
      }))
      .filter((result) => result.url);
  }

  const legacyUrl = imageUrl(entry.resultUrl);
  return legacyUrl
    ? [{ kind: "result", url: legacyUrl, name: imageName(entry.outputName, "生成图"), label: "成品图" }]
    : [];
}

export function historyCardResults(entry = {}) {
  if (entry.taskType === PRODUCT_TASK_TYPE) return historyProductResults(entry);
  return historyCardSources(entry);
}

export function buildHistoryDetailView(entry = {}) {
  const isProduct = entry.taskType === PRODUCT_TASK_TYPE;
  const isCustom = entry.taskType === CUSTOM_TASK_TYPE;
  const sceneUrl = isProduct ? "" : imageUrl(entry.sceneUrl);
  const prompt = typeof entry.prompt === "string" ? entry.prompt : "";
  const effectivePrompt = isProduct && typeof entry.effectivePrompt === "string"
    ? entry.effectivePrompt.trim()
    : "";
  return {
    showScene: Boolean(sceneUrl),
    showProductParameters: isProduct || isCustom,
    ...(isCustom ? { sceneLabel: "参考图" } : {}),
    prompt: effectivePrompt
      ? entry.effectivePrompt
      : prompt,
    userPrompt: effectivePrompt && prompt.trim() && prompt.trim() !== effectivePrompt
      ? prompt
      : "",
    productParameters: isProduct
      ? formatProductParameters(entry.product)
      : isCustom
        ? formatCustomParameters(entry.options)
        : "",
    results: isProduct ? historyProductResults(entry) : historyCardSources(entry),
    resultUrl: imageUrl(entry.resultUrl),
    sceneUrl,
    fabricUrl: imageUrl(entry.fabricUrl),
  };
}

function formatCustomParameters(options = {}) {
  const parts = [];
  if (typeof options?.quality === "string" && options.quality) parts.push(`画质 ${options.quality}`);
  if (typeof options?.size === "string" && options.size) parts.push(`分辨率 ${actualOutputSize(options.size)}`);
  return parts.join(" · ");
}

function actualOutputSize(size) {
  const sizes = {
    "1024x1024": "1024 × 1024",
    "2048x2048": "2K · 2048 × 2048",
    "2880x2880": "最大方图 · 2880 × 2880",
    "3840x2160": "4K 横图 · 3840 × 2160",
    "2160x3840": "4K 竖图 · 2160 × 3840",
    "1536x1024": "1536 × 1024",
    "1024x1536": "1024 × 1536",
    "2048x1152": "1672 × 941",
    "1152x2048": "941 × 1672",
  };
  return sizes[size] || size.replace("x", " × ");
}

function imageUrl(value) {
  return typeof value === "string" ? value.trim() : "";
}

function imageName(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatProductParameters(product = {}) {
  const width = positiveNumber(product?.finishedWidthCm) ?? STANDARD_PRODUCT.finishedWidthCm;
  const height = positiveNumber(product?.finishedHeightCm) ?? STANDARD_PRODUCT.finishedHeightCm;
  const fullness = positiveNumber(product?.fullness) ?? STANDARD_PRODUCT.fullness;
  const flatWidth = positiveNumber(product?.flatWidthCm) ?? STANDARD_PRODUCT.flatWidthCm;
  const vertical = positiveNumber(product?.patternRepeatVerticalCm);
  const horizontal = positiveNumber(product?.patternRepeatHorizontalCm);
  const mode = patternScaleMode(product, vertical, horizontal);
  const parts = [
    `成品尺寸 ${formatNumber(width)} × ${formatNumber(height)} cm`,
    `${formatNumber(fullness)} 倍褶皱`,
    `平铺布宽 ${formatNumber(flatWidth)} cm`,
    `比例模式 ${mode === "adaptive" ? "自适应" : "已知花回"}`,
  ];

  if (vertical !== null) parts.push(`纵向花回 ${formatNumber(vertical)} cm`);
  if (horizontal !== null) parts.push(`横向花回 ${formatNumber(horizontal)} cm`);
  return parts.join(" · ");
}

function patternScaleMode(product, vertical, horizontal) {
  const mode = product?.patternScaleMode ?? product?.patternScale?.mode ?? product?.mode;
  if (mode === "adaptive") return "adaptive";
  if (mode === "known") return "known";
  return vertical !== null || horizontal !== null ? "known" : "adaptive";
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}
