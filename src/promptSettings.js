import { randomUUID } from "node:crypto";
import {
  mkdir as defaultMkdir,
  readFile as defaultReadFile,
  rename as defaultRename,
  unlink as defaultUnlink,
  writeFile as defaultWriteFile,
} from "node:fs/promises";
import path from "node:path";

export const PROMPT_KINDS = Object.freeze([
  "manual_product_plain",
  "manual_product_repeat",
  "curtain_creation",
]);

const MAX_PROMPT_CHARS = 20_000;
const JOB_PROMPT_KIND = Object.freeze({
  creation: "curtain_creation",
});

export class PromptSettingsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PromptSettingsError";
    this.code = code;
  }
}

export function createPromptSettingsStore({
  filePath,
  defaults,
  fileOps = {},
} = {}) {
  if (!filePath) throw new Error("提示词配置路径不能为空");
  const normalizedDefaults = normalizeDefaults(defaults);
  const operations = {
    mkdir: fileOps.mkdir || defaultMkdir,
    readFile: fileOps.readFile || defaultReadFile,
    rename: fileOps.rename || defaultRename,
    unlink: fileOps.unlink || defaultUnlink,
    writeFile: fileOps.writeFile || defaultWriteFile,
  };

  async function readStoredValues() {
    try {
      const parsed = JSON.parse(await operations.readFile(filePath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
      throw error;
    }
  }

  async function readAll() {
    const stored = await readStoredValues();
    return Object.fromEntries(PROMPT_KINDS.map((kind) => [
      kind,
      validStoredPrompt(stored[kind]) || normalizedDefaults[kind],
    ]));
  }

  async function get(kind) {
    assertPromptKind(kind);
    return (await readAll())[kind];
  }

  async function writeStoredValues(values) {
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    await operations.mkdir(directory, { recursive: true });
    try {
      await operations.writeFile(temporaryPath, `${JSON.stringify(values, null, 2)}\n`, "utf8");
      await operations.rename(temporaryPath, filePath);
    } catch (error) {
      await operations.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async function save(kind, prompt) {
    assertPromptKind(kind);
    const normalizedPrompt = normalizePrompt(prompt);
    // Keep only explicit user overrides.  In particular, do not materialize
    // defaults or let a legacy `manual_product` value leak into the two new
    // white-background prompt slots.
    const next = { ...(await readStoredValues()), [kind]: normalizedPrompt };
    await writeStoredValues(next);
    return normalizedPrompt;
  }

  async function reset(kind) {
    assertPromptKind(kind);
    const next = { ...(await readStoredValues()) };
    delete next[kind];
    await writeStoredValues(next);
    return normalizedDefaults[kind];
  }

  return Object.freeze({ readAll, get, save, reset });
}

export async function withCurrentFixedPrompt(jobKind, payload, store) {
  const promptKind = JOB_PROMPT_KIND[jobKind];
  if (!promptKind) return { ...(payload || {}) };
  return {
    ...(payload || {}),
    fixedPrompt: await store.get(promptKind),
  };
}

function assertPromptKind(kind) {
  if (!PROMPT_KINDS.includes(kind)) {
    throw new PromptSettingsError("不支持的提示词类型", "UNSUPPORTED_PROMPT_KIND");
  }
}

function normalizeDefaults(defaults) {
  return Object.fromEntries(PROMPT_KINDS.map((kind) => {
    const value = validStoredPrompt(defaults?.[kind]);
    if (!value) throw new Error(`源码默认提示词无效：${kind}`);
    return [kind, value];
  }));
}

function normalizePrompt(prompt) {
  if (typeof prompt !== "string") {
    throw new PromptSettingsError("提示词必须是文本", "INVALID_PROMPT");
  }
  const normalized = prompt.trim();
  if (!normalized) {
    throw new PromptSettingsError("提示词不能为空", "INVALID_PROMPT");
  }
  if (normalized.length > MAX_PROMPT_CHARS) {
    throw new PromptSettingsError("提示词不能超过 20000 个字符", "INVALID_PROMPT");
  }
  return normalized;
}

function validStoredPrompt(prompt) {
  if (typeof prompt !== "string") return "";
  const normalized = prompt.trim();
  return normalized && normalized.length <= MAX_PROMPT_CHARS ? normalized : "";
}
