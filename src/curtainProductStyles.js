export const CURTAIN_PRODUCT_STYLES = Object.freeze({
  grommet: Object.freeze({
    label: "圆孔帘",
    templateFile: "grommet-template.png",
    outputSuffix: "grommet",
  }),
  doublePinch: Object.freeze({
    label: "韩式双捏褶帘",
    templateFile: "double-pinch-template.png",
    outputSuffix: "double-pinch",
  }),
});

export function normalizeCurtainProductStyle(value) {
  if (value === "grommet" || value === "doublePinch") return value;
  throw new Error("帘头样式无效");
}

export function curtainProductOutputName(sku, style) {
  const normalizedStyle = normalizeCurtainProductStyle(style);
  const normalizedSku = String(sku || "").trim();
  if (!normalizedSku) throw new Error("SKU 无效");
  return buildOutputName(normalizedSku, `_${CURTAIN_PRODUCT_STYLES[normalizedStyle].outputSuffix}`, "webp");
}
import { buildOutputName } from "./naming.js";
