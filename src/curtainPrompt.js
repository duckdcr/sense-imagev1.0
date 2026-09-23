import { STANDARD_CURTAIN, buildPatternScalePrompt } from "./patternScale.js";

const BASE_PROMPT = `任务类型：严格的窗帘材质替换。只输出最终图片，不输出分析、文字、尺寸标记、水印或边框。

输入图说明：
- Image 1 是系列场景图。它是构图、窗帘区域、窗帘三维形状、褶皱、透视、遮挡、光照和背景的唯一依据。
- Image 2 是当前 SKU 的面料细节图。它是窗帘颜色、印花、肌理、织法和材质细节的唯一依据。

只替换 Image 1 中全部属于窗帘系统的布料表面，包括主窗帘、左右侧窗帘、褶皱深处、阴影区域、窗帘边缘、被家具或物体遮挡的部分，以及与窗帘同材质、同颜色、同纹理连续的布料。凡是垂落或铺展到桌面、地面、家具表面、物体下方、画面边缘，或者只露出一小部分的连续窗帘布，都必须纳入同一个替换区域。保持杯子、摆件等前景物体及其遮挡边界不变，但物体下方实际属于窗帘的布料仍要完整替换。全部目标区域不得残留原窗帘的颜色、纹理或材质。

严格锁定 Image 1：除上述目标布料的表面材质外，所有非窗帘像素必须保持不变。不得改变房间、窗户、窗外景色、墙面、地面、家具、摆件、窗帘杆、相机位置、构图、裁切、窗帘轮廓、开合状态、长度、褶皱位置和垂坠状态；不得改变全局灯光、原有投影、接触阴影、曝光、白平衡和景深。不得新增物体，不得删除物体，不得移动或重绘非窗帘内容。

清晰度硬性规则：整张图片必须全画面清晰对焦，从前景到背景、窗帘、窗户、家具和所有场景细节均须清楚可见。禁止景深效果、浅景深、背景虚化、前景虚化、局部散焦、镜头模糊或 bokeh。

将每片窗帘视为一整块连续且具有厚度的三维布料。先按规定尺度把 Image 2 的面料铺到平整布料上，再将整块布料包覆到原窗帘三维表面。禁止针对每道褶皱单独重复、缩放或拼接图案。

准确保留 Image 2 的颜色、图案结构、细纹、织物颗粒、方向和深浅比例，并保持其原始饱和度、亮度与颜色关系。尤其要可识别地保留大色块的位置关系、斜向角度、棋盘格、细条纹、细横纹、线条疏密和透明叠色层次。不得重新设计、简化、镜像、改色，或生成相似但不同的花型。左右窗帘使用完全相同的物理尺度，但从连续面料的不同位置自然裁剪，不做镜像。

完整继承原窗帘由三维褶皱产生的相对明暗结构：褶峰有柔和高光，褶面有连续渐变，褶谷有自然深阴影和环境遮挡。新面料必须在原场景光线下重新呈现这些层次，不能抹平褶皱，禁止用等宽、等间距的黑色竖条代替褶皱。

图案经过褶峰时沿凸面自然展开；进入褶谷时沿水平方向连续压缩、弯入阴影并部分隐藏；离开褶谷后再自然展开。同一条线、色块边缘和纹理必须连续穿过相邻褶皱，不能笔直跨过褶谷，也不能被切成独立竖条。

最终效果必须像该 SKU 的真实面料被裁剪、缝制成窗帘后，在原房间中拍摄的商品效果图。保持照片级真实感。`;

const SCENE_SCALE_PREFACE = `场景尺度映射：将 Image 1 的现有窗帘系统映射为标准成品包络：成品总宽 ${STANDARD_CURTAIN.finishedWidthCm} cm、成品总高 ${STANDARD_CURTAIN.finishedHeightCm} cm、等效展开总布宽 ${STANDARD_CURTAIN.flatWidthCm} cm。此映射仅用于约束图案密度，不得改变 Image 1 中窗帘或任何场景内容的几何形状、比例、轮廓、褶皱、位置和透视。
相同的 Image 1 与相同的纵向和横向花回值必须得到相同的图案像素密度。SKU 的颜色、亮度、源细节图裁切和图案复杂度不得触发任何重新缩放或密度变化。
必须先在 ${STANDARD_CURTAIN.flatWidthCm} cm 宽的连续平整布料上按物理尺度排列完整图案，再将这块连续布料包覆到 Image 1 的原始三维窗帘表面。`;

export function buildCurtainReplacementPrompt({
  extraPrompt = "",
  patternRepeatVerticalCm = null,
  patternRepeatHorizontalCm = null,
} = {}) {
  const scalePrompt = buildPatternScalePrompt({
    verticalCm: patternRepeatVerticalCm,
    horizontalCm: patternRepeatHorizontalCm,
  });
  const sections = [BASE_PROMPT, SCENE_SCALE_PREFACE, scalePrompt];
  const extra = String(extraPrompt || "").trim();

  if (extra) {
    sections.push(`补充要求仅在不与以上固定要求冲突时适用；如有冲突，必须忽略冲突部分并以以上固定要求为准。\n补充要求：\n${extra}`);
  }

  return sections.join("\n\n");
}
