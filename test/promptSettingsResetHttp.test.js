import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAppServer } from "../server.js";
import { createPromptSettingsStore } from "../src/promptSettings.js";

const defaults = Object.freeze({
  manual_product_plain: "HTTP源码素面白底默认提示词",
  manual_product_repeat: "HTTP源码花位白底默认提示词",
  curtain_creation: "HTTP源码场景默认提示词",
});

async function createFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "prompt-reset-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const promptSettings = createPromptSettingsStore({
    filePath: path.join(directory, "config", "prompts.json"),
    defaults,
  });
  await promptSettings.save("manual_product_plain", "HTTP自定义素面白底提示词");
  await promptSettings.save("manual_product_repeat", "HTTP自定义花位白底提示词");
  await promptSettings.save("curtain_creation", "HTTP自定义场景提示词");
  const server = createAppServer({
    promptSettings,
    historyDir: path.join(directory, "history"),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("DELETE restores one prompt to its source default and preserves the other override", async (t) => {
  const baseUrl = await createFixture(t);

  const resetResponse = await fetch(`${baseUrl}/api/editable-prompt-templates/manual_product_plain`, {
    method: "DELETE",
  });

  assert.equal(resetResponse.status, 200);
  assert.deepEqual(await resetResponse.json(), {
    kind: "manual_product_plain",
    prompt: defaults.manual_product_plain,
  });
  const current = await fetch(`${baseUrl}/api/editable-prompt-templates`).then((response) => response.json());
  assert.equal(current.manual_product_plain, defaults.manual_product_plain);
  assert.equal(current.manual_product_repeat, "HTTP自定义花位白底提示词");
  assert.equal(current.curtain_creation, "HTTP自定义场景提示词");
});

test("DELETE rejects unsupported prompt kinds", async (t) => {
  const baseUrl = await createFixture(t);

  const response = await fetch(`${baseUrl}/api/editable-prompt-templates/unknown`, {
    method: "DELETE",
  });

  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /不支持的提示词类型/);
});
