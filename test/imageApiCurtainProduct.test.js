import assert from "node:assert/strict";
import test from "node:test";

import { buildCurtainProductFormData } from "../src/imageApi.js";

const dataUrl = "data:image/png;base64,AA==";

function image(name) {
  return { name, type: "image/png", dataUrl };
}

test("plain manual curtain form sends template then sample and never appends Image 3", () => {
  const form = buildCurtainProductFormData({
    headingStyle: "doublePinch",
    template: image("template.webp"),
    fabric: image("plain_detail_10.jpg"),
    fabricMode: "plain",
    fabricMetadata: { sku: "PLAIN", sampleSizeCm: 10, composition: "100% 涤纶" },
    prompt: "",
    fixedPrompt: "素面默认词",
  });

  assert.deepEqual(form.getAll("image[]").map((file) => file.name), [
    "template.webp",
    "plain_detail_10.jpg",
  ]);
  assert.doesNotMatch(String(form.get("prompt")), /Image 3/);
});

test("repeat manual curtain form sends template, sample, then full repeat Image 3", () => {
  const form = buildCurtainProductFormData({
    headingStyle: "doublePinch",
    template: image("template.webp"),
    fabric: image("repeat_detail_15.jpg"),
    repeatImage: image("repeat-full.png"),
    fabricMode: "repeat",
    fabricMetadata: {
      sku: "REPEAT",
      sampleSizeCm: 15,
      composition: "80% 涤纶 20% 棉",
      repeatVerticalCm: 30,
      repeatHorizontalCm: 45,
    },
    prompt: "",
    fixedPrompt: "花位默认词",
  });

  assert.deepEqual(form.getAll("image[]").map((file) => file.name), [
    "template.webp",
    "repeat_detail_15.jpg",
    "repeat-full.png",
  ]);
  assert.match(String(form.get("prompt")), /Image 3/);
});
