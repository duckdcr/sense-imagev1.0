export function isHeicFile(file) {
  return /image\/hei[cf]/i.test(String(file?.type || "")) || /\.hei[cf]$/i.test(String(file?.name || ""));
}

export function nativePreviewUrl(file) {
  return URL.createObjectURL(file);
}

export async function previewUrlForFile(file) {
  if (!isHeicFile(file)) return nativePreviewUrl(file);
  const dataUrl = await fileToDataUrl(file);
  const response = await fetch("/api/image-preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: { name: file.name, type: file.type, dataUrl } }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.dataUrl) throw new Error(data.error || "HEIC 图片预览转换失败");
  return data.dataUrl;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("读取图片失败")));
    reader.readAsDataURL(file);
  });
}
