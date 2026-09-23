import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeManualFabricSku,
  sampleSizeFromManualFabricName,
} from "../src/manualFabricIdentity.js";
import { skuFromFabricName } from "../src/naming.js";

test("normalizes manual fabric sample names to their catalog SKU", () => {
  const cases = [
    ["JLW828558-05_detail_15.jpg", "JLW828558-05"],
    ["JLS1025-01（1）_detail_15.jpg", "JLS1025-01"],
    ["nested\\SKU-01_detail_10.png", "SKU-01"],
    ["SKU-A_detail.jpg", "SKU-A"],
    ["ABC（特）_detail_10.jpg", "ABC（特）"],
  ];

  for (const [fileName, expected] of cases) {
    assert.equal(normalizeManualFabricSku(fileName), expected, fileName);
    assert.equal(skuFromFabricName(fileName), expected, fileName);
  }
});

test("detects the physical sample size only from the detail suffix", () => {
  assert.equal(sampleSizeFromManualFabricName("JLW828558-05_detail_15.jpg"), 15);
  assert.equal(sampleSizeFromManualFabricName("JLW828558-05_detail_10.jpg"), 10);
  assert.equal(sampleSizeFromManualFabricName("JLW828558-05_detail.jpg"), null);
  assert.equal(sampleSizeFromManualFabricName("SKU-10.jpg"), null);
});
