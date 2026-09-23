import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createAppServer } from "../server.js";
import { createPromptSettingsStore } from "../src/promptSettings.js";
import {
  MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT,
  MANUAL_CURTAIN_PRODUCT_REPEAT_PROMPT,
} from "../src/curtainProductPrompt.js";
import { CURTAIN_CREATION_FIXED_PROMPT } from "../src/curtainCreationPrompt.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("manual fabric metadata endpoint resolves catalog rows without leaking server paths", async (t) => {
  const calls = [];
  const catalogRoots = [];
  const fabricCatalog = {
    async resolve({ fileName, fallbackSampleSizeCm }) {
      calls.push({ fileName, fallbackSampleSizeCm });
      if (fileName === "missing_detail_10.jpg") throw new Error("SKU missing：缺少布料信息");
      return {
        sku: "JLW10001-01",
        sampleSizeCm: fallbackSampleSizeCm,
        sampleSizeSource: "filename",
        fabricMode: "repeat",
        composition: "55%P 45%C",
        repeatVerticalCm: 15,
        repeatHorizontalCm: 20,
        repeatImageName: "JLW10001-01.jpg",
        repeatImagePath: "/private/never-send-this.jpg",
      };
    },
  };
  const promptSettings = createPromptSettingsStore({
    filePath: `/tmp/manual-fabric-metadata-${Date.now()}.json`,
    defaults: {
      manual_product_plain: MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT,
      manual_product_repeat: MANUAL_CURTAIN_PRODUCT_REPEAT_PROMPT,
      curtain_creation: CURTAIN_CREATION_FIXED_PROMPT,
    },
  });
  const server = createAppServer({
    fabricCatalog,
    promptSettings,
    fabricCatalogResolver: async (catalogRoot) => {
      catalogRoots.push(catalogRoot);
      return fabricCatalog;
    },
  });
  const port = await listen(server);
  t.after(() => close(server));

  const response = await fetch(`http://127.0.0.1:${port}/api/manual-product/fabric-metadata`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fallbackSampleSizeCm: 10,
      fabricCatalogRoot: "/Users/wangyuanzi/Documents/code/work2/test/33",
      fileNames: ["JLW10001-01_detail_10.jpg", "missing_detail_10.jpg"],
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(catalogRoots, ["/Users/wangyuanzi/Documents/code/work2/test/33"]);
  assert.deepEqual(calls, [
    { fileName: "JLW10001-01_detail_10.jpg", fallbackSampleSizeCm: 10 },
    { fileName: "missing_detail_10.jpg", fallbackSampleSizeCm: 10 },
  ]);
  assert.equal(body.items[0].ok, true);
  assert.equal(body.items[0].metadata.sku, "JLW10001-01");
  assert.equal(body.items[0].metadata.repeatImageMatched, true);
  assert.equal(body.items[0].metadata.repeatImagePath, undefined);
  assert.equal(body.items[0].metadata.flatSampleSpans.vertical, 27);
  assert.equal(body.items[0].metadata.patternRepeats.vertical, 18);
  assert.equal(body.items[1].ok, false);
  assert.match(body.items[1].error, /SKU missing/);
});
