import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPromptSettingsStore } from "../src/promptSettings.js";

const defaults = Object.freeze({
  manual_product_plain: "源码素面白底默认提示词",
  manual_product_repeat: "源码花位白底默认提示词",
  curtain_creation: "源码场景默认提示词",
});

test("reset removes only the requested override and survives store reload", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prompt-reset-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "config", "prompts.json");
  const store = createPromptSettingsStore({ filePath, defaults });

  await store.save("manual_product_plain", "自定义素面白底提示词");
  await store.save("manual_product_repeat", "自定义花位白底提示词");
  await store.save("curtain_creation", "自定义场景提示词");

  const restoredPrompt = await store.reset("manual_product_plain");

  assert.equal(restoredPrompt, defaults.manual_product_plain);
  assert.equal(await store.get("manual_product_plain"), defaults.manual_product_plain);
  assert.equal(await store.get("manual_product_repeat"), "自定义花位白底提示词");
  assert.equal(await store.get("curtain_creation"), "自定义场景提示词");
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    manual_product_repeat: "自定义花位白底提示词",
    curtain_creation: "自定义场景提示词",
  });

  const reloaded = createPromptSettingsStore({ filePath, defaults });
  assert.equal(await reloaded.get("manual_product_plain"), defaults.manual_product_plain);
  assert.equal(await reloaded.get("manual_product_repeat"), "自定义花位白底提示词");
  assert.equal(await reloaded.get("curtain_creation"), "自定义场景提示词");
});

test("reset rejects unsupported prompt kinds without changing stored values", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prompt-reset-kind-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "config", "prompts.json");
  const store = createPromptSettingsStore({ filePath, defaults });
  await store.save("manual_product_plain", "保留的素面白底提示词");

  await assert.rejects(
    () => store.reset("unknown"),
    (error) => error?.code === "UNSUPPORTED_PROMPT_KIND",
  );
  assert.equal(await store.get("manual_product_plain"), "保留的素面白底提示词");
});

test("legacy manual_product override never becomes either new white-background prompt", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prompt-legacy-kind-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "config", "prompts.json");
  await import("node:fs/promises").then(({ mkdir, writeFile }) =>
    mkdir(path.dirname(filePath), { recursive: true })
      .then(() => writeFile(filePath, JSON.stringify({ manual_product: "旧版覆盖词" }), "utf8")),
  );
  const store = createPromptSettingsStore({ filePath, defaults });

  assert.equal(await store.get("manual_product_plain"), defaults.manual_product_plain);
  assert.equal(await store.get("manual_product_repeat"), defaults.manual_product_repeat);
  await store.save("manual_product_plain", "新的素面覆盖词");
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    manual_product: "旧版覆盖词",
    manual_product_plain: "新的素面覆盖词",
  });
});
