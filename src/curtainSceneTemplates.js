export const RANDOM_CURTAIN_SCENE_TEMPLATE_ID = "random";

export const CURTAIN_SCENE_TEMPLATES = Object.freeze([
  { id: "scene-1", label: "场景 1", fileName: "scene-1.png" },
  { id: "scene-2", label: "场景 2", fileName: "scene-2.png" },
  { id: "scene-3", label: "场景 3", fileName: "scene-3.png" },
  { id: "scene-4", label: "场景 4", fileName: "scene-4.png" },
  { id: "scene-5", label: "场景 5", fileName: "scene-5.png" },
]);

const templatesById = new Map(CURTAIN_SCENE_TEMPLATES.map((template) => [template.id, template]));

export function normalizeCurtainSceneTemplateId(value) {
  const id = String(value || "").trim();
  if (!templatesById.has(id)) throw new TypeError("Unsupported curtain scene template.");
  return id;
}

export function curtainSceneTemplateById(value) {
  return templatesById.get(normalizeCurtainSceneTemplateId(value));
}
