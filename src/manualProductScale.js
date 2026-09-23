export const MANUAL_PRODUCT_DIMENSIONS = Object.freeze({
  closedWidthCm: 330,
  productHeightCm: 270,
  finishedPanelWidthCm: 165,
  fullness: 2,
  flatPanelWidthCm: 330,
  flatTotalWidthCm: 660,
  middleOpeningCm: 30,
});

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label}必须是大于 0 的数值。`);
  }
  return number;
}

export function calculateManualProductScale({
  sampleSizeCm,
  fabricMode,
  repeatVerticalCm,
  repeatHorizontalCm,
}) {
  const sampleSize = Number(sampleSizeCm);
  if (sampleSize !== 10 && sampleSize !== 15) {
    throw new Error("实拍面料尺寸必须为 10 或 15 cm。");
  }

  const result = {
    productHeightCm: MANUAL_PRODUCT_DIMENSIONS.productHeightCm,
    flatPanelWidthCm: MANUAL_PRODUCT_DIMENSIONS.flatPanelWidthCm,
    flatTotalWidthCm: MANUAL_PRODUCT_DIMENSIONS.flatTotalWidthCm,
    sampleSpanVertical: MANUAL_PRODUCT_DIMENSIONS.productHeightCm / sampleSize,
    sampleSpanHorizontalPerPanel: MANUAL_PRODUCT_DIMENSIONS.flatPanelWidthCm / sampleSize,
    sampleSpanHorizontalTotal: MANUAL_PRODUCT_DIMENSIONS.flatTotalWidthCm / sampleSize,
    repeatCountVertical: null,
    repeatCountHorizontalPerPanel: null,
    repeatCountHorizontalTotal: null,
  };

  if (fabricMode === "repeat") {
    const vertical = positiveNumber(repeatVerticalCm, "花位纵向长");
    const horizontal = positiveNumber(repeatHorizontalCm, "花位横向长");
    result.repeatCountVertical = MANUAL_PRODUCT_DIMENSIONS.productHeightCm / vertical;
    result.repeatCountHorizontalPerPanel = MANUAL_PRODUCT_DIMENSIONS.flatPanelWidthCm / horizontal;
    result.repeatCountHorizontalTotal = MANUAL_PRODUCT_DIMENSIONS.flatTotalWidthCm / horizontal;
  }

  return result;
}
