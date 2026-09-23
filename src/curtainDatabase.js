import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import mysql from "mysql2/promise";

const DEFAULT_IMAGE_BASE_URL = "/uploads/sku-images";
const DEFAULT_ENV_FILE = process.platform === "win32" ? "C:\\报价\\.env" : "";
const DATABASE_MODES = new Set(["continue", "regenerate"]);
const DATABASE_TASK_TYPES = new Set(["scene_replacement", "curtain_product"]);
const TRANSIENT_DATABASE_ERRORS = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
]);

export function loadCurtainDatabaseConfig({ envFile, env = process.env } = {}) {
  const resolvedEnvFile = path.resolve(envFile || env.CURTAIN_DB_ENV_FILE || DEFAULT_ENV_FILE || ".env");
  const fileValues = readEnvFile(resolvedEnvFile);
  const value = (name, fallback = "") => cleanValue(env[name] ?? fileValues[name] ?? fallback);
  const quoteRoot = path.dirname(resolvedEnvFile);

  return {
    db: {
      host: value("DB_HOST", "127.0.0.1"),
      port: positiveInteger(value("DB_PORT", "3306"), 3306),
      database: value("DB_NAME", "curtain_pricing"),
      user: value("DB_USER", "root"),
      password: value("DB_PASSWORD"),
    },
    imageRoot: path.resolve(
      value("SKU_IMAGE_LOCAL_ROOT") || path.join(quoteRoot, "data", "uploads", "sku-images"),
    ),
    imageBaseUrl: normalizeBaseUrl(value("SKU_IMAGE_BASE_URL", DEFAULT_IMAGE_BASE_URL)),
  };
}

export function createCurtainDatabaseService({
  config = loadCurtainDatabaseConfig(),
  pool = null,
  retryDelayMs = 120,
} = {}) {
  let activePool = pool;
  let ownsPool = !pool;

  function getPool() {
    if (!activePool) {
      activePool = mysql.createPool({
        ...config.db,
        decimalNumbers: true,
        waitForConnections: true,
        connectionLimit: 10,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        connectTimeout: 10_000,
      });
      ownsPool = true;
    }
    return activePool;
  }

  const execute = (sql, params = []) => executeWithRetry(getPool, sql, params, retryDelayMs);

  return {
    async listJobs(mode = "continue", taskType = "scene_replacement") {
      const normalizedMode = normalizeDatabaseMode(mode);
      const normalizedTaskType = normalizeDatabaseTaskType(taskType);
      const [rows] = await execute(jobSql(normalizedTaskType));
      const allJobs = rows.map((row) => mapJob(row, normalizedTaskType));
      const completed = normalizedTaskType === "scene_replacement"
        ? allJobs.filter((job) => job.existingSceneImageUrl).length
        : 0;
      return {
        jobs: normalizedTaskType === "curtain_product" || normalizedMode === "regenerate"
          ? allJobs
          : allJobs.filter((job) => !job.existingSceneImageUrl),
        progress: {
          total: allJobs.length,
          completed,
          pending: allJobs.length - completed,
        },
      };
    },

    async getJob(factorySku, mode = "continue", taskType = "scene_replacement") {
      const normalizedTaskType = normalizeDatabaseTaskType(taskType);
      const sku = cleanValue(factorySku);
      if (!sku) return null;
      const normalizedMode = normalizeDatabaseMode(mode);
      const [rows] = await execute(`${jobSql(normalizedTaskType)} AND m.factory_sku = ? LIMIT 1`, [sku]);
      const job = rows[0] ? mapJob(rows[0], normalizedTaskType) : null;
      if (!job || (
        normalizedTaskType === "scene_replacement"
        && normalizedMode === "continue"
        && job.existingSceneImageUrl
      )) return null;
      return job;
    },

    async listPendingJobs() {
      return (await this.listJobs("continue")).jobs;
    },

    async getPendingJob(factorySku) {
      return this.getJob(factorySku, "continue");
    },

    async readAsset(imageUrl) {
      const filePath = managedImagePath(imageUrl, config);
      return {
        buffer: await readFile(filePath),
        fileName: path.basename(filePath),
        mimeType: mimeTypeFromExtension(path.extname(filePath)),
      };
    },

    async close() {
      if (ownsPool && activePool?.end) {
        await activePool.end();
        activePool = null;
      }
    },
  };
}

export function managedImagePath(imageUrl, { imageRoot, imageBaseUrl = DEFAULT_IMAGE_BASE_URL }) {
  const value = cleanValue(imageUrl);
  const base = normalizeBaseUrl(imageBaseUrl);
  if (!value || /^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new Error("不受管理的图片地址");
  }

  const pathname = value.split(/[?#]/, 1)[0];
  if (!pathname.startsWith(`${base}/`)) {
    throw new Error("不受管理的图片地址");
  }

  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice(base.length + 1));
  } catch {
    throw new Error("不受管理的图片地址");
  }

  const segments = relativePath.split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("不受管理的图片地址");
  }

  const root = path.resolve(imageRoot);
  const target = path.resolve(root, ...segments);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error("不受管理的图片地址");
  }
  return target;
}

function jobSql(taskType) {
  return taskType === "curtain_product" ? productJobSql() : sceneJobSql();
}

function sceneJobSql() {
  return `
    SELECT
      m.factory_sku,
      m.sku_code,
      m.series_code,
      m.source_sheet_name AS factory_name,
      fp.folder_code AS factory_folder,
      m.pattern_repeat_vertical_cm,
      m.pattern_repeat_horizontal_cm,
      pi.detail_image_url,
      ssi.scene_image_url AS series_scene_image_url,
      pi.scene_image_url AS sku_scene_image_url
    FROM sku_material m
    JOIN sku_product_image pi
      ON pi.factory_sku = m.factory_sku
    JOIN series_scene_image ssi
      ON ssi.factory_name = m.source_sheet_name
     AND ssi.series_code = m.series_code
    JOIN factory_profile fp
      ON fp.factory_name COLLATE utf8mb4_unicode_ci = m.source_sheet_name
    WHERE m.status = 'active'
      AND pi.detail_image_url IS NOT NULL
      AND TRIM(pi.detail_image_url) <> ''
      AND ssi.scene_image_url IS NOT NULL
      AND TRIM(ssi.scene_image_url) <> ''
  `;
}

function productJobSql() {
  return `
    SELECT
      m.factory_sku,
      m.sku_code,
      m.series_code,
      m.source_sheet_name AS factory_name,
      fp.folder_code AS factory_folder,
      m.pattern_repeat_vertical_cm,
      m.pattern_repeat_horizontal_cm,
      pi.detail_image_url
    FROM sku_material m
    JOIN sku_product_image pi
      ON pi.factory_sku = m.factory_sku
    JOIN factory_profile fp
      ON fp.factory_name COLLATE utf8mb4_unicode_ci = m.source_sheet_name
    WHERE m.status = 'active'
      AND pi.detail_image_url IS NOT NULL
      AND TRIM(pi.detail_image_url) <> ''
  `;
}

function mapJob(row, taskType) {
  const detailImageUrl = cleanValue(row.detail_image_url);
  const isSceneReplacement = taskType === "scene_replacement";
  const seriesSceneImageUrl = isSceneReplacement ? cleanValue(row.series_scene_image_url) : "";
  return {
    factorySku: cleanValue(row.factory_sku),
    skuCode: cleanValue(row.sku_code),
    seriesCode: cleanValue(row.series_code),
    factoryName: cleanValue(row.factory_name),
    factoryFolder: cleanValue(row.factory_folder),
    patternRepeatVerticalCm: nullablePositiveNumber(row.pattern_repeat_vertical_cm),
    patternRepeatHorizontalCm: nullablePositiveNumber(row.pattern_repeat_horizontal_cm),
    detailImageUrl,
    seriesSceneImageUrl,
    existingSceneImageUrl: isSceneReplacement ? cleanValue(row.sku_scene_image_url) : "",
    detailAssetUrl: databaseAssetUrl(detailImageUrl),
    seriesSceneAssetUrl: seriesSceneImageUrl ? databaseAssetUrl(seriesSceneImageUrl) : "",
  };
}

async function executeWithRetry(getPool, sql, params, retryDelayMs, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await getPool().execute(sql, params);
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseError(error) || attempt === attempts - 1) throw error;
      if (retryDelayMs > 0) await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

function normalizeDatabaseMode(mode) {
  const value = cleanValue(mode) || "continue";
  if (!DATABASE_MODES.has(value)) throw new Error("数据库任务方式无效");
  return value;
}

function normalizeDatabaseTaskType(taskType) {
  if (!DATABASE_TASK_TYPES.has(taskType)) {
    throw new Error("数据库任务类型无效，仅支持 scene_replacement 或 curtain_product");
  }
  return taskType;
}

function isTransientDatabaseError(error) {
  return TRANSIENT_DATABASE_ERRORS.has(error?.code) || error?.errno === 1205 || error?.errno === 1213;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function databaseAssetUrl(imageUrl) {
  return `/api/database/asset?url=${encodeURIComponent(imageUrl)}`;
}

function mimeTypeFromExtension(extension) {
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
  }[String(extension || "").toLowerCase()] || "application/octet-stream";
}

function readEnvFile(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  const values = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    values[trimmed.slice(0, index).trim()] = stripQuotes(trimmed.slice(index + 1).trim());
  }
  return values;
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeBaseUrl(value) {
  const cleaned = cleanValue(value).replace(/\/+$/, "");
  return cleaned || DEFAULT_IMAGE_BASE_URL;
}

function nullablePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function cleanValue(value) {
  return String(value ?? "").trim();
}
