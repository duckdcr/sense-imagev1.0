import test from "node:test";
import assert from "node:assert/strict";

import { calculateManualProductScale } from "../src/manualProductScale.js";

test("locks the complete sample span independently for 10 cm and 15 cm samples", () => {
  assert.deepEqual(
    calculateManualProductScale({ sampleSizeCm: 10, fabricMode: "plain" }),
    {
      productHeightCm: 270,
      flatPanelWidthCm: 330,
      flatTotalWidthCm: 660,
      sampleSpanVertical: 27,
      sampleSpanHorizontalPerPanel: 33,
      sampleSpanHorizontalTotal: 66,
      repeatCountVertical: null,
      repeatCountHorizontalPerPanel: null,
      repeatCountHorizontalTotal: null,
    },
  );
  const fifteen = calculateManualProductScale({ sampleSizeCm: 15, fabricMode: "plain" });
  assert.equal(fifteen.sampleSpanVertical, 18);
  assert.equal(fifteen.sampleSpanHorizontalPerPanel, 22);
  assert.equal(fifteen.sampleSpanHorizontalTotal, 44);
});

test("calculates CSV repeat counts separately from the sample span", () => {
  const scale = calculateManualProductScale({
    sampleSizeCm: 15,
    fabricMode: "repeat",
    repeatVerticalCm: 71,
    repeatHorizontalCm: 73,
  });

  assert.equal(scale.sampleSpanVertical, 18);
  assert.equal(scale.repeatCountVertical, 270 / 71);
  assert.equal(scale.repeatCountHorizontalPerPanel, 330 / 73);
  assert.equal(scale.repeatCountHorizontalTotal, 660 / 73);
});

test("rejects invalid sample and repeat dimensions", () => {
  assert.throws(
    () => calculateManualProductScale({ sampleSizeCm: 12, fabricMode: "plain" }),
    /10 或 15/,
  );
  assert.throws(
    () => calculateManualProductScale({ sampleSizeCm: 10, fabricMode: "repeat", repeatVerticalCm: 0, repeatHorizontalCm: 20 }),
    /花位纵向长/,
  );
  assert.throws(
    () => calculateManualProductScale({ sampleSizeCm: 10, fabricMode: "repeat", repeatVerticalCm: 20 }),
    /花位横向长/,
  );
});
