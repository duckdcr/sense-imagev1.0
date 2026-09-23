import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import heicConvert from "heic-convert";

import {
  API_BASE_URL,
  buildCustomEditFormData,
  buildCurtainProductFormData,
  buildEditFormData,
  dataUrlFromImageResponse,
  isSupportedImageQuality,
  isSupportedImageSize,
  normalizeBaseUrl,
  parseDataUrl,
} from "./src/imageApi.js";
import { createCurtainDatabaseService } from "./src/curtainDatabase.js";
import {
  CURTAIN_PRODUCT_STYLES,
  curtainProductOutputName,
  normalizeCurtainProductStyle,
} from "./src/curtainProductStyles.js";
import { createGenerationJobService } from "./src/generationJobs.js";
import { CURTAIN_CREATION_FIXED_PROMPT, CURTAIN_INSTALLATIONS, CURTAIN_LENGTHS, CURTAIN_OPENINGS, CURTAIN_SCENE_MODES } from "./src/curtainCreationPrompt.js";
import {
  MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT,
  MANUAL_CURTAIN_PRODUCT_REPEAT_PROMPT,
} from "./src/curtainProductPrompt.js";
import { createFabricCatalog } from "./src/fabricCatalog.js";
import { calculateManualProductScale } from "./src/manualProductScale.js";
import {
  PromptSettingsError,
  createPromptSettingsStore,
  withCurrentFixedPrompt,
} from "./src/promptSettings.js";
import {
  CURTAIN_SCENE_TEMPLATES,
  RANDOM_CURTAIN_SCENE_TEMPLATE_ID,
  curtainSceneTemplateById,
  normalizeCurtainSceneTemplateId,
} from "./src/curtainSceneTemplates.js";
import {
  outputNameForCurtainCreation,
  skuFromFabricName,
} from "./src/naming.js";
import { manualCurtainProductOutputName } from "./src/manualProductOutputName.js";
import { CURTAIN_PRODUCT } from "./src/patternScale.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_HISTORY_DIR = path.join(__dirname, "data", "history");
const DEFAULT_PROMPT_SETTINGS_PATH = path.join(__dirname, "config", "prompts.json");
const FABRIC_SERIES_STORAGE_ROOT = "/Users/wangyuanzi/Documents/code/work2/test";
const DEFAULT_FABRIC_CATALOG_ROOT = path.join(FABRIC_SERIES_STORAGE_ROOT, "32");
const DEFAULT_FABRIC_CATALOG_CSV_PATH = "/Users/wangyuanzi/Documents/code/work2/test/32/比利时门店居莱 - Volume#32（已完成）.csv";
const DEFAULT_FABRIC_CATALOG_REPEAT_IMAGE_DIR = "/Users/wangyuanzi/Documents/code/work2/test/32/居莱/花位图";
const DEFAULT_CURTAIN_PRODUCT_TEMPLATE_PATHS = Object.freeze(Object.fromEntries(
  Object.entries(CURTAIN_PRODUCT_STYLES).map(([style, definition]) => [
    style,
    path.join(__dirname, "assets", "curtain-product", definition.templateFile),
  ]),
));
const DEFAULT_CURTAIN_SCENE_TEMPLATE_PATHS = Object.freeze(Object.fromEntries(
  CURTAIN_SCENE_TEMPLATES.map((template) => [
    template.id,
    path.join(__dirname, "assets", "curtain-scene", template.fileName),
  ]),
));
const HISTORY_ASSET_ROUTE = "/history-assets/";
const MAX_JSON_BYTES = 40 * 1024 * 1024;
const MAX_PRODUCT_PROMPT_CHARS = 20_000;
const MAX_EFFECTIVE_PROMPT_CHARS = 100_000;
const DEFAULT_PRODUCT_GENERATION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PRODUCT_GENERATION_MAX_PENDING = 100;
const RETRYABLE_UPSTREAM_STATUS = new Set([429, 502, 503, 504]);
const TEMPORARY_UPSTREAM_STATUS = new Set([502, 503, 504]);
const RETRYABLE_UPSTREAM_ERROR = /concurrency limit exceeded|rate limit exceeded|too many requests|retry later/i;
const GENERATE_RETRY_COUNT = 5;
const GENERATE_RETRY_DELAY_MS = 1200;
const MAX_RETRY_DELAY_MS = 15000;
const MIN_ASYNC_POLL_DELAY_MS = 5000;

export function createAppServer({
  fetchImpl = fetch,
  historyDir = DEFAULT_HISTORY_DIR,
  retryDelayMs = GENERATE_RETRY_DELAY_MS,
  asyncPollDelayMs = MIN_ASYNC_POLL_DELAY_MS,
  databaseService = createCurtainDatabaseService(),
  historyFileOps = {},
  curtainProductTemplatePaths = DEFAULT_CURTAIN_PRODUCT_TEMPLATE_PATHS,
  curtainSceneTemplatePaths = DEFAULT_CURTAIN_SCENE_TEMPLATE_PATHS,
  saveHistoryEntry: saveHistoryEntryOverride,
  clock = Date.now,
  curtainProductGenerationTtlMs = DEFAULT_PRODUCT_GENERATION_TTL_MS,
  curtainProductGenerationMaxPending = DEFAULT_PRODUCT_GENERATION_MAX_PENDING,
  historyEntryMapper = toPublicHistoryEntry,
  random = Math.random,
  fabricCatalog = createFabricCatalog({
    csvPath: DEFAULT_FABRIC_CATALOG_CSV_PATH,
    repeatImageDir: DEFAULT_FABRIC_CATALOG_REPEAT_IMAGE_DIR,
  }),
  fabricCatalogResolver: fabricCatalogResolverOverride,
  promptSettings = createPromptSettingsStore({
    filePath: DEFAULT_PROMPT_SETTINGS_PATH,
    defaults: {
      manual_product_plain: MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT,
      manual_product_repeat: MANUAL_CURTAIN_PRODUCT_REPEAT_PROMPT,
      curtain_creation: CURTAIN_CREATION_FIXED_PROMPT,
    },
  }),
} = {}) {
  const historyStore = createHistoryStore(historyDir, historyFileOps, historyEntryMapper);
  const saveHistoryEntry = saveHistoryEntryOverride || historyStore.saveEntry;
  const curtainProductGenerations = createCurtainProductGenerationRegistry({
    clock,
    ttlMs: curtainProductGenerationTtlMs,
    maxPending: curtainProductGenerationMaxPending,
  });
  const curtainProductTemplatePromises = new Map();
  const curtainSceneTemplatePromises = new Map();
  const fabricCatalogPromisesByRoot = new Map();
  const resolveFabricCatalog = fabricCatalogResolverOverride || (async (catalogRoot) => {
    const normalizedRoot = normalizeFabricCatalogRoot(catalogRoot);
    if (!normalizedRoot || normalizedRoot === DEFAULT_FABRIC_CATALOG_ROOT) return fabricCatalog;
    if (!fabricCatalogPromisesByRoot.has(normalizedRoot)) {
      fabricCatalogPromisesByRoot.set(normalizedRoot, createFabricCatalogForRoot(normalizedRoot)
        .catch((error) => {
          fabricCatalogPromisesByRoot.delete(normalizedRoot);
          throw error;
        }));
    }
    return fabricCatalogPromisesByRoot.get(normalizedRoot);
  });
  const getCurtainProductTemplate = (headingStyle) => {
    const normalizedStyle = normalizeCurtainProductStyle(headingStyle);
    if (!curtainProductTemplatePromises.has(normalizedStyle)) {
      const templatePath = curtainProductTemplatePaths[normalizedStyle];
      curtainProductTemplatePromises.set(normalizedStyle, readFile(templatePath)
        .then((buffer) => ({
          name: CURTAIN_PRODUCT_STYLES[normalizedStyle].templateFile,
          type: "image/png",
          dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
        }))
        .catch((error) => {
          throw new GenerationRequestError(500, "固定窗帘产品模板读取失败。", { cause: error });
        }));
    }
    return curtainProductTemplatePromises.get(normalizedStyle);
  };
  const getCurtainSceneTemplate = async (sceneTemplateId) => {
    const template = curtainSceneTemplateById(resolveCurtainSceneTemplateId(sceneTemplateId, curtainSceneTemplatePaths, random));
    if (!curtainSceneTemplatePromises.has(template.id)) {
      const templatePath = curtainSceneTemplatePaths[template.id];
      curtainSceneTemplatePromises.set(template.id, readFile(templatePath)
        .then((buffer) => ({
          name: template.fileName,
          type: mimeType(templatePath),
          dataUrl: `data:${mimeType(templatePath)};base64,${buffer.toString("base64")}`,
        }))
        .catch((error) => {
          curtainSceneTemplatePromises.delete(template.id);
          throw new GenerationRequestError(409, "所选内置场景图尚未添加。", { cause: error });
        }));
    }
    const scene = await curtainSceneTemplatePromises.get(template.id);
    return { sceneTemplateId: template.id, scene };
  };
  const generationJobs = createGenerationJobService({
    worker: async ({ kind, payload, apiKey, __idempotencyKey }) => {
      const queuedPayload = { ...payload, __queueConcurrencyManaged: true, __idempotencyKey };
      const effectivePayload = await withCurrentFixedPrompt(kind, queuedPayload, promptSettings);
      if (kind === "manual") {
        return executeManualGeneration(effectivePayload, apiKey, fetchImpl, retryDelayMs, asyncPollDelayMs);
      }
      if (kind === "manual_product") {
        return executeManualCurtainProductGeneration(
          effectivePayload,
          apiKey,
          fetchImpl,
          retryDelayMs,
          asyncPollDelayMs,
          getCurtainProductTemplate,
          saveHistoryEntry,
          resolveFabricCatalog,
          promptSettings,
        );
      }
      if (kind === "database") {
        return executeDatabaseGeneration(
          effectivePayload,
          apiKey,
          fetchImpl,
          retryDelayMs,
          asyncPollDelayMs,
          databaseService,
          saveHistoryEntry,
        );
      }
      if (kind === "database_product") {
        if (effectivePayload.clientHistory === true) {
          return executeDatabaseProductGeneration(
            effectivePayload,
            apiKey,
            fetchImpl,
            retryDelayMs,
            asyncPollDelayMs,
            databaseService,
            getCurtainProductTemplate,
          );
        }
        return (async () => {
          const reservation = curtainProductGenerations.reserve();
          try {
            return await executeDatabaseProductGeneration(
              effectivePayload,
              apiKey,
              fetchImpl,
              retryDelayMs,
              asyncPollDelayMs,
              databaseService,
              getCurtainProductTemplate,
              (record) => curtainProductGenerations.register(reservation, record),
            );
          } finally {
            curtainProductGenerations.release(reservation);
          }
        })();
      }
      if (kind === "creation") {
        return executeCurtainCreation(effectivePayload, apiKey, fetchImpl, retryDelayMs, asyncPollDelayMs, getCurtainSceneTemplate, saveHistoryEntry);
      }
      if (kind === "custom") {
        return executeCustomGeneration(effectivePayload, apiKey, fetchImpl, retryDelayMs, asyncPollDelayMs, saveHistoryEntry);
      }
      throw new Error("Unsupported generation job kind.");
    },
    isConcurrencyLimitError: (error) => error?.upstreamConcurrencyLimit === true,
  });

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/generation-concurrency") {
        sendJson(response, 200, generationJobs.getConcurrency());
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/generation-concurrency") {
        const payload = await readJsonBody(request);
        sendJson(response, 200, generationJobs.setConcurrency(payload.concurrency));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/generation-batches") {
        await handleCreateGenerationBatch(request, response, generationJobs);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/image-preview") {
        await handleImagePreview(request, response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/manual-product/fabric-metadata") {
        await handleManualFabricMetadata(request, response, resolveFabricCatalog);
        return;
      }

      const batchJobMatch = /^\/api\/generation-batches\/([^/]+)\/jobs$/.exec(url.pathname);
      if (request.method === "POST" && batchJobMatch) {
        await handleEnqueueGenerationJob(
          request,
          response,
          batchJobMatch[1],
          generationJobs,
        );
        return;
      }

      const batchStatusMatch = /^\/api\/generation-batches\/([^/]+)\/status$/.exec(url.pathname);
      if (request.method === "POST" && batchStatusMatch) {
        await handleGenerationBatchStatus(request, response, batchStatusMatch[1], generationJobs);
        return;
      }

      const batchControlMatch = /^\/api\/generation-batches\/([^/]+)\/(pause|resume)$/.exec(url.pathname);
      if (request.method === "POST" && batchControlMatch) {
        handleGenerationBatchControl(response, batchControlMatch[1], batchControlMatch[2], generationJobs);
        return;
      }

      const generationJobMatch = /^\/api\/generation-jobs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && generationJobMatch) {
        handleGetGenerationJob(response, generationJobMatch[1], generationJobs);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/models") {
        await handleModels(request, response, fetchImpl, retryDelayMs);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/curtain-scene-templates") {
        handleListCurtainSceneTemplates(response, curtainSceneTemplatePaths);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/editable-prompt-templates") {
        sendJson(response, 200, await promptSettings.readAll());
        return;
      }

      const editablePromptMatch = /^\/api\/editable-prompt-templates\/([^/]+)$/.exec(url.pathname);
      if (request.method === "PUT" && editablePromptMatch) {
        const payload = await readJsonBody(request);
        try {
          const kind = decodeURIComponent(editablePromptMatch[1]);
          const prompt = await promptSettings.save(kind, payload.prompt);
          sendJson(response, 200, { kind, prompt });
        } catch (error) {
          const status = error instanceof PromptSettingsError
            ? error.code === "UNSUPPORTED_PROMPT_KIND" ? 404 : 400
            : 500;
          sendJson(response, status, { error: error.message || "提示词保存失败" });
        }
        return;
      }

      if (request.method === "DELETE" && editablePromptMatch) {
        try {
          const kind = decodeURIComponent(editablePromptMatch[1]);
          const prompt = await promptSettings.reset(kind);
          sendJson(response, 200, { kind, prompt });
        } catch (error) {
          const status = error instanceof PromptSettingsError
            ? error.code === "UNSUPPORTED_PROMPT_KIND" ? 404 : 400
            : 500;
          sendJson(response, status, { error: error.message || "恢复默认提示词失败" });
        }
        return;
      }

      const sceneTemplateImageMatch = /^\/api\/curtain-scene-templates\/([^/]+)\/image$/.exec(url.pathname);
      if ((request.method === "GET" || request.method === "HEAD") && sceneTemplateImageMatch) {
        await serveCurtainSceneTemplateImage(request, response, sceneTemplateImageMatch[1], curtainSceneTemplatePaths);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/generate") {
        await handleGenerate(request, response, fetchImpl, retryDelayMs, asyncPollDelayMs);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/database/jobs") {
        await handleDatabaseJobs(response, url, databaseService);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/database/asset") {
        await handleDatabaseAsset(request, response, url, databaseService);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/database/generate") {
        await handleDatabaseGenerate(
          request,
          response,
          fetchImpl,
          retryDelayMs,
          asyncPollDelayMs,
          databaseService,
          saveHistoryEntry,
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/database/product-history") {
        await handleDatabaseProductHistory(request, response, curtainProductGenerations, saveHistoryEntry);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/history") {
        await handleListHistory(request, response, historyStore.listEntriesPage);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/history") {
        await handleCreateHistory(request, response, saveHistoryEntry);
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/history/day") {
        await handleDeleteHistoryDay(request, response, historyStore);
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith(HISTORY_ASSET_ROUTE)) {
        await serveHistoryAsset(request, response, url, historyDir);
        return;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        await serveStatic(request, response, url);
        return;
      }

      sendJson(response, 405, { error: "Method not allowed." });
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.message || "Server error." });
    }
  });
}

async function handleCreateGenerationBatch(request, response, generationJobs) {
  const payload = await readJsonBody(request);
  const batch = generationJobs.createBatch(payload.concurrency);
  sendJson(response, 201, { batchId: batch.id, concurrency: batch.concurrency });
}

async function handleManualFabricMetadata(request, response, resolveFabricCatalog) {
  const payload = await readJsonBody(request);
  const fallbackSampleSizeCm = Number(payload?.fallbackSampleSizeCm);
  if (![10, 15].includes(fallbackSampleSizeCm)) {
    sendJson(response, 400, { error: "实拍面料尺寸必须为 10 cm 或 15 cm。" });
    return;
  }
  if (!Array.isArray(payload?.fileNames) || payload.fileNames.some((name) => typeof name !== "string" || !name.trim())) {
    sendJson(response, 400, { error: "fileNames 必须是非空文件名数组。" });
    return;
  }

  let fabricCatalog;
  try {
    fabricCatalog = await resolveFabricCatalog(payload.fabricCatalogRoot);
  } catch (error) {
    sendJson(response, 409, { error: error.message || "无法读取所选面料系列目录。" });
    return;
  }

  const items = await Promise.all(payload.fileNames.map(async (fileName) => {
    try {
      const metadata = await fabricCatalog.resolve({ fileName, fallbackSampleSizeCm });
      return {
        fileName,
        ok: true,
        metadata: publicManualFabricMetadata(metadata),
      };
    } catch (error) {
      return {
        fileName,
        ok: false,
        error: error.message || "读取面料信息失败。",
      };
    }
  }));
  sendJson(response, 200, { items });
}

function publicManualFabricMetadata(metadata) {
  const scale = calculateManualProductScale(metadata);
  return {
    sku: metadata.sku,
    sampleSizeCm: metadata.sampleSizeCm,
    sampleSizeSource: metadata.sampleSizeSource,
    fabricMode: metadata.fabricMode,
    composition: metadata.composition,
    repeatVerticalCm: metadata.repeatVerticalCm,
    repeatHorizontalCm: metadata.repeatHorizontalCm,
    repeatImageName: metadata.repeatImageName,
    repeatImageMatched: Boolean(metadata.repeatImageName),
    flatSampleSpans: {
      vertical: scale.sampleSpanVertical,
      horizontalPerPanel: scale.sampleSpanHorizontalPerPanel,
      horizontalTotal: scale.sampleSpanHorizontalTotal,
    },
    patternRepeats: metadata.fabricMode === "repeat" ? {
      vertical: scale.repeatCountVertical,
      horizontalPerPanel: scale.repeatCountHorizontalPerPanel,
      horizontalTotal: scale.repeatCountHorizontalTotal,
    } : null,
  };
}

function normalizeFabricCatalogRoot(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const raw = String(value).trim();
  if (!path.isAbsolute(raw)) {
    throw new Error("面料系列目录必须填写绝对路径。例：/Users/wangyuanzi/Documents/code/work2/test/33");
  }
  const resolved = path.resolve(raw);
  const relative = path.relative(FABRIC_SERIES_STORAGE_ROOT, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`面料系列目录必须位于 ${FABRIC_SERIES_STORAGE_ROOT} 下。`);
  }
  return resolved;
}

async function createFabricCatalogForRoot(catalogRoot) {
  let entries;
  try {
    entries = await readdir(catalogRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(`无法读取面料系列目录：${catalogRoot}；${error.message}`);
  }
  const csvFiles = entries
    .filter((entry) => entry.isFile() && /\.csv$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
  if (csvFiles.length !== 1) {
    throw new Error(`面料系列目录必须包含且仅包含一个 CSV 文件，当前找到 ${csvFiles.length} 个。`);
  }
  return createFabricCatalog({
    csvPath: path.join(catalogRoot, csvFiles[0]),
    repeatImageDir: path.join(catalogRoot, "居莱", "花位图"),
  });
}

async function handleImagePreview(request, response) {
  const payload = await readJsonBody(request);
  if (!payload?.image?.dataUrl) {
    sendJson(response, 400, { error: "缺少图片" });
    return;
  }
  try {
    const image = await createPreviewImagePayload(payload.image);
    sendJson(response, 200, { dataUrl: image.dataUrl });
  } catch (error) {
    sendJson(response, error.status || 422, { error: error.message || "图片预览转换失败" });
  }
}

async function createPreviewImagePayload(image) {
  const normalized = await normalizeHeicImagePayload(image);
  const source = parseDataUrl(normalized.dataUrl);
  const buffer = await sharp(source.buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, chromaSubsampling: "4:2:0" })
    .toBuffer();
  return {
    ...normalized,
    name: String(normalized.name || "image").replace(/\.[^.]+$/, ".jpg"),
    type: "image/jpeg",
    dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
  };
}

async function handleEnqueueGenerationJob(
  request,
  response,
  batchId,
  generationJobs,
) {
  const payload = await readJsonBody(request);
  const apiKey = apiKeyFromRequest(request, payload.payload);
  if (!apiKey) {
    sendJson(response, 400, { error: "Missing API key." });
    return;
  }
  if (!new Set(["manual", "manual_product", "database", "database_product", "creation", "custom"]).has(payload.kind)) {
    sendJson(response, 400, { error: "Unsupported generation job kind." });
    return;
  }

  try {
    if (payload.kind === "database_product") {
      validateCurtainProductGenerationRequest(payload.payload || {});
    }
    if (payload.kind === "manual_product") {
      validateManualCurtainProductGenerationRequest(payload.payload || {});
    }
    const job = generationJobs.enqueue(batchId, {
      kind: payload.kind,
      payload: payload.payload || {},
      apiKey,
    });
    sendJson(response, 202, { jobId: job.id, status: job.status });
  } catch (error) {
    sendJson(response, error.status || 404, { error: error.message || "Generation batch not found." });
  }
}

function handleGenerationBatchControl(response, batchId, action, generationJobs) {
  try {
    const batch = action === "pause"
      ? generationJobs.pause(batchId)
      : generationJobs.resume(batchId);
    sendJson(response, 200, batch);
  } catch (error) {
    sendJson(response, 404, { error: error.message || "Generation batch not found." });
  }
}

async function handleGenerationBatchStatus(request, response, batchId, generationJobs) {
  const payload = await readJsonBody(request);
  try {
    const jobs = generationJobs.getJobs(batchId, payload.jobIds);
    sendJson(response, 200, { jobs });
  } catch (error) {
    sendJson(response, 404, { error: error.message || "Generation jobs not found." });
  }
}

function handleGetGenerationJob(response, jobId, generationJobs) {
  const job = generationJobs.getJob(jobId);
  if (!job) {
    sendJson(response, 404, { error: "Generation job not found." });
    return;
  }
  sendJson(response, 200, job);
}

async function handleDatabaseJobs(response, url, databaseService) {
  let mode;
  try {
    mode = normalizeDatabaseGenerationMode(url.searchParams.get("mode"));
  } catch (error) {
    sendJson(response, 400, { error: error.message });
    return;
  }
  const taskType = url.searchParams.get("taskType") || url.searchParams.get("task") || undefined;
  const result = await databaseService.listJobs(mode, taskType);
  sendJson(response, 200, { ...result, mode });
}

async function handleDatabaseAsset(request, response, url, databaseService) {
  const imageUrl = url.searchParams.get("url") || "";
  if (!imageUrl) {
    sendJson(response, 400, { error: "Missing database image URL." });
    return;
  }

  const asset = await databaseService.readAsset(imageUrl);
  response.writeHead(200, {
    "content-type": asset.mimeType || "application/octet-stream",
    "content-length": asset.buffer.byteLength,
    "cache-control": "no-store",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(asset.buffer);
}

async function handleDatabaseGenerate(
  request,
  response,
  fetchImpl,
  retryDelayMs,
  asyncPollDelayMs,
  databaseService,
  saveHistoryEntry,
) {
  const payload = await readJsonBody(request);
  const apiKey = apiKeyFromRequest(request, payload);
  if (!apiKey) {
    sendJson(response, 400, { error: "Missing API key." });
    return;
  }

  try {
    const result = await executeDatabaseGeneration(
      payload,
      apiKey,
      fetchImpl,
      retryDelayMs,
      asyncPollDelayMs,
      databaseService,
      saveHistoryEntry,
    );
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.message || "Database generation failed." });
  }
}

async function executeDatabaseGeneration(
  payload,
  apiKey,
  fetchImpl,
  retryDelayMs,
  asyncPollDelayMs,
  databaseService,
  saveHistoryEntry,
) {
  const factorySku = String(payload.factorySku || "").trim();
  if (!factorySku) throw new GenerationRequestError(400, "Missing SKU.");

  let generationMode;
  try {
    validateImageSettings(payload);
    generationMode = normalizeDatabaseGenerationMode(payload.generationMode);
  } catch (error) {
    throw new GenerationRequestError(400, error.message || "Invalid generation request.");
  }

  const job = await databaseService.getJob(factorySku, generationMode);
  if (!job) throw new GenerationRequestError(409, "SKU 不存在、缺少素材或场景图已生成。");

  const [sceneAsset, fabricAsset] = await Promise.all([
    databaseService.readAsset(job.seriesSceneImageUrl),
    databaseService.readAsset(job.detailImageUrl),
  ]);
  const scenePayload = await normalizeHeicImagePayload(assetPayload(sceneAsset));
  const fabricPayload = await normalizeHeicImagePayload(assetPayload(fabricAsset));
  const imageDataUrl = await executeUpstreamGeneration({
    apiKey,
    fetchImpl,
    retryDelayMs,
    asyncPollDelayMs,
    idempotencyKey: payload.__idempotencyKey,
    preferredMimeType: "image/webp",
    retryConcurrencyLimit: !payload.__queueConcurrencyManaged,
    form: buildEditFormData({
      prompt: payload.prompt,
      quality: payload.quality,
      size: payload.size,
      outputFormat: "webp",
      outputCompression: 90,
      patternRepeatVerticalCm: job.patternRepeatVerticalCm,
      patternRepeatHorizontalCm: job.patternRepeatHorizontalCm,
      scene: scenePayload,
      fabric: fabricPayload,
    }),
  });

  if (payload.clientHistory === true) return { imageDataUrl };

  try {
    await saveHistoryEntry({
      outputName: `${factorySku}_sence.jpg`,
      sku: factorySku,
      prompt: payload.prompt,
      result: { dataUrl: imageDataUrl },
      scene: scenePayload,
      fabric: fabricPayload,
    });
  } catch (error) {
    return {
      imageDataUrl,
      historyError: error.message || "历史保存失败",
    };
  }

  return { imageDataUrl };
}

async function executeDatabaseProductGeneration(
  payload,
  apiKey,
  fetchImpl,
  retryDelayMs,
  asyncPollDelayMs,
  databaseService,
  getCurtainProductTemplate,
  registerCurtainProductGeneration,
) {
  validateCurtainProductGenerationPrompt(payload);
  const factorySku = String(payload.factorySku || "").trim();
  if (!factorySku) throw new GenerationRequestError(400, "Missing SKU.");

  let generationMode;
  try {
    validateImageSettings({ quality: payload.quality, size: payload.size });
    generationMode = normalizeDatabaseGenerationMode(payload.generationMode);
  } catch (error) {
    throw new GenerationRequestError(400, error.message || "Invalid generation request.");
  }

  const job = await databaseService.getJob(factorySku, generationMode, "curtain_product");
  if (!job) throw new GenerationRequestError(409, "SKU 不存在或缺少面料图。");
  if (!job.detailImageUrl) throw new GenerationRequestError(409, "SKU 缺少面料图。");

  const fabricAsset = await databaseService.readAsset(job.detailImageUrl);
  if (!fabricAsset?.buffer) throw new GenerationRequestError(409, "SKU 缺少面料图。");
  const fabricPayload = await normalizeHeicImagePayload(assetPayload(fabricAsset));
  const headingStyle = normalizeCurtainProductStyle(payload.headingStyle);
  const templatePayload = await getCurtainProductTemplate(headingStyle);
  const form = buildCurtainProductFormData({
    template: templatePayload,
    fabric: fabricPayload,
    prompt: payload.prompt,
    quality: payload.quality,
    size: payload.size,
    headingStyle,
    patternRepeatVerticalCm: job.patternRepeatVerticalCm,
    patternRepeatHorizontalCm: job.patternRepeatHorizontalCm,
  });
  const effectivePrompt = String(form.get("prompt") || "");
  if (!effectivePrompt || effectivePrompt.length > MAX_EFFECTIVE_PROMPT_CHARS) {
    throw new GenerationRequestError(400, "生成提示词长度无效。");
  }
  const imageDataUrl = await executeUpstreamGeneration({
    apiKey,
    fetchImpl,
    retryDelayMs,
    asyncPollDelayMs,
    idempotencyKey: payload.__idempotencyKey,
    preferredMimeType: "image/webp",
    retryConcurrencyLimit: !payload.__queueConcurrencyManaged,
    form,
  });
  const generationId = randomUUID();
  const output = {
    outputName: curtainProductOutputName(factorySku, headingStyle),
    imageDataUrl,
  };
  if (registerCurtainProductGeneration) registerCurtainProductGeneration({
    generationId,
    factorySku,
    generationMode,
    prompt: payload.prompt,
    effectivePrompt,
    pattern: {
      patternRepeatVerticalCm: job.patternRepeatVerticalCm,
      patternRepeatHorizontalCm: job.patternRepeatHorizontalCm,
    },
    product: {
      ...CURTAIN_PRODUCT,
      patternRepeatVerticalCm: job.patternRepeatVerticalCm,
      patternRepeatHorizontalCm: job.patternRepeatHorizontalCm,
      generationMode,
      headingStyle,
    },
    fabric: { ...fabricPayload },
    fabricSha256: sha256DataUrl(fabricPayload.dataUrl),
    headingStyle,
    output: { ...output },
    outputHash: sha256DataUrl(output.imageDataUrl),
  });

  return {
    output,
    effectivePrompt,
    generationId: registerCurtainProductGeneration ? generationId : "",
    product: {
      ...CURTAIN_PRODUCT,
      patternRepeatVerticalCm: job.patternRepeatVerticalCm,
      patternRepeatHorizontalCm: job.patternRepeatHorizontalCm,
      generationMode,
      headingStyle,
    },
  };
}

async function handleDatabaseProductHistory(request, response, curtainProductGenerations, saveHistoryEntry) {
  const payload = await readJsonBody(request);
  let normalized;
  try {
    normalized = await validateDatabaseProductHistoryPayload(payload);
  } catch (error) {
    sendJson(response, 400, { error: error.message || "Invalid curtain product history payload." });
    return;
  }

  try {
    const entry = await curtainProductGenerations.finalize(normalized, (record) =>
      saveHistoryEntry({
        taskType: "curtain_product",
        generationId: record.generationId,
        sku: record.factorySku,
        outputName: record.output.outputName,
        prompt: record.prompt,
        effectivePrompt: record.effectivePrompt,
        fabric: record.fabric,
        result: { dataUrl: record.output.imageDataUrl },
        product: record.product,
      })
    );
    sendJson(response, 201, { entry });
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.message || "历史保存失败" });
  }
}

function validateCurtainProductGenerationPrompt(payload) {
  if (typeof payload?.prompt !== "string") {
    throw new GenerationRequestError(400, "产品生成 prompt 必须是字符串。");
  }
  if (payload.prompt.length > MAX_PRODUCT_PROMPT_CHARS) {
    throw new GenerationRequestError(400, "产品生成 prompt 过长。");
  }
}

function validateCurtainProductGenerationRequest(payload) {
  validateCurtainProductGenerationPrompt(payload);
  if (typeof payload.factorySku !== "string" || !payload.factorySku.trim()) {
    throw new GenerationRequestError(400, "Missing SKU.");
  }
  try {
    validateImageSettings({ quality: payload.quality, size: payload.size });
    normalizeDatabaseGenerationMode(payload.generationMode);
    normalizeCurtainProductStyle(payload.headingStyle);
  } catch (error) {
    if (error instanceof GenerationRequestError) throw error;
    throw new GenerationRequestError(400, error.message || "Invalid curtain product generation request.");
  }
}

async function validateDatabaseProductHistoryPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid curtain product history payload.");
  }
  if (typeof payload.factorySku !== "string" || !payload.factorySku.trim()) {
    throw new Error("Missing SKU.");
  }
  if (typeof payload.prompt !== "string") throw new Error("Invalid prompt.");
  if (payload.prompt.length > MAX_PRODUCT_PROMPT_CHARS) {
    throw new Error("Prompt is too long.");
  }
  if (typeof payload.effectivePrompt !== "string" || !payload.effectivePrompt.trim()) {
    throw new Error("Missing effective prompt.");
  }
  if (payload.effectivePrompt.length > MAX_EFFECTIVE_PROMPT_CHARS) {
    throw new Error("Effective prompt is too long.");
  }
  if (!isUuid(payload.generationId)) throw new Error("Invalid generation ID.");
  const factorySku = payload.factorySku.trim();
  const prompt = payload.prompt;
  const effectivePrompt = payload.effectivePrompt;

  if (payload.generationMode !== "continue" && payload.generationMode !== "regenerate") {
    throw new Error("数据库任务方式无效");
  }
  const generationMode = payload.generationMode;

  let headingStyle;
  try {
    headingStyle = normalizeCurtainProductStyle(payload.headingStyle);
  } catch {
    throw new Error("帘头样式无效");
  }
  const output = payload.output;
  if (!output || !validOutputName(output.outputName, "webp")) {
    throw new Error("Invalid curtain product output name.");
  }
  const imageBuffer = await decodeWebpDataUrl(output.imageDataUrl);
  if (!imageBuffer) throw new Error("Invalid curtain product WebP image.");

  return {
    factorySku,
    generationId: payload.generationId,
    generationMode,
    prompt,
    effectivePrompt,
    headingStyle,
    output: { outputName: output.outputName, imageDataUrl: output.imageDataUrl },
    outputHash: sha256Buffer(imageBuffer),
  };
}

async function decodeWebpDataUrl(value) {
  if (typeof value !== "string") return null;
  const match = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4 !== 0) return null;
  const buffer = Buffer.from(match[1], "base64");
  if (!buffer.length || buffer.toString("base64") !== match[1]) return null;
  try {
    const metadata = await sharp(buffer).metadata();
    return metadata.format === "webp" && metadata.width > 0 && metadata.height > 0
      ? buffer
      : null;
  } catch {
    return null;
  }
}

function isUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createCurtainProductGenerationRegistry({ clock, ttlMs, maxPending }) {
  const records = new Map();
  const reservations = new Set();
  const effectiveTtlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
    ? Number(ttlMs)
    : DEFAULT_PRODUCT_GENERATION_TTL_MS;
  const effectiveMaxPending = Number.isInteger(Number(maxPending)) && Number(maxPending) > 0
    ? Number(maxPending)
    : DEFAULT_PRODUCT_GENERATION_MAX_PENDING;
  const now = () => Number(clock());

  const cleanupExpired = (timestamp) => {
    for (const [generationId, record] of records) {
      if (!record.finalizePromise && record.expiresAt <= timestamp) records.delete(generationId);
    }
  };

  const pendingCount = () => [...records.values()]
    .filter((record) => record.state === "pending").length;

  const reserve = () => {
    cleanupExpired(now());
    if (pendingCount() + reservations.size >= effectiveMaxPending) {
      throw new GenerationRequestError(503, "待保存生成结果过多（503），请先保存现有结果后重试。");
    }
    const reservation = {};
    reservations.add(reservation);
    return reservation;
  };

  const release = (reservation) => {
    if (reservation) reservations.delete(reservation);
  };

  const register = (reservation, record) => {
    if (!reservations.has(reservation)) {
      throw new GenerationRequestError(503, "生成凭证预留已失效，请重新生成。");
    }
    const timestamp = now();
    cleanupExpired(timestamp);
    reservations.delete(reservation);
    records.set(record.generationId, {
      ...record,
      fabric: { ...record.fabric },
      product: { ...record.product },
      pattern: { ...record.pattern },
      output: { ...record.output },
      outputHash: record.outputHash,
      createdAt: timestamp,
      expiresAt: timestamp + effectiveTtlMs,
      state: "pending",
      finalizePromise: null,
      entry: null,
    });
  };

  const finalize = async (submission, saveRecord) => {
    const timestamp = now();
    const record = records.get(submission.generationId);
    if (record && !record.finalizePromise && record.expiresAt <= timestamp) {
      records.delete(submission.generationId);
      throw new GenerationRequestError(410, "生成凭证已过期，请重新生成。");
    }
    cleanupExpired(timestamp);
    if (!record || !records.has(submission.generationId)) {
      throw new GenerationRequestError(409, "生成凭证已失效，请重新生成。");
    }
    if (!curtainProductSubmissionMatches(record, submission)) {
      throw new GenerationRequestError(409, "生成结果与凭证不匹配，请使用本次生成的原始结果。");
    }
    if (record.state === "completed") return record.entry;
    if (record.finalizePromise) return record.finalizePromise;

    record.finalizePromise = (async () => {
      try {
        const entry = await saveRecord(record);
        record.state = "completed";
        record.entry = entry;
        record.expiresAt = now() + effectiveTtlMs;
        record.fabric = null;
        record.output = { outputName: record.output.outputName };
        record.finalizePromise = null;
        return entry;
      } catch (error) {
        record.finalizePromise = null;
        throw error;
      }
    })();
    return record.finalizePromise;
  };

  return { reserve, release, register, finalize };
}

function curtainProductSubmissionMatches(record, submission) {
  return record.factorySku === submission.factorySku
    && record.generationMode === submission.generationMode
    && record.headingStyle === submission.headingStyle
    && record.prompt === submission.prompt
    && record.effectivePrompt === submission.effectivePrompt
    && record.output.outputName === submission.output.outputName
    && record.outputHash === submission.outputHash;
}

function sha256DataUrl(dataUrl) {
  return sha256Buffer(parseDataUrl(dataUrl).buffer);
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeDatabaseGenerationMode(mode) {
  const value = String(mode || "continue").trim();
  if (value !== "continue" && value !== "regenerate") {
    throw new Error("数据库任务方式无效");
  }
  return value;
}

function assetPayload(asset) {
  return {
    name: asset.fileName || "image.jpg",
    type: asset.mimeType || "application/octet-stream",
    dataUrl: `data:${asset.mimeType || "application/octet-stream"};base64,${asset.buffer.toString("base64")}`,
  };
}

async function normalizeHeicImagePayload(image) {
  if (!image || typeof image !== "object") return image;
  const dataUrl = String(image.dataUrl || "");
  const isHeic = /^data:image\/hei[cf];base64,/i.test(dataUrl)
    || /\.hei[cf]$/i.test(String(image.name || ""));
  if (!isHeic) return image;

  try {
    const source = parseDataUrl(dataUrl);
    const buffer = Buffer.from(await heicConvert({
      buffer: source.buffer,
      format: "JPEG",
      quality: 1,
    }));
    return {
      ...image,
      name: String(image.name || "image.heic").replace(/\.hei[cf]$/i, ".jpg"),
      type: "image/jpeg",
      dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
    };
  } catch (error) {
    throw new GenerationRequestError(422, "HEIC 图片转换失败，请改用 JPG、PNG 或 WebP。", { cause: error });
  }
}

async function handleModels(request, response, fetchImpl, retryDelayMs) {
  const apiKey = apiKeyFromRequest(request);
  if (!apiKey) {
    sendJson(response, 400, { error: "Missing API key." });
    return;
  }

  const upstream = await fetchWithTemporaryRetry(
    () =>
      fetchImpl(`${normalizeBaseUrl(API_BASE_URL)}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }),
    {
      retries: GENERATE_RETRY_COUNT,
      retryDelayMs,
    },
  );
  const text = await upstream.text();

  if (!upstream.ok) {
    sendJson(response, upstream.status, { error: formatUpstreamError(upstream.status, text) });
    return;
  }

  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
  });
  response.end(text);
}

async function handleGenerate(request, response, fetchImpl, retryDelayMs, asyncPollDelayMs) {
  const payload = await readJsonBody(request);
  const apiKey = apiKeyFromRequest(request, payload);
  if (!apiKey) {
    sendJson(response, 400, { error: "Missing API key." });
    return;
  }

  try {
    const result = await executeManualGeneration(payload, apiKey, fetchImpl, retryDelayMs, asyncPollDelayMs);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.message || "Generation failed." });
  }
}

async function executeManualGeneration(payload, apiKey, fetchImpl, retryDelayMs, asyncPollDelayMs) {
  try {
    validateGeneratePayload(payload);
  } catch (error) {
    throw new GenerationRequestError(400, error.message || "Invalid generation request.");
  }
  const scene = await normalizeHeicImagePayload(payload.scene);
  const fabric = await normalizeHeicImagePayload(payload.fabric);
  const imageDataUrl = await executeUpstreamGeneration({
    apiKey,
    fetchImpl,
    retryDelayMs,
    asyncPollDelayMs,
    idempotencyKey: payload.__idempotencyKey,
    retryConcurrencyLimit: !payload.__queueConcurrencyManaged,
    form: buildEditFormData({ ...payload, scene, fabric }),
  });
  return { imageDataUrl };
}

async function executeManualCurtainProductGeneration(
  payload,
  apiKey,
  fetchImpl,
  retryDelayMs,
  asyncPollDelayMs,
  getCurtainProductTemplate,
  saveHistoryEntry,
  resolveFabricCatalog,
  promptSettings,
) {
  validateManualCurtainProductGenerationRequest(payload);
  let headingStyle;
  try {
    headingStyle = normalizeCurtainProductStyle(payload.headingStyle);
    validateImageSettings({ quality: payload.quality, size: payload.size });
  } catch (error) {
    throw new GenerationRequestError(400, error.message || "Invalid manual product request.");
  }
  const fabric = await normalizeHeicImagePayload(payload.fabric);
  let fabricMetadata;
  let scale;
  try {
    const fabricCatalog = await resolveFabricCatalog(payload.fabricCatalogRoot);
    fabricMetadata = await fabricCatalog.resolve({
      fileName: fabric.name,
      fallbackSampleSizeCm: Number(payload.fabricSampleSizeCm),
    });
    scale = calculateManualProductScale(fabricMetadata);
  } catch (error) {
    throw new GenerationRequestError(409, error.message || "无法读取当前 SKU 的面料信息。");
  }

  const fixedPrompt = await promptSettings.get(
    fabricMetadata.fabricMode === "repeat" ? "manual_product_repeat" : "manual_product_plain",
  );
  let repeatImage = null;
  if (fabricMetadata.fabricMode === "repeat") {
    try {
      const repeatBuffer = await readFile(fabricMetadata.repeatImagePath);
      repeatImage = {
        name: fabricMetadata.repeatImageName,
        type: mimeType(fabricMetadata.repeatImagePath),
        dataUrl: `data:${mimeType(fabricMetadata.repeatImagePath)};base64,${repeatBuffer.toString("base64")}`,
      };
    } catch (error) {
      throw new GenerationRequestError(409, `有花位 SKU ${fabricMetadata.sku} 的完整花位图读取失败。`);
    }
  }
  const template = await getCurtainProductTemplate(headingStyle);
  const form = buildCurtainProductFormData({
    headingStyle,
    template,
    fabric,
    repeatImage,
    prompt: "",
    quality: payload.quality,
    size: payload.size,
    fabricMode: fabricMetadata.fabricMode,
    fabricMetadata,
    scale,
    fixedPrompt,
  });
  const imageDataUrl = await executeUpstreamGeneration({
    apiKey,
    fetchImpl,
    retryDelayMs,
    asyncPollDelayMs,
    idempotencyKey: payload.__idempotencyKey,
    preferredMimeType: "image/webp",
    retryConcurrencyLimit: !payload.__queueConcurrencyManaged,
    form,
  });
  const sku = fabricMetadata.sku;
  const outputName = manualCurtainProductOutputName({
    sku,
    headingStyle,
  });
  const publicMetadata = publicManualFabricMetadata(fabricMetadata);
  if (payload.clientHistory === true) {
    return {
      imageDataUrl,
      outputName,
      effectivePrompt: String(form.get("prompt") || ""),
      fabricMetadata: publicMetadata,
    };
  }

  try {
    const historyEntry = await saveHistoryEntry({
      taskType: "curtain_product",
      generationId: randomUUID(),
      outputName,
      sku,
      prompt: "",
      effectivePrompt: String(form.get("prompt") || ""),
      result: { dataUrl: imageDataUrl },
      fabric,
      product: {
        ...CURTAIN_PRODUCT,
        patternRepeatVerticalCm: null,
        patternRepeatHorizontalCm: null,
        generationMode: "continue",
        headingStyle,
        fabricSampleSizeCm: fabricMetadata.sampleSizeCm,
        fabricMode: fabricMetadata.fabricMode,
        composition: fabricMetadata.composition,
        repeatImageName: fabricMetadata.repeatImageName,
      },
    });
    return { imageDataUrl, outputName, historyEntry, fabricMetadata: publicMetadata };
  } catch (error) {
    return { imageDataUrl, outputName, fabricMetadata: publicMetadata, historyError: error.message || "历史保存失败" };
  }
}

function validateManualCurtainProductGenerationRequest(payload) {
  if (!payload || typeof payload !== "object" || !payload.fabric?.dataUrl) {
    throw new GenerationRequestError(400, "Missing fabric image.");
  }
  try {
    normalizeCurtainProductStyle(payload.headingStyle);
    validateImageSettings({ quality: payload.quality, size: payload.size });
    if (![10, 15].includes(Number(payload.fabricSampleSizeCm))) throw new Error("面料实际尺寸无效");
  } catch (error) {
    if (error instanceof GenerationRequestError) throw error;
    throw new GenerationRequestError(400, error.message || "Invalid manual product request.");
  }
}

async function executeCurtainCreation(payload, apiKey, fetchImpl, retryDelayMs, asyncPollDelayMs, getCurtainSceneTemplate, saveHistoryEntry) {
  try {
    validateCreationOptions(payload);
  } catch (error) {
    throw new GenerationRequestError(400, error.message || "Invalid curtain creation request.");
  }

  const selectedScene = await getCurtainSceneTemplate(payload.sceneTemplateId);
  const scene = selectedScene.scene;
  const fabric = await normalizeHeicImagePayload(payload.fabric);
  const fixedPrompt = normalizeEditableFixedPrompt(payload.fixedPrompt);
  let imageDataUrl;
  try {
    imageDataUrl = await executeUpstreamGeneration({
      apiKey,
      fetchImpl,
      retryDelayMs,
      asyncPollDelayMs,
      idempotencyKey: payload.__idempotencyKey,
      preferredMimeType: "image/jpeg",
      retryConcurrencyLimit: !payload.__queueConcurrencyManaged,
      form: buildEditFormData({ ...payload, fixedPrompt, scene, fabric, taskType: "creation", outputFormat: "jpeg" }),
    });
  } catch (error) {
    if (/No image data returned/i.test(error.message || "")) {
      throw new GenerationRequestError(422, "未识别到窗户，未生成图片");
    }
    throw error;
  }

  const outputName = outputNameForCurtainCreation(fabric.name);
  const sku = skuFromFabricName(fabric.name);
  if (payload.clientHistory === true) {
    return { imageDataUrl, outputName, sceneTemplateId: selectedScene.sceneTemplateId };
  }

  await saveHistoryEntry({
    outputName,
    sku,
    prompt: payload.prompt,
    result: { dataUrl: imageDataUrl },
    scene,
    fabric,
    taskType: "curtain_creation",
    options: { sceneTemplateId: selectedScene.sceneTemplateId },
  });
  return { imageDataUrl, outputName };
}

async function executeCustomGeneration(payload, apiKey, fetchImpl, retryDelayMs, asyncPollDelayMs, saveHistoryEntry) {
  try {
    validateCustomGenerationPayload(payload);
  } catch (error) {
    throw new GenerationRequestError(400, error.message || "Invalid custom generation request.");
  }

  const reference = await normalizeHeicImagePayload(payload.reference);
  const imageDataUrl = await executeUpstreamGeneration({
    apiKey,
    fetchImpl,
    retryDelayMs,
    asyncPollDelayMs,
    idempotencyKey: payload.__idempotencyKey,
    preferredMimeType: "image/jpeg",
    retryConcurrencyLimit: !payload.__queueConcurrencyManaged,
    form: buildCustomEditFormData({ ...payload, reference }),
  });
  const outputName = sanitizeHistoryText(payload.outputName);
  if (payload.clientHistory === true) return { imageDataUrl, outputName };

  await saveHistoryEntry({
    taskType: "custom_generation",
    outputName,
    sku: outputName.replace(/\.jpg$/i, ""),
    prompt: payload.prompt,
    result: { dataUrl: imageDataUrl },
    scene: reference,
    options: {
      quality: payload.quality || "high",
      size: payload.size || "2048x2048",
    },
  });
  return { imageDataUrl, outputName };
}

async function executeUpstreamGeneration({
  apiKey,
  form,
  fetchImpl,
  retryDelayMs,
  asyncPollDelayMs = MIN_ASYNC_POLL_DELAY_MS,
  idempotencyKey = randomUUID(),
  preferredMimeType = "image/png",
  retryConcurrencyLimit = true,
}) {
  const submission = await fetchWithTemporaryRetry(
    () =>
      fetchImpl(`${normalizeBaseUrl(API_BASE_URL)}/images/edits?async=true`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: form,
      }),
    {
      retries: GENERATE_RETRY_COUNT,
      retryDelayMs,
      retryConcurrencyLimit,
    },
  );

  if (!submission.ok) {
    const text = await submission.text();
    const error = new GenerationRequestError(submission.status, formatUpstreamError(submission.status, text));
    error.upstreamConcurrencyLimit = isConcurrencyLimitError(submission.status, text);
    throw error;
  }

  const task = await submission.json();
  if (submission.status !== 202 || !task?.id) {
    return dataUrlFromImageResponse(task, fetchImpl, preferredMimeType);
  }

  return waitForAsyncImageTask({
    apiKey,
    taskId: task.id,
    pollAfter: task.poll_after,
    fetchImpl,
    retryDelayMs,
    asyncPollDelayMs,
    preferredMimeType,
  });
}

async function waitForAsyncImageTask({
  apiKey,
  taskId,
  pollAfter,
  fetchImpl,
  retryDelayMs,
  asyncPollDelayMs,
  preferredMimeType,
}) {
  let delayMs = normalizeAsyncPollDelay(pollAfter, asyncPollDelayMs);
  let temporaryRetries = 0;
  while (true) {
    if (delayMs > 0) await sleep(delayMs);
    let response;
    try {
      response = await fetchImpl(`${normalizeBaseUrl(API_BASE_URL)}/images/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (error) {
      if (temporaryRetries >= GENERATE_RETRY_COUNT) {
        throw new GenerationRequestError(502, "上游网络连接失败，已自动重试，请稍后继续。", { cause: error });
      }
      delayMs = retryDelayForAttempt(retryDelayMs, temporaryRetries);
      temporaryRetries += 1;
      continue;
    }

    if (response.status === 429) {
      delayMs = retryAfterDelay(response.headers.get("retry-after"), asyncPollDelayMs);
      continue;
    }

    if (!response.ok) {
      const text = await readResponseText(response);
      if (TEMPORARY_UPSTREAM_STATUS.has(response.status) && temporaryRetries < GENERATE_RETRY_COUNT) {
        delayMs = retryDelayForAttempt(retryDelayMs, temporaryRetries);
        temporaryRetries += 1;
        continue;
      }
      throw new GenerationRequestError(response.status, formatUpstreamError(response.status, text));
    }

    temporaryRetries = 0;
    const task = await response.json();
    if (task?.status === "completed") {
      return dataUrlFromImageResponse(task.result, fetchImpl, preferredMimeType);
    }
    if (task?.status === "failed") {
      const message = String(task?.error?.message || task?.error?.code || "上游生图任务失败");
      throw new GenerationRequestError(422, message);
    }
    if (task?.status !== "queued" && task?.status !== "in_progress") {
      throw new GenerationRequestError(502, "上游异步任务状态无效。");
    }
    delayMs = normalizeAsyncPollDelay(task.poll_after, asyncPollDelayMs);
  }
}

function normalizeAsyncPollDelay(value, minimumMs) {
  const seconds = Number(value);
  const requested = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  return Math.max(minimumMs, requested);
}

function retryAfterDelay(value, minimumMs) {
  const seconds = Number(value);
  const requested = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  return Math.max(minimumMs, requested);
}

class GenerationRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function handleListHistory(request, response, listEntriesPage) {
  const pagination = parseHistoryPagination(request.url || "/api/history");
  if (!pagination) {
    sendJson(response, 400, { error: "Invalid history pagination." });
    return;
  }
  sendJson(response, 200, await listEntriesPage(pagination));
}

function parseHistoryPagination(requestUrl) {
  const searchParams = new URL(requestUrl, "http://localhost").searchParams;

  const parseValue = (name, fallback) => {
    const values = searchParams.getAll(name);
    if (values.length === 0) return fallback;
    if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) return null;
    const value = Number(values[0]);
    return Number.isSafeInteger(value) ? value : null;
  };
  const page = parseValue("page", 1);
  const pageSize = parseValue("pageSize", 30);
  if (page === null || pageSize === null || pageSize > 100) return null;
  return { page, pageSize };
}

async function handleCreateHistory(request, response, saveHistoryEntry) {
  const payload = await readJsonBody(request);
  if (payload?.taskType === "curtain_product") {
    sendJson(response, 400, { error: "白底成品历史必须由专用 curtain product finalize 流程保存。" });
    return;
  }
  const entry = await saveHistoryEntry(payload);
  sendJson(response, 201, { entry });
}

async function handleDeleteHistoryDay(request, response, historyStore) {
  const payload = await readJsonBody(request);
  if (!isHistoryEntryObject(payload) || hasUnsafeStoredObjectKey(payload)) {
    sendJson(response, 400, { error: "Invalid history deletion request." });
    return;
  }

  const keys = Object.keys(payload);
  if (keys.length === 1 && keys[0] === "date") {
    if (!isStrictHistoryDate(payload.date)) {
      sendJson(response, 400, { error: "Invalid history date." });
      return;
    }
    const deleted = await historyStore.deleteEntriesByDate(payload.date);
    sendJson(response, 200, { deleted });
    return;
  }

  if (
    keys.length !== 1
    || keys[0] !== "ids"
    || !Array.isArray(payload.ids)
    || payload.ids.length > 10000
  ) {
    sendJson(response, 400, { error: "Invalid history entry IDs." });
    return;
  }
  const deleted = await historyStore.deleteEntries(payload.ids);
  sendJson(response, 200, { deleted });
}

function isStrictHistoryDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function historyShanghaiDateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function createHistoryStore(
  historyDir,
  { unlink: unlinkAsset = unlink } = {},
  mapHistoryEntry = toPublicHistoryEntry,
) {
  let indexWriteQueue = Promise.resolve();

  const enqueueIndexWrite = (operation) => {
    const pending = indexWriteQueue.catch(() => {}).then(operation);
    indexWriteQueue = pending;
    return pending;
  };

  const cleanupPendingDeletions = async (index) => {
    const quarantineCleaned = await cleanupQuarantinedHistoryAssets(historyDir, unlinkAsset);
    const indexPending = normalizePendingDeletions(index.pendingDeletions);
    const rollbackPending = await readPendingDeletionJournal(historyDir);
    const pending = normalizePendingDeletions([...indexPending, ...rollbackPending]);
    if (!pending.length) {
      index.pendingDeletions = [];
      return quarantineCleaned;
    }

    const remaining = [];
    const assetsDir = historyAssetsDir(historyDir);
    for (const fileName of pending) {
      try {
        await deleteHistoryAsset(assetsDir, fileName, unlinkAsset);
      } catch {
        remaining.push(fileName);
      }
    }
    const remainingSet = new Set(remaining);
    const remainingIndexPending = indexPending.filter((fileName) => remainingSet.has(fileName));
    const remainingRollbackPending = rollbackPending.filter((fileName) => remainingSet.has(fileName));
    index.pendingDeletions = remainingIndexPending;
    if (remainingIndexPending.length !== indexPending.length) {
      await writeHistoryIndex(historyDir, index);
    }
    if (remainingRollbackPending.length !== rollbackPending.length) {
      await writePendingDeletionJournal(historyDir, remainingRollbackPending);
    }
    return quarantineCleaned || remaining.length !== pending.length;
  };

  const rollbackPreparedFiles = async (assetsDir, files) => {
    const fileNames = normalizePendingDeletions(files.map((file) => file.fileName));
    if (!fileNames.length) return;

    let journalEstablished = false;
    try {
      await enqueueIndexWrite(async () => {
        const existing = await readPendingDeletionJournal(historyDir);
        await writePendingDeletionJournal(historyDir, [...existing, ...fileNames]);
        journalEstablished = true;

        const deletions = await Promise.allSettled(
          fileNames.map((fileName) => deleteHistoryAsset(assetsDir, fileName, unlinkAsset)),
        );
        const failed = new Set(deletions.flatMap((result, index) =>
          result.status === "rejected" ? [fileNames[index]] : []
        ));
        const retained = normalizePendingDeletions([
          ...existing,
          ...fileNames.filter((fileName) => failed.has(fileName)),
        ]);
        await writePendingDeletionJournal(historyDir, retained);
      });
    } catch {
      if (!journalEstablished) {
        try {
          await enqueueIndexWrite(() => quarantineHistoryAssets(historyDir, fileNames));
        } catch {
          // The original save error remains authoritative; unmoved files stay in place.
        }
      }
    }
  };

  const readAndCleanupIndex = async () => {
    const index = await readHistoryIndex(historyDir);
    await cleanupPendingDeletions(index);
    return index;
  };

  const listEntriesPage = ({ page, pageSize }) => enqueueIndexWrite(async () => {
    const index = await readAndCleanupIndex();
    const listableEntries = index.entries
      .map((entry, position) => ({ entry, position }))
      .filter(({ entry }) => isListableStoredHistoryEntry(entry))
      .sort((left, right) => {
        const createdAtDifference = historyCreatedAtTime(right.entry) - historyCreatedAtTime(left.entry);
        return createdAtDifference || left.position - right.position;
      });
    const total = listableEntries.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;
    const entries = listableEntries
      .slice(offset, offset + pageSize)
      .map(({ entry }) => mapHistoryEntry(entry));
    return { entries, total, page, pageSize, totalPages };
  });

  const saveEntry = async (payload) => {
    validateHistoryPayload(payload);

    const createdAt = new Date().toISOString();
    const id = `${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const taskType = normalizeHistoryTaskType(payload.taskType);
    const productResults = taskType === "curtain_product" && payload.results
      ? sanitizeProductResults(payload.results)
      : null;
    const metadata = {
      id,
      createdAt,
      outputName: sanitizeHistoryText(payload.outputName || "result.jpg"),
      sku: sanitizeHistoryText(payload.sku || ""),
      prompt: String(payload.prompt || ""),
      sceneName: sanitizeHistoryText(payload.scene?.name || ""),
      fabricName: sanitizeHistoryText(payload.fabric?.name || ""),
      taskType,
      options: taskType === "curtain_creation"
        ? sanitizeCreationOptions(payload.options)
        : taskType === "custom_generation"
          ? sanitizeCustomOptions(payload.options)
        : null,
      product: taskType === "curtain_product"
        ? sanitizeProductMetadata(payload.product, { strict: true })
        : null,
      ...(taskType === "curtain_product" ? {
        generationId: payload.generationId || "",
        effectivePrompt: String(payload.effectivePrompt || ""),
        results: productResults,
      } : {}),
    };
    const preparedFiles = {
      result: payload.result?.dataUrl
        ? prepareHistoryImage(id, "result", payload.result.dataUrl)
        : null,
      grommet: productResults
        ? prepareHistoryImage(id, "grommet", payload.results.grommet.imageDataUrl, "webp")
        : null,
      doublePinch: productResults
        ? prepareHistoryImage(id, "double-pinch", payload.results.doublePinch.imageDataUrl, "webp")
        : null,
      scene: payload.scene?.dataUrl
        ? prepareHistoryImage(id, "scene", payload.scene.dataUrl)
        : null,
      fabric: payload.fabric?.dataUrl
        ? prepareHistoryImage(id, "fabric", payload.fabric.dataUrl)
        : null,
    };
    const attemptedFiles = Object.values(preparedFiles).filter(Boolean);
    const assetsDir = historyAssetsDir(historyDir);
    const entry = {
      ...metadata,
      files: {
        result: preparedFiles.result?.fileName || null,
        grommet: preparedFiles.grommet?.fileName || null,
        doublePinch: preparedFiles.doublePinch?.fileName || null,
        scene: preparedFiles.scene?.fileName || null,
        fabric: preparedFiles.fabric?.fileName || null,
      },
    };

    try {
      return await enqueueIndexWrite(async () => {
        const index = await readAndCleanupIndex();
        if (metadata.generationId) {
          const existing = index.entries.find((item) =>
            isHistoryEntryObject(item) && item.generationId === metadata.generationId
          );
          if (existing) return toPublicHistoryEntry(existing);
        }

        await mkdir(assetsDir, { recursive: true });
        const writes = await Promise.allSettled(
          attemptedFiles.map((file) => writePreparedHistoryImage(assetsDir, file)),
        );
        const failedWrite = writes.find((result) => result.status === "rejected");
        if (failedWrite) throw failedWrite.reason;

        index.entries.unshift(entry);
        await writeHistoryIndex(historyDir, index);
        return toPublicHistoryEntry(entry);
      });
    } catch (error) {
      await rollbackPreparedFiles(assetsDir, attemptedFiles);
      throw error;
    }
  };

  const deleteMatchingEntries = async (matches) => {
    return enqueueIndexWrite(async () => {
      const index = await readAndCleanupIndex();
      const removed = index.entries.filter((entry) => isHistoryEntryObject(entry) && matches(entry));
      if (!removed.length) return 0;

      index.entries = index.entries.filter((entry) => !isHistoryEntryObject(entry) || !matches(entry));
      index.pendingDeletions = normalizePendingDeletions([
        ...index.pendingDeletions,
        ...removed.flatMap(historyAssetFileNames),
      ]);
      await writeHistoryIndex(historyDir, index);
      await cleanupPendingDeletions(index);
      return removed.length;
    });
  };

  const deleteEntries = async (ids) => {
    const idSet = new Set(ids.filter((id) => typeof id === "string" && id.length <= 80));
    if (!idSet.size) return 0;
    return deleteMatchingEntries((entry) => idSet.has(entry.id));
  };

  const deleteEntriesByDate = (date) =>
    deleteMatchingEntries((entry) => historyShanghaiDateKey(entry.createdAt) === date);

  void enqueueIndexWrite(async () => {
    const index = await readHistoryIndex(historyDir);
    await cleanupPendingDeletions(index);
  }).catch(() => {});

  return { saveEntry, deleteEntries, deleteEntriesByDate, listEntriesPage };
}

async function deleteHistoryAsset(assetsDir, fileName, unlinkAsset = unlink) {
  const target = resolveSafeHistoryChild(assetsDir, fileName);
  if (!target) return;
  try {
    await unlinkAsset(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function quarantineHistoryAssets(historyDir, fileNames) {
  const assetsDir = historyAssetsDir(historyDir);
  const trashDir = historyTrashDir(historyDir);
  await mkdir(trashDir, { recursive: true });

  for (const fileName of normalizePendingDeletions(fileNames)) {
    const source = resolveSafeHistoryChild(assetsDir, fileName);
    const target = resolveSafeHistoryChild(trashDir, fileName);
    if (!source || !target) throw new Error("Unsafe history asset path.");
    try {
      await rename(source, target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function cleanupQuarantinedHistoryAssets(historyDir, unlinkAsset) {
  const trashDir = historyTrashDir(historyDir);
  let entries;
  try {
    entries = await readdir(trashDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  let cleaned = false;
  for (const entry of entries) {
    if (!entry.isFile() || !isSafeHistoryAssetFileName(entry.name)) continue;
    try {
      await deleteHistoryAsset(trashDir, entry.name, unlinkAsset);
      cleaned = true;
    } catch {
      // Directory entry remains as its own durable cleanup marker.
    }
  }
  return cleaned;
}

function resolveSafeHistoryChild(rootDir, fileName) {
  if (!isSafeHistoryAssetFileName(fileName)) return null;
  const root = path.resolve(rootDir);
  const target = path.resolve(root, fileName);
  const relativeTarget = path.relative(root, target);
  if (
    !relativeTarget
    || relativeTarget === ".."
    || relativeTarget.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeTarget)
  ) return null;
  return target;
}

function validateHistoryPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid history payload.");
  }
  const hasProductResults = payload.taskType === "curtain_product"
    && payload.results?.grommet?.imageDataUrl
    && payload.results?.doublePinch?.imageDataUrl;
  const hasSingleProductResult = payload.taskType === "curtain_product"
    && payload.result?.dataUrl;
  if (!payload.result?.dataUrl && !hasProductResults) {
    throw new Error("Missing generated image.");
  }
  if ((hasProductResults || hasSingleProductResult) && !isUuid(payload.generationId)) {
    throw new Error("Invalid generation ID.");
  }
  if (payload.taskType !== "curtain_product" && !payload.scene?.dataUrl) {
    throw new Error("Missing scene image.");
  }
  if (payload.taskType !== "custom_generation" && !payload.fabric?.dataUrl) {
    throw new Error("Missing fabric image.");
  }
}

async function readHistoryIndex(historyDir) {
  try {
    const text = await readFile(historyIndexPath(historyDir), "utf8");
    const parsed = JSON.parse(text);
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      pendingDeletions: normalizePendingDeletions(parsed.pendingDeletions),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { entries: [], pendingDeletions: [] };
    }
    throw error;
  }
}

function normalizePendingDeletions(fileNames) {
  if (!Array.isArray(fileNames)) return [];
  return [...new Set(fileNames.filter(isSafeHistoryAssetFileName))];
}

async function readPendingDeletionJournal(historyDir) {
  try {
    const text = await readFile(pendingDeletionJournalPath(historyDir), "utf8");
    const parsed = JSON.parse(text);
    return normalizePendingDeletions(parsed.pendingDeletions);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writePendingDeletionJournal(historyDir, pendingDeletions) {
  await mkdir(historyDir, { recursive: true });
  const journalPath = pendingDeletionJournalPath(historyDir);
  const tempPath = `${journalPath}.tmp`;
  const journal = { pendingDeletions: normalizePendingDeletions(pendingDeletions) };
  await writeFile(tempPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await rename(tempPath, journalPath);
}

async function writeHistoryIndex(historyDir, index) {
  await mkdir(historyDir, { recursive: true });
  const indexPath = historyIndexPath(historyDir);
  const tempPath = `${indexPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await rename(tempPath, indexPath);
}

function prepareHistoryImage(id, role, dataUrl, preferredExtension = "") {
  const parsed = parseDataUrl(dataUrl);
  const extension = preferredExtension || extensionFromMimeType(parsed.mimeType);
  return {
    fileName: `${id}_${role}.${extension}`,
    buffer: parsed.buffer,
  };
}

async function writePreparedHistoryImage(assetsDir, file) {
  await writeFile(path.join(assetsDir, file.fileName), file.buffer);
}

function toPublicHistoryEntry(entry) {
  if (!isHistoryEntryObject(entry)) return null;
  const taskType = normalizeHistoryTaskType(entry.taskType);
  const files = entry.files && typeof entry.files === "object" && !Array.isArray(entry.files)
    ? entry.files
    : {};
  const productResults = taskType === "curtain_product" && entry.results
    ? sanitizeProductResults(entry.results)
    : null;
  const results = productResults
    ? {
        grommet: {
          ...productResults.grommet,
          url: historyAssetUrl(files.grommet),
        },
        doublePinch: {
          ...productResults.doublePinch,
          url: historyAssetUrl(files.doublePinch),
        },
      }
    : null;
  return {
    ...entry,
    taskType,
    options: taskType === "curtain_creation"
      ? sanitizeCreationOptions(entry.options)
      : taskType === "custom_generation"
        ? sanitizeCustomOptions(entry.options)
        : null,
    product: taskType === "curtain_product" ? sanitizeProductMetadata(entry.product) : null,
    ...(taskType === "curtain_product" ? { results } : {}),
    resultUrl: historyAssetUrl(files.result),
    sceneUrl: historyAssetUrl(files.scene),
    fabricUrl: historyAssetUrl(files.fabric),
  };
}

function sanitizeProductResults(results) {
  if (!results || typeof results !== "object" || Array.isArray(results)) {
    throw new Error("Invalid curtain product results.");
  }
  const sanitized = {};
  for (const key of ["grommet", "doublePinch"]) {
    const result = results[key];
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Invalid curtain product results.");
    }
    const outputName = sanitizeHistoryText(result.outputName);
    if (!outputName) throw new Error("Invalid curtain product results.");
    sanitized[key] = { outputName };
  }
  return sanitized;
}

function historyAssetUrl(fileName) {
  if (!isSafeHistoryAssetFileName(fileName)) return "";
  return `${HISTORY_ASSET_ROUTE}${encodeURIComponent(fileName)}`;
}

function historyAssetFileNames(entry) {
  if (!isHistoryEntryObject(entry)) return [];
  const files = entry.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return [];
  return Object.values(files).filter(isSafeHistoryAssetFileName);
}

function isHistoryEntryObject(entry) {
  return Boolean(entry) && typeof entry === "object" && !Array.isArray(entry);
}

function isListableStoredHistoryEntry(entry) {
  if (!isHistoryEntryObject(entry)) return false;
  if (hasUnsafeStoredObjectKey(entry)) return false;
  if (
    typeof entry.id !== "string"
    || !/^[A-Za-z0-9._-]+$/.test(entry.id)
    || entry.id.length > 80
  ) return false;
  if (
    entry.createdAt !== undefined
    && (typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt)))
  ) return false;
  if (!hasListableHistoryFiles(entry.files)) return false;

  const taskType = normalizeHistoryTaskType(entry.taskType);
  if (taskType === "curtain_creation" && entry.options !== undefined) {
    if (!isHistoryEntryObject(entry.options) || hasUnsafeStoredObjectKey(entry.options)) return false;
  }
  if (taskType === "curtain_product" && entry.results) {
    if (!hasListableProductResults(entry.results)) return false;
  }
  return true;
}

function hasListableHistoryFiles(files) {
  if (files === undefined || files === null) return true;
  if (!isHistoryEntryObject(files) || hasUnsafeStoredObjectKey(files)) return false;
  return Object.values(files).every((fileName) => fileName === null || isSafeHistoryAssetFileName(fileName));
}

function hasListableProductResults(results) {
  if (!isHistoryEntryObject(results) || hasUnsafeStoredObjectKey(results)) return false;
  return ["grommet", "doublePinch"].every((key) => {
    const result = results[key];
    return (
      isHistoryEntryObject(result)
      && !hasUnsafeStoredObjectKey(result)
      && typeof result.outputName === "string"
      && /[^\u0000-\u001F]/.test(result.outputName)
    );
  });
}

function hasUnsafeStoredObjectKey(value) {
  return ["__proto__", "prototype", "constructor"].some((key) => Object.hasOwn(value, key));
}

function historyCreatedAtTime(entry) {
  if (entry.createdAt === undefined) return Number.NEGATIVE_INFINITY;
  return Date.parse(entry.createdAt);
}

function isSafeHistoryAssetFileName(fileName) {
  return (
    typeof fileName === "string"
    && Boolean(fileName)
    && fileName !== "null"
    && fileName !== "undefined"
    && fileName !== "."
    && fileName !== ".."
    && !fileName.includes("/")
    && !fileName.includes("\\")
    && path.basename(fileName) === fileName
  );
}

function normalizeHistoryTaskType(taskType) {
  if (
    taskType === "curtain_creation"
    || taskType === "curtain_product"
    || taskType === "custom_generation"
  ) return taskType;
  return "curtain_replacement";
}

function historyIndexPath(historyDir) {
  return path.join(historyDir, "history.json");
}

function pendingDeletionJournalPath(historyDir) {
  return path.join(historyDir, "pending-deletions.json");
}

function historyAssetsDir(historyDir) {
  return path.join(historyDir, "assets");
}

function historyTrashDir(historyDir) {
  return path.join(historyDir, "trash");
}

function extensionFromMimeType(mimeType) {
  return (
    {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    }[mimeType] || "bin"
  );
}

function sanitizeHistoryText(value) {
  return String(value || "").replace(/[\u0000-\u001F]/g, "").slice(0, 240);
}

function validOutputName(value, extension) {
  const safeExtension = String(extension || "").replace(/^\./, "");
  if (typeof value !== "string" || value.length > 240) return "";
  const normalized = value.trim();
  if (!normalized || /[<>:"/\\|?*\u0000-\u001F]/.test(normalized)) return "";
  return new RegExp(`\\.${safeExtension}$`, "i").test(normalized) ? normalized : "";
}

async function serveHistoryAsset(request, response, url, historyDir) {
  let assetName = "";
  try {
    assetName = decodeURIComponent(url.pathname.slice(HISTORY_ASSET_ROUTE.length));
  } catch {
    sendText(response, 400, "Bad request.");
    return;
  }

  if (!assetName || assetName.includes("/") || assetName.includes("\\")) {
    sendText(response, 404, "Not found.");
    return;
  }

  const assetRoot = path.resolve(historyAssetsDir(historyDir));
  const target = path.resolve(assetRoot, assetName);
  if (!target.startsWith(`${assetRoot}${path.sep}`)) {
    sendText(response, 404, "Not found.");
    return;
  }

  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(response, 404, "Not found.");
      return;
    }
    throw error;
  }

  if (!info.isFile()) {
    sendText(response, 404, "Not found.");
    return;
  }

  response.writeHead(200, {
    "content-type": mimeType(target),
    "cache-control": "no-store",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(target).pipe(response);
}

function handleListCurtainSceneTemplates(response, sceneTemplatePaths) {
  const hasAvailableTemplate = CURTAIN_SCENE_TEMPLATES.some((template) => Boolean(sceneTemplatePaths[template.id] && existsSync(sceneTemplatePaths[template.id])));
  sendJson(response, 200, {
    templates: [{ id: RANDOM_CURTAIN_SCENE_TEMPLATE_ID, label: "随机选择", available: hasAvailableTemplate, previewUrl: "" }, ...CURTAIN_SCENE_TEMPLATES.map((template) => {
      const available = Boolean(sceneTemplatePaths[template.id] && existsSync(sceneTemplatePaths[template.id]));
      return {
        id: template.id,
        label: template.label,
        available,
        previewUrl: available ? `/api/curtain-scene-templates/${template.id}/image` : "",
      };
    })],
  });
}

function resolveCurtainSceneTemplateId(sceneTemplateId, sceneTemplatePaths, random) {
  if (sceneTemplateId !== RANDOM_CURTAIN_SCENE_TEMPLATE_ID) return normalizeCurtainSceneTemplateId(sceneTemplateId);
  const available = CURTAIN_SCENE_TEMPLATES.filter((template) => sceneTemplatePaths[template.id] && existsSync(sceneTemplatePaths[template.id]));
  if (!available.length) throw new GenerationRequestError(409, "没有可用的内置场景图。");
  const position = Math.min(available.length - 1, Math.max(0, Math.floor(Number(random()) * available.length)));
  return available[position].id;
}

async function serveCurtainSceneTemplateImage(request, response, sceneTemplateId, sceneTemplatePaths) {
  let template;
  try {
    template = curtainSceneTemplateById(sceneTemplateId);
  } catch {
    sendText(response, 404, "Not found.");
    return;
  }
  const target = sceneTemplatePaths[template.id];
  if (!target || !existsSync(target)) {
    sendText(response, 404, "Not found.");
    return;
  }
  const info = await stat(target);
  if (!info.isFile()) {
    sendText(response, 404, "Not found.");
    return;
  }
  response.writeHead(200, { "content-type": mimeType(target), "cache-control": "no-store" });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(target).pipe(response);
}

async function fetchWithTemporaryRetry(fetchRequest, { retries, retryDelayMs, retryConcurrencyLimit = true }) {
  let temporaryRetries = 0;
  let concurrencyRetries = 0;
  while (true) {
    let response;
    try {
      response = await fetchRequest();
    } catch (error) {
      if (temporaryRetries >= retries) {
        throw new Error("上游网络连接失败，已自动重试，请稍后继续。", { cause: error });
      }
      if (retryDelayMs > 0) await sleep(retryDelayForAttempt(retryDelayMs, temporaryRetries));
      temporaryRetries += 1;
      continue;
    }

    if (response.ok) {
      return response;
    }

    const text = await readResponseText(response);
    if (isConcurrencyLimitError(response.status, text)) {
      if (!retryConcurrencyLimit) return responseFromText(response, text);
      if (concurrencyRetries >= 1) return responseFromText(response, text);
      if (retryDelayMs > 0) await sleep(retryDelayForAttempt(retryDelayMs, concurrencyRetries));
      concurrencyRetries += 1;
      continue;
    }

    if (!isRetryableUpstreamFailure(response.status, text)) {
      return responseFromText(response, text);
    }

    if (temporaryRetries >= retries) return responseFromText(response, text);
    if (retryDelayMs > 0) await sleep(retryDelayForAttempt(retryDelayMs, temporaryRetries));
    temporaryRetries += 1;
  }
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function formatUpstreamError(status, text) {
  if (isConcurrencyLimitError(status, text)) {
    return `上游并发限流：${upstreamFailureReason(status, text)}`;
  }

  if (TEMPORARY_UPSTREAM_STATUS.has(status)) {
    return "上游服务暂时不可用，请稍后重试。";
  }

  return text || `HTTP ${status}`;
}

function upstreamFailureReason(status, text) {
  const reason = String(text || "").trim().replace(/\s+/g, " ");
  return reason ? reason.slice(0, 500) : `HTTP ${status}`;
}

function isRetryableUpstreamFailure(status, text) {
  return RETRYABLE_UPSTREAM_STATUS.has(status) || isConcurrencyLimitError(status, text);
}

function isConcurrencyLimitError(status, text) {
  return status === 429 || RETRYABLE_UPSTREAM_ERROR.test(text);
}

function responseFromText(response, text) {
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function retryDelayForAttempt(retryDelayMs, attempt) {
  return Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * 2 ** attempt);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiKeyFromRequest(request, payload = {}) {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return (
    request.headers["x-api-key"] ||
    bearer ||
    payload.apiKey ||
    process.env.OPENAI_API_KEY ||
    ""
  ).trim();
}

function validateGeneratePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid request body.");
  }
  if (!payload.scene?.dataUrl) {
    throw new Error("Missing scene image.");
  }
  if (!payload.fabric?.dataUrl) {
    throw new Error("Missing fabric image.");
  }
  validateImageSettings(payload);
}

function validateCustomGenerationPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid request body.");
  }
  if (!payload.reference?.dataUrl) throw new Error("Missing reference image.");
  if (typeof payload.prompt !== "string" || !payload.prompt.trim()) {
    throw new Error("Missing prompt.");
  }
  if (payload.prompt.length > MAX_PRODUCT_PROMPT_CHARS) throw new Error("Prompt is too long.");
  if (
    typeof payload.outputName !== "string"
    || !/^[^<>:"/\\|?*\u0000-\u001F]+\.jpg$/i.test(payload.outputName)
    || payload.outputName.length > 240
  ) {
    throw new Error("Invalid output name.");
  }
  validateImageSettings(payload);
}

function validateCreationOptions(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Invalid request body.");
  if (!payload.fabric?.dataUrl) throw new Error("Missing fabric image.");
  if (payload.sceneTemplateId !== RANDOM_CURTAIN_SCENE_TEMPLATE_ID) normalizeCurtainSceneTemplateId(payload.sceneTemplateId);
  validateImageSettings(payload);
}

function normalizeEditableFixedPrompt(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("固定提示词无效");
  if (value.length > MAX_PRODUCT_PROMPT_CHARS) throw new Error("固定提示词过长");
  return value.trim();
}

function sanitizeCreationOptions(options = {}) {
  try {
    if (options.sceneTemplateId === RANDOM_CURTAIN_SCENE_TEMPLATE_ID) return { sceneTemplateId: RANDOM_CURTAIN_SCENE_TEMPLATE_ID };
    return { sceneTemplateId: normalizeCurtainSceneTemplateId(options.sceneTemplateId) };
  } catch {
    return {};
  }
}

function sanitizeCustomOptions(options = {}) {
  return {
    quality: isSupportedImageQuality(options.quality) ? options.quality : "high",
    size: isSupportedImageSize(options.size) ? options.size : "2048x2048",
  };
}

function sanitizeProductMetadata(product = {}, { strict = false } = {}) {
  const isObject = product && typeof product === "object" && !Array.isArray(product);
  if (strict && !isObject) throw new Error("Invalid curtain product metadata.");
  const source = isObject ? product : {};
  const metadata = {
    ...CURTAIN_PRODUCT,
    patternRepeatVerticalCm: positiveHistoryNumber(source.patternRepeatVerticalCm),
    patternRepeatHorizontalCm: positiveHistoryNumber(source.patternRepeatHorizontalCm),
    generationMode: source.generationMode === "regenerate" ? "regenerate" : "continue",
    headingStyle: source.headingStyle === "doublePinch" ? "doublePinch" : "grommet",
    fabricSampleSizeCm: [10, 15].includes(Number(source.fabricSampleSizeCm))
      ? Number(source.fabricSampleSizeCm)
      : null,
  };

  if (strict) {
    const hasCanonicalDimensions = Object.entries(CURTAIN_PRODUCT)
      .every(([key, value]) => Number(source[key]) === value);
    const hasValidMode = source.generationMode === "continue" || source.generationMode === "regenerate";
    const hasValidRepeats = [source.patternRepeatVerticalCm, source.patternRepeatHorizontalCm]
      .every((value) => value === null || value === undefined || positiveHistoryNumber(value) !== null);
    const hasValidHeadingStyle = source.headingStyle === "grommet" || source.headingStyle === "doublePinch";
    if (!hasCanonicalDimensions || !hasValidMode || !hasValidRepeats || !hasValidHeadingStyle) {
      throw new Error("Invalid curtain product metadata.");
    }
  }

  return metadata;
}

function positiveHistoryNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function validateImageSettings(payload) {
  if (payload.quality !== undefined && !isSupportedImageQuality(payload.quality)) {
    throw new Error("Unsupported image quality.");
  }
  if (payload.size !== undefined && !isSupportedImageSize(payload.size)) {
    throw new Error("Unsupported image size.");
  }
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new GenerationRequestError(413, "Request is too large.");
  }
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BYTES) {
      throw new GenerationRequestError(413, "Request is too large.");
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GenerationRequestError(400, "Malformed JSON body.");
  }
}

async function serveStatic(request, response, url) {
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = path.resolve(PUBLIC_DIR, relativePath);
  const relativeTarget = path.relative(PUBLIC_DIR, target);

  if (
    relativeTarget === ".."
    || relativeTarget.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeTarget)
    || !existsSync(target)
  ) {
    sendText(response, 404, "Not found.");
    return;
  }

  const info = await stat(target);
  if (!info.isFile()) {
    sendText(response, 404, "Not found.");
    return;
  }

  response.writeHead(200, {
    "content-type": mimeType(target),
    "cache-control": "no-store",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(target).pipe(response);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".heic": "image/heic",
      ".heif": "image/heif",
      ".svg": "image/svg+xml",
    }[ext] || "application/octet-stream"
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 3456);
  const server = createAppServer({
    historyDir: process.env.HISTORY_DIR || DEFAULT_HISTORY_DIR,
  });
  server.listen(port, () => {
    console.log(`Batch image tool: http://localhost:${port}`);
  });
}
