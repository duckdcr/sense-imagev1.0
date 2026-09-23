// Kept for legacy history records created before fixed scene templates.
export const CURTAIN_INSTALLATIONS = Object.freeze({ ceiling: "顶装", wall: "墙装", recess: "窗框内安装" });
export const CURTAIN_LENGTHS = Object.freeze({ floor: "落地", below_sill: "窗台下", sill: "窗台齐" });
export const CURTAIN_OPENINGS = Object.freeze({ center: "左右对开", left: "左单开", right: "右单开", closed: "完全闭合" });
export const CURTAIN_SCENE_MODES = Object.freeze({ empty: "无窗帘场景", with_curtains: "有窗帘场景" });

export const CURTAIN_CREATION_FIXED_PROMPT = `任务：仅替换室内场景现有窗帘的布料表面。只输出最终图片，不输出文字、水印、边框或分析。

Image 1 是内置场景图。它是相机、构图、画面边缘、窗户位置、原有窗帘轮廓、帘头样式、挂法、安装结构、开合方式、长度、褶皱几何、光照、阴影和遮挡关系的唯一依据。必须把 Image 1 作为未改变的完整背景画布输出，保留全部四条画面边缘和原始广角视野。严禁向窗户或窗帘推近镜头，严禁重新取景、裁切、缩放、改变透视或改动房间任何非窗帘内容。

Image 2 是白底成品帘图，只提供面料颜色、花纹、织纹、材质和表面细节。忽略 Image 2 的帘头样式、孔位、捏褶、挂法、布幅轮廓、开合状态和尺寸比例。不得采用 Image 2 的圆孔、捏褶、轨道、挂钩、窗帘杆或安装结构。

只替换 Image 1 中现有窗帘的布料表面；帘头、挂法、杆或轨道、开合状态、布幅数量、边缘位置、长度、褶皱数量和褶皱走向必须完全保持 Image 1 的样子。不得把 Image 2 当成整套窗帘安装，不得新增或删除任何五金、窗帘或建筑结构。先去除 Image 2 的白色背景；不得将整张 Image 2 作为矩形贴到窗前，不得出现白底、边框、商品图阴影或贴图边缘。

面料必须逐项忠实复制 Image 2 的主色与辅色、色相深浅、图案元素、比例、密度、织纹和表面颗粒，不得改色、简化、重绘、发明新纹样或把图案规整成重复贴图。图案、纹理和线条必须随 Image 1 原有褶皱产生真实遮挡和连续压缩：褶峰可见面稍展开，褶谷可见面变窄且更暗；直线在同一块平整布面保持直线，只有跨越真实褶皱时才产生极轻微的连续透视变化，禁止波浪、扭转、螺旋和任意弯曲。

整张图片必须全画面清晰对焦，所有场景细节均清楚可见。禁止景深效果、浅景深、背景虚化、局部散焦、镜头模糊或 bokeh。`;

export function buildCurtainCreationPrompt({ extraPrompt = "", fixedPrompt = "", canvasAspectRatio = "" } = {}) {
  const editableFixedPrompt = String(fixedPrompt || "").trim();
  const prompt = editableFixedPrompt || CURTAIN_CREATION_FIXED_PROMPT;
  const parameters = editableFixedPrompt && canvasAspectRatio
    ? `系统参数（必须执行）：本次输出画幅为 ${canvasAspectRatio}；Image 1 为当前选定内置场景，Image 2 为当前上传的成品帘参考图。`
    : "";
  const extra = String(extraPrompt || "").trim();
  return [prompt, parameters, extra ? `补充要求：\n${extra}` : ""].filter(Boolean).join("\n\n");
}
