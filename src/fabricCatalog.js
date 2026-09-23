import fs from "node:fs/promises";
import path from "node:path";

import { parseCsvRows } from "./csvRows.js";
import {
  normalizeManualFabricSku,
  sampleSizeFromManualFabricName,
} from "./manualFabricIdentity.js";

const SKU_COLUMN = "工厂sku*";
const REPEAT_VERTICAL_COLUMN = "花位纵向长(cm)";
const REPEAT_HORIZONTAL_COLUMN = "花位横向长(cm)";
const COMPOSITION_COLUMN = "成分*";

function skuKey(value) {
  return String(value || "").trim().toUpperCase();
}

function isSlash(value) {
  return String(value ?? "").trim() === "/";
}

function parsePositiveRepeat(value, label, sku) {
  const normalized = String(value ?? "").trim();
  const number = Number(normalized);
  if (normalized === "" || !Number.isFinite(number) || number <= 0) {
    throw new Error(`SKU ${sku} 的${label}必须是大于 0 的数值，当前值为“${normalized || "空"}”。`);
  }
  return number;
}

function classifyRow(row, sku) {
  const verticalRaw = row[REPEAT_VERTICAL_COLUMN];
  const horizontalRaw = row[REPEAT_HORIZONTAL_COLUMN];
  const verticalSlash = isSlash(verticalRaw);
  const horizontalSlash = isSlash(horizontalRaw);

  if (verticalSlash && horizontalSlash) {
    return { fabricMode: "plain", repeatVerticalCm: null, repeatHorizontalCm: null };
  }
  if (verticalSlash !== horizontalSlash) {
    throw new Error(`SKU ${sku} 的花位纵向长与花位横向长必须同时为“/”或同时为有效数值。`);
  }
  return {
    fabricMode: "repeat",
    repeatVerticalCm: parsePositiveRepeat(verticalRaw, "花位纵向长", sku),
    repeatHorizontalCm: parsePositiveRepeat(horizontalRaw, "花位横向长", sku),
  };
}

export function createFabricCatalog({ csvPath, repeatImageDir, fileOps = fs }) {
  let cachedIndexPromise = null;

  async function buildIndex() {
    let csvText;
    let imageNames;
    try {
      [csvText, imageNames] = await Promise.all([
        fileOps.readFile(csvPath, "utf8"),
        fileOps.readdir(repeatImageDir),
      ]);
    } catch (error) {
      throw new Error(`无法读取面料目录。CSV：${csvPath}；完整花位图目录：${repeatImageDir}；${error.message}`);
    }

    const rowsBySku = new Map();
    for (const row of parseCsvRows(csvText)) {
      const sku = String(row[SKU_COLUMN] ?? "").trim();
      if (!sku) continue;
      const key = skuKey(sku);
      if (rowsBySku.has(key)) {
        throw new Error(`CSV 中存在重复 SKU：${sku}。`);
      }
      rowsBySku.set(key, row);
    }

    const imagesBySku = new Map();
    for (const imageName of imageNames) {
      if (!/\.(?:jpe?g|png|webp|heic|heif)$/i.test(imageName)) continue;
      const key = skuKey(normalizeManualFabricSku(imageName));
      const matches = imagesBySku.get(key) || [];
      matches.push(imageName);
      imagesBySku.set(key, matches);
    }
    return { rowsBySku, imagesBySku };
  }

  async function getIndex() {
    if (!cachedIndexPromise) {
      cachedIndexPromise = buildIndex().catch((error) => {
        cachedIndexPromise = null;
        throw error;
      });
    }
    return cachedIndexPromise;
  }

  return {
    async resolve({ fileName, fallbackSampleSizeCm }) {
      const sku = normalizeManualFabricSku(fileName);
      const { rowsBySku, imagesBySku } = await getIndex();
      const row = rowsBySku.get(skuKey(sku));
      if (!row) {
        throw new Error(`CSV 中找不到 SKU ${sku}（来源文件：${fileName}）。`);
      }

      const inferredSampleSize = sampleSizeFromManualFabricName(fileName);
      const fallback = Number(fallbackSampleSizeCm);
      const sampleSizeCm = inferredSampleSize ?? fallback;
      if (sampleSizeCm !== 10 && sampleSizeCm !== 15) {
        throw new Error(`SKU ${sku} 无法确定实拍尺寸；文件名需包含 _detail_10/_detail_15，或提供 10/15 cm 回退尺寸。`);
      }

      const classification = classifyRow(row, sku);
      let repeatImageName = null;
      let repeatImagePath = null;
      if (classification.fabricMode === "repeat") {
        const candidates = imagesBySku.get(skuKey(sku)) || [];
        if (candidates.length === 0) {
          throw new Error(`有花位 SKU ${sku} 缺少完整花位图：${repeatImageDir}。`);
        }
        if (candidates.length > 1) {
          throw new Error(`SKU ${sku} 匹配到多个完整花位图：${candidates.join("、")}。`);
        }
        [repeatImageName] = candidates;
        repeatImagePath = path.join(repeatImageDir, repeatImageName);
      }

      return {
        sku,
        sampleSizeCm,
        sampleSizeSource: inferredSampleSize ? "filename" : "fallback",
        ...classification,
        composition: String(row[COMPOSITION_COLUMN] ?? "").trim(),
        repeatImagePath,
        repeatImageName,
      };
    },
  };
}
