export const STANDARD_CURTAIN = Object.freeze({
  finishedWidthCm: 300,
  finishedHeightCm: 270,
  fullness: 2,
  flatWidthCm: 600,
});

export const CURTAIN_PRODUCT = Object.freeze({
  finishedWidthCm: 330,
  finishedHeightCm: 270,
  fullness: 2,
  flatWidthCm: 660,
});

function adaptiveScalePrompt(sourceImageLabel) {
  return `该 SKU 没有花位尺寸。先根据 ${sourceImageLabel} 静默判断面料类型：
- 纯色或近纯色：只还原底色、织法和细微纤维，不创造花纹。
- 小肌理或密集小花：表现为连续、细密的表面纹理，禁止放大成巨型图案。
- 大肌理或大花型：根据主要结构、重复关系、边缘延续和纹理层级，自适应选择符合真实窗帘的尺度；不得将几厘米的局部裁图拉伸成整片窗帘。
- 明确的定位花：保留单一主体构图和合理位置，不进行密集重复。
- 无明显循环边界的连续肌理：自然延展，不制造明显拼接、镜像接缝或机械重复。
尺度判断必须符合真实纺织品和室内窗帘常识。禁止 fit-to-panel、stretch-to-fill，以及把完整 ${sourceImageLabel} 直接铺满整片窗帘。`;
}

export function buildPatternScaleContract(options = {}) {
  const { verticalCm, horizontalCm } = options;
  const vertical = positiveNumber(verticalCm);
  const horizontal = positiveNumber(horizontalCm);
  const curtain = normalizeCurtainDimensions(options.curtainDimensions);
  const horizontalCalculationWidthCm = positiveNumber(options.horizontalCalculationWidthCm)
    ?? curtain.flatWidthCm;

  return {
    mode: vertical || horizontal ? "known" : "adaptive",
    ...curtain,
    verticalCm: vertical,
    horizontalCm: horizontal,
    verticalRepeats: vertical ? repeatCount(curtain.finishedHeightCm, vertical) : null,
    horizontalRepeats: horizontal ? repeatCount(horizontalCalculationWidthCm, horizontal) : null,
  };
}

export function buildPatternScalePrompt(options = {}) {
  const contract = buildPatternScaleContract(options);
  const sourceImageLabel = normalizeSourceImageLabel(options.sourceImageLabel);
  const horizontalCalculationWidthCm = positiveNumber(options.horizontalCalculationWidthCm)
    ?? contract.flatWidthCm;
  const lines = [
    "标准窗帘物理尺寸与花回尺度合同：",
    `成品总宽：${formatNumber(contract.finishedWidthCm)} cm`,
    `成品总高：${formatNumber(contract.finishedHeightCm)} cm`,
    `褶皱倍数：${formatNumber(contract.fullness)}`,
    `展开总布宽：${formatNumber(contract.flatWidthCm)} cm`,
    ...(horizontalCalculationWidthCm === contract.flatWidthCm
      ? []
      : [`横向花回计算宽度：${formatNumber(horizontalCalculationWidthCm)} cm`]),
    `纵向花回：${formatCentimeters(contract.verticalCm)}`,
    `横向花回：${formatCentimeters(contract.horizontalCm)}`,
    `纵向理论完整花回数：${formatNumber(contract.verticalRepeats)}`,
    `横向理论完整花回数：${formatNumber(contract.horizontalRepeats)}`,
    `花回识别规则：默认将 ${sourceImageLabel} 中的面料主体视为一个完整花回。只有在图中明显出现至少两组边界、主体结构、方向和间距一致的重复单元时，才判定该参考图包含多个花回。`,
    `若 ${sourceImageLabel} 明显包含多个花回，必须从重复关系中识别并采用其中一个最小但完整的花回单元；上述数据库花回尺寸对应这个单元。禁止把整张多花回参考图误当成一个花回，也禁止把完整花回内部的单个花朵、枝叶或局部纹理误判成独立花回。`,
    "理论完整花回数只规定连续布料的图案密度和裁剪尺度；画面边缘允许裁到部分花回，不要求边缘刚好结束于完整花回。",
    "纵横方向必须采用同一物理比例（各向同性尺度），不得分别缩放、拉伸或压缩。",
  ];

  if (contract.mode === "adaptive") {
    lines.push("", adaptiveScalePrompt(sourceImageLabel));
  } else {
    lines.push("细小花回不得为了提高可见性而放大。大花回不得为了增加重复数量而缩小。");

    if (!contract.verticalCm || !contract.horizontalCm) {
      lines.push(
        `已知方向是不可改变的绝对尺度锚点；缺失方向只能依据 ${sourceImageLabel} 中源面料图花型的原始长宽比例推断，不得为了填满窗帘单独拉伸缺失方向。`,
      );
    }
  }

  return lines.join("\n");
}

function normalizeCurtainDimensions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return STANDARD_CURTAIN;
  const finishedWidthCm = positiveNumber(value.finishedWidthCm);
  const finishedHeightCm = positiveNumber(value.finishedHeightCm);
  const fullness = positiveNumber(value.fullness);
  const flatWidthCm = positiveNumber(value.flatWidthCm);
  if (!finishedWidthCm || !finishedHeightCm || !fullness || !flatWidthCm) return STANDARD_CURTAIN;
  return { finishedWidthCm, finishedHeightCm, fullness, flatWidthCm };
}

function positiveNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;

  const number = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(number) || number <= 0) return null;
  return round(number) > 0 ? number : null;
}

function normalizeSourceImageLabel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "Image 2";
}

function repeatCount(totalCm, repeatCm) {
  const value = totalCm / repeatCm;
  return Number.isFinite(value) ? round(value) : null;
}

function round(value) {
  return Number(value.toFixed(2));
}

function formatCentimeters(value) {
  return value === null ? "未知" : `${formatNumber(value)} cm`;
}

function formatNumber(value) {
  return value === null || !Number.isFinite(value) ? "未知" : String(round(value));
}
