import test from "node:test";
import assert from "node:assert/strict";

import {
  MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT,
  MANUAL_CURTAIN_PRODUCT_REPEAT_PROMPT,
  buildCurtainProductPrompt,
} from "../src/curtainProductPrompt.js";
import { calculateManualProductScale } from "../src/manualProductScale.js";

test("builds a plain-fabric prompt with hard sample-density spans and no legacy fabric assumptions", () => {
  const fabricMetadata = {
    sku: "PLAIN-01",
    sampleSizeCm: 10,
    fabricMode: "plain",
    composition: "65% Polyester 35% Chenille",
  };
  const prompt = buildCurtainProductPrompt({
    headingStyle: "doublePinch",
    canvasAspectRatio: "1:1",
    fabricMode: "plain",
    fabricMetadata,
    scale: calculateManualProductScale(fabricMetadata),
    fixedPrompt: MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT,
  });

  assert.match(prompt, /最高优先级硬参数/);
  assert.match(prompt, /270 ÷ 10 = 27/);
  assert.match(prompt, /330 ÷ 10 = 33/);
  assert.match(prompt, /660 ÷ 10 = 66/);
  assert.match(prompt, /65% Polyester 35% Chenille/);
  assert.match(prompt, /微观纹理.*不得.*磨平/s);
  assert.doesNotMatch(prompt, /Image 3/);
  assert.doesNotMatch(prompt, /浅蓝|蓝灰|青灰|短纬纱/);
});

test("builds a repeat prompt with Image 3 roles and independent CSV repeat counts", () => {
  const fabricMetadata = {
    sku: "REPEAT-01",
    sampleSizeCm: 15,
    fabricMode: "repeat",
    composition: "98% Polyester 2% Lurex",
    repeatVerticalCm: 71,
    repeatHorizontalCm: 73,
  };
  const prompt = buildCurtainProductPrompt({
    headingStyle: "doublePinch",
    fabricMode: "repeat",
    fabricMetadata,
    scale: calculateManualProductScale(fabricMetadata),
    fixedPrompt: MANUAL_CURTAIN_PRODUCT_REPEAT_PROMPT,
  });

  assert.match(prompt, /Image 3.*完整花位.*结构/s);
  assert.match(prompt, /Image 2.*颜色.*材质.*优先/s);
  assert.match(prompt, /纵向花位 71 cm/);
  assert.match(prompt, /横向花位 73 cm/);
  assert.match(prompt, /270 ÷ 71 = 3\.8028/);
  assert.match(prompt, /330 ÷ 73 = 4\.5205/);
  assert.match(prompt, /660 ÷ 73 = 9\.0411/);
  assert.match(prompt, /270 ÷ 15 = 18/);
  assert.match(prompt, /Image 3.*颜色.*不得/s);
  assert.doesNotMatch(prompt, /浅蓝|蓝灰|青灰|短纬纱/);
});

test("manual product defaults distinguish the white background from fabric color and preserve blended color identity", () => {
  for (const prompt of [MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT, MANUAL_CURTAIN_PRODUCT_REPEAT_PROMPT]) {
    assert.match(prompt, /纯白只属于输出背景/);
    assert.match(prompt, /综合色相/);
    assert.match(prompt, /蓝绿、砖红、黄赭/);
    assert.doesNotMatch(prompt, /白底窗帘模板/);
    assert.doesNotMatch(prompt, /白底成品窗帘/);
  }
});
