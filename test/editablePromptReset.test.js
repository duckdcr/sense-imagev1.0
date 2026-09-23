import assert from "node:assert/strict";
import test from "node:test";

import * as editablePrompts from "../public/editablePromptSettings.js";

test("reset sends DELETE and returns the server-confirmed default prompt", async () => {
  const restored = await editablePrompts.resetEditablePromptTemplate(
    "manual_product_repeat",
    async (url, options) => {
      assert.equal(url, "/api/editable-prompt-templates/manual_product_repeat");
      assert.equal(options.method, "DELETE");
      return new Response(JSON.stringify({
        kind: "manual_product_repeat",
        prompt: "源码花位白底默认提示词",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  assert.equal(restored, "源码花位白底默认提示词");
});

test("reset surfaces server errors and rejects unsupported kinds before fetch", async () => {
  await assert.rejects(
    () => editablePrompts.resetEditablePromptTemplate(
      "manual_product_plain",
      async () => new Response(JSON.stringify({ error: "配置文件无法写入" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    ),
    /配置文件无法写入/,
  );

  let calls = 0;
  await assert.rejects(
    () => editablePrompts.resetEditablePromptTemplate("unknown", async () => { calls += 1; }),
    /不支持的提示词类型/,
  );
  assert.equal(calls, 0);
});
