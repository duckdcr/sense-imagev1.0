import { buildCurtainReplacementPrompt } from "./curtainPrompt.js";
import { buildCurtainCreationPrompt } from "./curtainCreationPrompt.js";
import { buildCurtainProductPrompt } from "./curtainProductPrompt.js";

export const API_BASE_URL = "https://api.www-cx-api.cn.mt/v1";
export const IMAGE_MODEL = "gpt-image-2";
export const IMAGE_SIZE = "2048x2048";
export const IMAGE_QUALITY = "high";
export const CURTAIN_PRODUCT_SIZE = "2048x2048";
export const IMAGE_SIZE_OPTIONS = Object.freeze([
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2880x2880",
  "3840x2160",
  "2160x3840",
  "2048x1152",
  "1152x2048",
  "2048x1536",
  "1536x2048",
]);
export const IMAGE_QUALITY_OPTIONS = Object.freeze(["auto", "low", "medium", "high"]);

export const DEFAULT_PROMPT =
  "Keep the room, camera angle, curtain shape, folds, lighting, shadows, and perspective consistent. Replace only the curtain fabric with the uploaded fabric reference. Preserve the fabric texture, scale, color, and pattern accurately. Output a clean photorealistic result.";

const FULL_FOCUS_CONSTRAINT = "Hard clarity requirement: keep the entire image in sharp focus. Every foreground, background, subject, and detail must be clear. Do not use depth of field, shallow focus, background blur, foreground blur, selective blur, lens blur, or bokeh.";

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

export function buildReplacementPrompt(userPrompt, pattern = {}) {
  return buildCurtainReplacementPrompt({
    extraPrompt: userPrompt,
    patternRepeatVerticalCm: pattern.patternRepeatVerticalCm,
    patternRepeatHorizontalCm: pattern.patternRepeatHorizontalCm,
  });
}

export function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!match) {
    throw new Error("Invalid image data.");
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

export async function dataUrlFromImageResponse(response, fetchImpl = fetch, fallbackMimeType = "image/png") {
  const item = findImageItem(response);

  if (item.b64_json) {
    return `data:${fallbackMimeType};base64,${item.b64_json}`;
  }

  const base64 = item.image_base64 || item.base64 || item.image;
  if (typeof base64 === "string" && /^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    return `data:${fallbackMimeType};base64,${base64.replace(/\s+/g, "")}`;
  }

  if (item.url) {
    const remote = await fetchImpl(item.url);
    if (!remote.ok) {
      throw new Error(`Image download failed: HTTP ${remote.status}`);
    }
    const mimeType = remote.headers.get("content-type") || "image/png";
    const bytes = Buffer.from(await remote.arrayBuffer());
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
  }

  throw new Error("No image data returned from API.");
}

export function imagePayloadFromDataUrl(file) {
  const parsed = parseDataUrl(file.dataUrl);
  return {
    name: file.name || "image.png",
    mimeType: file.type || parsed.mimeType,
    buffer: parsed.buffer,
  };
}

export function buildEditFormData({
  scene,
  fabric,
  prompt,
  size = IMAGE_SIZE,
  quality = IMAGE_QUALITY,
  outputFormat = "",
  outputCompression = null,
  patternRepeatVerticalCm = null,
  patternRepeatHorizontalCm = null,
  taskType = "replacement",
  fixedPrompt = "",
}) {
  const sceneImage = imagePayloadFromDataUrl(scene);
  const fabricImage = imagePayloadFromDataUrl(fabric);
  const finalPrompt = taskType === "creation"
    ? buildCurtainCreationPrompt({ extraPrompt: prompt, fixedPrompt, canvasAspectRatio: aspectRatioForSize(size) })
    : buildReplacementPrompt(prompt, { patternRepeatVerticalCm, patternRepeatHorizontalCm });
  const form = createImageFormData({
    prompt: finalPrompt,
    size,
    quality,
    outputFormat,
    outputCompression,
  });
  appendImage(form, sceneImage);
  appendImage(form, fabricImage);

  return form;
}

export function buildCurtainProductFormData({
  headingStyle,
  template,
  fabric,
  repeatImage = null,
  prompt,
  quality = IMAGE_QUALITY,
  size = IMAGE_SIZE,
  patternRepeatVerticalCm = null,
  patternRepeatHorizontalCm = null,
  fabricSampleSizeCm = null,
  fixedPrompt = "",
  fabricMode = null,
  fabricMetadata = null,
  scale = null,
}) {
  const templateImage = imagePayloadFromDataUrl(template);
  const fabricImage = imagePayloadFromDataUrl(fabric);
  const repeatImagePayload = repeatImage ? imagePayloadFromDataUrl(repeatImage) : null;
  const resolvedFabricMode = fabricMode || fabricMetadata?.fabricMode || null;
  if (resolvedFabricMode === "repeat" && !repeatImagePayload) {
    throw new Error("有花位面料缺少完整花位图（Image 3）。");
  }
  const finalPrompt = buildCurtainProductPrompt({
    headingStyle,
    extraPrompt: prompt,
    patternRepeatVerticalCm,
    patternRepeatHorizontalCm,
    fabricSampleSizeCm,
    canvasAspectRatio: aspectRatioForSize(size),
    fixedPrompt,
    fabricMode: resolvedFabricMode,
    fabricMetadata,
    scale,
  });
  const form = createImageFormData({
    prompt: finalPrompt,
    size,
    quality,
    outputFormat: "webp",
    outputCompression: 90,
  });
  appendImage(form, templateImage);
  appendImage(form, fabricImage);
  if (resolvedFabricMode === "repeat") appendImage(form, repeatImagePayload);

  return form;
}

function aspectRatioForSize(size) {
  const [width, height] = String(size || "").split("x").map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return "1:1";
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function buildCustomEditFormData({
  reference,
  prompt,
  size = IMAGE_SIZE,
  quality = IMAGE_QUALITY,
}) {
  const referenceImage = imagePayloadFromDataUrl(reference);
  const form = createImageFormData({
    prompt: [String(prompt || "").trim(), FULL_FOCUS_CONSTRAINT].filter(Boolean).join("\n\n"),
    size,
    quality,
    outputFormat: "jpeg",
    outputCompression: 100,
  });
  appendImage(form, referenceImage);
  return form;
}

export function isSupportedImageSize(value) {
  return IMAGE_SIZE_OPTIONS.includes(value);
}

export function isSupportedImageQuality(value) {
  return IMAGE_QUALITY_OPTIONS.includes(value);
}

function createImageFormData({ prompt, size, quality, outputFormat, outputCompression }) {
  const form = new FormData();

  form.append("model", IMAGE_MODEL);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", quality);
  form.append("n", "1");
  appendOutputOptions(form, outputFormat, outputCompression);

  return form;
}

function appendOutputOptions(form, outputFormat, outputCompression) {
  if (outputFormat) {
    form.append("output_format", outputFormat);
  }

  if (outputCompression === null || outputCompression === undefined || outputCompression === "") {
    return;
  }

  const isNumericType = typeof outputCompression === "number" || typeof outputCompression === "string";
  const hasInvalidWhitespace = typeof outputCompression === "string"
    && outputCompression.trim() !== outputCompression;
  const numericCompression = Number(outputCompression);
  if (!isNumericType || hasInvalidWhitespace || !Number.isFinite(numericCompression)
    || numericCompression < 0 || numericCompression > 100) {
    throw new TypeError("outputCompression must be a finite number from 0 to 100.");
  }
  if (outputFormat !== "jpeg" && outputFormat !== "webp") {
    throw new TypeError("outputFormat must be jpeg or webp when outputCompression is supplied.");
  }

  form.append("output_compression", String(numericCompression));
}

function appendImage(form, image) {
  form.append("image[]", new Blob([image.buffer], { type: image.mimeType }), image.name);
}

function findImageItem(response) {
  if (response?.data?.[0]) {
    return response.data[0];
  }

  if (Array.isArray(response?.output)) {
    for (const output of response.output) {
      if (output?.b64_json || output?.url || output?.image_base64 || output?.base64 || output?.image) {
        return output;
      }
      if (Array.isArray(output?.content)) {
        const content = output.content.find((item) => item?.b64_json || item?.url || item?.image_base64 || item?.base64 || item?.image);
        if (content) {
          return content;
        }
      }
    }
  }

  return {};
}
