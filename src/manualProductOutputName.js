import { buildOutputName } from "./naming.js";
import { normalizeCurtainProductStyle } from "./curtainProductStyles.js";

export function manualCurtainHeadingName(style) {
  return normalizeCurtainProductStyle(style) === "doublePinch"
    ? "double-pinch"
    : "grommet";
}

export function manualCurtainProductOutputName({ sku, headingStyle }) {
  return buildOutputName(sku, `_${manualCurtainHeadingName(headingStyle)}`, "webp");
}
