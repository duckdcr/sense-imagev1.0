import { CURTAIN_PRODUCT, buildPatternScalePrompt } from "./patternScale.js";
import { CURTAIN_PRODUCT_STYLES, normalizeCurtainProductStyle } from "./curtainProductStyles.js";
import { calculateManualProductScale } from "./manualProductScale.js";

export const MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT = `任务：根据 Image 1 的纯白背景窗帘结构模板和 Image 2 的实拍面料图，生成一套正视、中间对开的双片成品窗帘。只输出最终产品图，不输出任何分析、文字、标记或水印。

【背景白与面料固有颜色严格分离】
纯白只属于输出背景，不属于窗帘面料。Image 1 的纯白背景不代表成品窗帘必须是白色、米白色、灰色、卡其色或低饱和色；成品窗帘的所有固有颜色只能来自 Image 2。
即使 Image 2 的颜色由细纱、点状纱结、短线、混色经纬或高频织纹构成，成品全景中单根纱线可以按真实尺度自然融合，但综合色相、颜色面积比例、最深色、最饱和色及冷暖关系仍必须保留。不得因白色背景、全景缩小、褶皱阴影或“自然融合”而把蓝绿、砖红、黄赭、棕灰、暖灰或其他 Image 2 固有色平均成统一的浅米灰、卡其灰或冷灰窗帘。

【最高优先级：完整传递素面料或微纹理面料】
本任务是把 Image 2 所代表的真实连续织物重建到 Image 1 的窗帘结构上，不是生成一种颜色相近的普通布。即使没有独立花位，Image 2 的固有综合色差、经纬组织、纱线粗细、竹节、颗粒、毛羽、孔隙、暗缝、局部起伏、微高光和微接触阴影仍然构成面料身份，必须保留。微观纹理不得被磨平、降噪、模糊、颜色平均或替换为通用布纹。不得凭空增加 Image 2 中不存在的花位、条纹、方格或装饰图案。

【图片职责不可互换】
Image 1 只控制帘头样式、孔位或捏褶结构、完整轮廓、两片布局、留白、褶皱数量、褶峰褶谷位置、褶皱宽度、宏观阴影和明暗关系。Image 1 不提供面料颜色、织纹或材质。Image 2 是唯一面料来源，只控制固有颜色、深浅比例、经纬密度、织纹、肌理、纤维、表面高低差、厚度、光泽和材质。两张图职责不可互换。

【连续平展面料与真实密度】
先把 Image 2 理解为正视、平展、连续、均匀受光的真实面料，再裁成左右两片并连续包覆到 Image 1。不得拉伸整张 Image 2 铺满窗帘，不得把样本矩形机械平铺、逐褶复制、镜像或轴对称。低于成品像素分辨能力的细小经纬和颗粒必须按真实密度自然融合成可辨识的综合色差、粗糙度和织造方向，不能为了清楚而放大成粗网格、大孔、圆点、横肋或纵肋。

【固有面料与褶皱光影分离】
Image 2 的固有颜色和纱线级微阴影必须保留；只允许去除拍摄造成的低频大范围照明不均。Image 1 的褶谷阴影只能调制宏观亮度，不能替代面料自身的暗缝；褶峰高光不得漂白固有深色或抹掉经纬组织。进入褶谷的面料只发生连续横向压缩、折入和局部遮挡，不得切断、重置或重新生成纹理。

【左右连续裁切与输出】
左右两片来自同一卷连续面料的不同连续位置，方向、物理尺度、密度、颜色体系和织法一致，但不得复制、镜像或轴对称。输出必须正视、完整全长、纯白均匀无纹理背景；只保留中间对开的双片窗帘。不得出现房间、窗户、窗帘杆、轨道、挂钩、家具、道具、文字、水印、尺寸线、边框、背景投影、商品卡片、景深、虚化、散焦或 bokeh。`;

export const MANUAL_CURTAIN_PRODUCT_REPEAT_PROMPT = `任务：根据 Image 1 的纯白背景窗帘结构模板、Image 2 的实拍面料图和 Image 3 的完整花位图，生成一套正视、中间对开的双片成品窗帘。只输出最终产品图，不输出任何分析、文字、标记或水印。

【背景白与面料固有颜色严格分离】
纯白只属于输出背景，不属于窗帘面料。Image 1 的纯白背景不代表成品窗帘必须是白色、米白色、灰色、卡其色或低饱和色；成品窗帘的所有固有颜色只能来自 Image 2。
即使 Image 2 的颜色由细纱、点状纱结、短线、混色经纬或高频织纹构成，成品全景中单根纱线可以按真实尺度自然融合，但综合色相、颜色面积比例、最深色、最饱和色及冷暖关系仍必须保留。不得因白色背景、全景缩小、褶皱阴影或“自然融合”而把蓝绿、砖红、黄赭、棕灰、暖灰或其他 Image 2 固有色平均成统一的浅米灰、卡其灰或冷灰窗帘。

【最高优先级：完整传递真实面料与真实花位】
本任务是先建立一整卷连续平展面料，再把它裁成左右两片并包覆到 Image 1，不是参考输入重新设计相似面料。低频完整花位、中频组成结构、高频经纬材质必须同时存在；不得用普通表面纹理替代花位，也不得为了显示微观纱线而改变花位物理尺度。

【三张图片职责不可互换】
Image 1 只控制帘头样式、孔位或捏褶结构、完整轮廓、两片布局、留白、褶皱数量、褶峰褶谷位置、褶皱宽度、宏观阴影和明暗关系。
Image 2 是实际色号和面料材质的唯一标准，只控制颜色、综合色差、深浅比例、纱线、经纬组织、颗粒、毛羽、孔隙、粗糙度、厚度、光泽和微接触阴影。
Image 3 只控制一个完整花位的二维结构、图案方向、内部布局、元素连接关系和完整边界。Image 3 的颜色、亮度、拍摄光线和材质不得带入最终结果；如 Image 2 与 Image 3 在颜色或材质上冲突，Image 2 的颜色与材质必须优先。

【花位先建立、再裁切、再包覆】
必须严格按系统给出的纵向和横向厘米尺寸，在连续平展面料上建立 Image 3 的完整花位循环。不得根据 Image 2 的实拍裁切范围、图片像素、SKU、颜色或图案复杂度任意改变花位大小、密度和循环次数。Image 2 的实拍范围用于锁定花位内部及花位之间的实际织纹密度，不等于一个完整花位。

左右两片必须从同一卷连续面料的不同连续坐标裁出。不得复制、镜像、轴对称、逐褶重复，也不得让左右图案完全相同。面料图案坐标与窗帘褶皱坐标彼此独立：花位经过褶峰时相对展开，经过侧面时连续横向压缩，进入褶谷时折入并局部遮挡，穿过褶谷后在下一褶面继续。不得在褶峰或褶谷处切断、重置、复制、重新对齐或重新生成花位。

【真实材质与输出】
必须严格复刻 Image 2 的颜色、色相、明暗比例、纱线感、织法、颗粒、起伏、纹理密度和材质。Image 2 中的细小深浅、凹槽、毛羽和微高光不得被净化、平滑、美化、降噪或替换。输出必须正视、完整全长、纯白均匀无纹理背景；只保留中间对开的双片窗帘。不得出现房间、窗户、窗帘杆、轨道、挂钩、家具、道具、文字、水印、尺寸线、边框、背景投影、商品卡片、景深、虚化、散焦或 bokeh。`;

// Kept temporarily for callers that still import the former single default.
export const MANUAL_CURTAIN_PRODUCT_FIXED_PROMPT = MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT;

function productPromptFor(style, canvasAspectRatio) {
  const heading = CURTAIN_PRODUCT_STYLES[style];
  const canvasDescription = canvasAspectRatio === "1:1" ? "1:1 方形" : `${canvasAspectRatio} 画幅`;
  return `任务类型：${heading.label}纯白背景窗帘成品图生成。只输出最终图片，不输出分析。

输入图职责不可互换：纯白只属于输出背景，不属于窗帘面料。Image 1 是${heading.label}构图模板，只控制完整一套中间对开的双片窗帘、${heading.label}帘头、外部轮廓、留白和从帘头到帘尾连续规整的褶皱几何；最终画布比例严格使用本次请求的 ${canvasDescription}，Image 1 不提供面料外观。Image 2 是当前 SKU 的平展、均匀受光面料扫描图，是颜色、花纹、织法、肌理和材质的唯一依据；必须完整保留 Image 2 的综合色相、色相、饱和度、明度关系和材质，Image 2 中任何深浅色都不是阴影、孔洞或折痕。

只生成一套完整的${heading.label}窗帘：左右两片在中间对开，帘头样式必须完全固定为${heading.label}，左右片不得使用不同帘头。不得改变 Image 1 的镜头、比例、构图边界、轮廓或留白。输出必须为 ${canvasDescription}、纯白、均匀、无纹理、无实景的白底产品图；不得出现房间、窗户、窗帘杆、轨道、家具、道具、文字、水印、尺寸线或边框。

清晰度硬性规则：整幅产品图必须全区域清晰对焦，帘头、孔位或褶位、褶峰、褶谷、底边、面料纹理和图案均须清楚可见。禁止景深效果、浅景深、背景虚化、局部散焦、镜头模糊或 bokeh。

物理尺寸只用于花回计算，不改变 Image 1 的画面比例。整套闭合成品宽 330 cm，高 270 cm；左右片成品宽各 165 cm，2 倍褶皱后每片展开布料按 330 × 270 cm 计算花回，两片展开总布宽 660 cm。必须有约 30 cm 的中间开口；开口没有面料，不计入花回。

先在一整卷连续平展面料上建立一次花纹，再从不同连续坐标裁出左右片，最后按 Image 1 形成褶皱。禁止复制、镜像或轴对称左右整片，禁止机械平铺或逐褶复制。

褶皱只采用 Image 1 的几何、明暗和阴影：每道褶峰和褶谷必须从帘头到帘尾一一连续，间距、宽度和振幅稳定，不得分叉、合并、变宽、变窄、消失或增生。Image 2 的花纹形状、方向、角点、直线、曲线和长宽比例是硬约束，不得把直线改成曲线。只有褶峰、褶谷和遮挡边缘可产生由模板引起的连续横向压缩与局部遮挡；花纹自身不能因褶皱而产生额外的弯曲、旋转、波浪、漂移或纵向位移。高光、半影和深影只能调制面料明暗；进入褶谷的部分随模板阴影逐渐变暗并被遮挡，不得用平面图案覆盖褶皱。`;
}

function formatCount(value) {
  if (!Number.isFinite(value)) return "未知";
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function manualRuntimeParameters({
  style,
  canvasAspectRatio,
  fabricMode,
  fabricMetadata,
  scale,
}) {
  const heading = CURTAIN_PRODUCT_STYLES[style];
  const canvasDescription = canvasAspectRatio === "1:1" ? "1:1 方形" : `${canvasAspectRatio} 画幅`;
  const sampleSize = fabricMetadata.sampleSizeCm;
  const composition = fabricMetadata.composition || "CSV 未提供";
  const base = `【最高优先级硬参数——必须先执行再理解其余正文】
本次 SKU：${fabricMetadata.sku || "未知"}；已知成分标签：${composition}。成分只是辅助标签，实际颜色、织法和材质仍以 Image 2 的可见证据为准。
帘头样式：${heading.label}；输出画幅：${canvasDescription}。
整套闭合成品宽 330 cm、高 270 cm；左右片成品宽各 165 cm。2 倍褶皱后，每片连续平展布料为 330 cm × 270 cm，两片连续平展总布宽 660 cm；中间开口约 30 cm且没有面料。
Image 2 完整图片覆盖真实面料 ${sampleSize} cm × ${sampleSize} cm，这不是花位循环尺寸，也不是只在成品出现一次的贴图。
纵向真实密度链路：270 ÷ ${sampleSize} = ${formatCount(scale.sampleSpanVertical)}，因此成品高度必须容纳约 ${formatCount(scale.sampleSpanVertical)} 个“Image 2 整张实拍范围”的物理跨度。
每片展开横向密度链路：330 ÷ ${sampleSize} = ${formatCount(scale.sampleSpanHorizontalPerPanel)}，因此每片展开布宽必须容纳约 ${formatCount(scale.sampleSpanHorizontalPerPanel)} 个实拍范围跨度。
两片总展开横向密度链路：660 ÷ ${sampleSize} = ${formatCount(scale.sampleSpanHorizontalTotal)}，因此两片总展开布宽必须容纳约 ${formatCount(scale.sampleSpanHorizontalTotal)} 个实拍范围跨度。
上述样本跨度只锁定 Image 2 中颜色、纱线、织法、颗粒和微观纹理的真实单位密度；不得把整张 Image 2 机械平铺，也不得把样本跨度误当成完整花位循环。`;

  if (fabricMode !== "repeat") {
    return `${base}
本次 CSV 判定为无独立花位：只使用 Image 1 和 Image 2。不得凭空新增花位或中频图案；即使全景无法逐根看清纱线，也必须保留微观纹理的综合色差、孔隙贡献、粗糙度和织造方向，不得磨平为普通素布。`;
  }

  const vertical = fabricMetadata.repeatVerticalCm;
  const horizontal = fabricMetadata.repeatHorizontalCm;
  return `${base}
本次 CSV 判定为有花位，必须同时使用 Image 3。Image 3 只提供完整花位结构；Image 2 的颜色和材质优先，Image 3 的颜色不得带入最终成品。
纵向花位 ${vertical} cm：270 ÷ ${vertical} = ${formatCount(scale.repeatCountVertical)}，成品高度必须对应约 ${formatCount(scale.repeatCountVertical)} 个完整花位循环（包含边缘裁切的部分循环）。
横向花位 ${horizontal} cm：每片 330 ÷ ${horizontal} = ${formatCount(scale.repeatCountHorizontalPerPanel)}，两片总展开 660 ÷ ${horizontal} = ${formatCount(scale.repeatCountHorizontalTotal)}。
花位循环数量与 Image 2 实拍范围跨度是两套独立尺度，禁止合并、替换或用其中一个推导另一个。`;
}

export function buildCurtainProductPrompt({
  headingStyle = "grommet",
  extraPrompt = "",
  patternRepeatVerticalCm = null,
  patternRepeatHorizontalCm = null,
  fabricSampleSizeCm = null,
  canvasAspectRatio = "1:1",
  fixedPrompt = "",
  fabricMode = null,
  fabricMetadata = null,
  scale = null,
} = {}) {
  const style = normalizeCurtainProductStyle(headingStyle);
  const metadata = fabricMetadata || {
    sku: "",
    sampleSizeCm: Number(fabricSampleSizeCm),
    fabricMode: fabricMode || "plain",
    composition: "",
    repeatVerticalCm: patternRepeatVerticalCm,
    repeatHorizontalCm: patternRepeatHorizontalCm,
  };
  const resolvedFabricMode = fabricMode || metadata.fabricMode || null;
  const sampleSize = Number(metadata.sampleSizeCm ?? fabricSampleSizeCm);
  const isManualProduct = Boolean(resolvedFabricMode) || (Number.isFinite(sampleSize) && sampleSize > 0);
  const scalePrompt = isManualProduct ? "" : buildPatternScalePrompt({
    verticalCm: patternRepeatVerticalCm,
    horizontalCm: patternRepeatHorizontalCm,
    sourceImageLabel: "Image 2",
    curtainDimensions: CURTAIN_PRODUCT,
    horizontalCalculationWidthCm: CURTAIN_PRODUCT.finishedWidthCm,
  });
  const editableFixedPrompt = String(fixedPrompt || "").trim();
  let sections;
  if (isManualProduct) {
    const mode = resolvedFabricMode === "repeat" ? "repeat" : "plain";
    const resolvedMetadata = { ...metadata, sampleSizeCm: sampleSize, fabricMode: mode };
    const resolvedScale = scale || calculateManualProductScale(resolvedMetadata);
    const defaultPrompt = mode === "repeat"
      ? MANUAL_CURTAIN_PRODUCT_REPEAT_PROMPT
      : MANUAL_CURTAIN_PRODUCT_PLAIN_PROMPT;
    sections = [
      manualRuntimeParameters({
        style,
        canvasAspectRatio,
        fabricMode: mode,
        fabricMetadata: resolvedMetadata,
        scale: resolvedScale,
      }),
      editableFixedPrompt || defaultPrompt,
    ];
  } else {
    sections = [productPromptFor(style, canvasAspectRatio), scalePrompt].filter(Boolean);
  }
  const extra = String(extraPrompt || "").trim();

  if (extra) {
    sections.push(`额外提示词只在不与以上固定要求冲突时生效；如有冲突，必须忽略冲突部分并以以上固定要求为准。\n补充要求：\n${extra}`);
  }

  return sections.join("\n\n");
}
