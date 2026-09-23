const MIN_SCALE = 1;
const MAX_SCALE = 8;
const ZOOM_FACTOR = 1.24;

export function createPreviewTransform() {
  return { scale: 1, x: 0, y: 0 };
}

export function resetPreviewTransform() {
  return createPreviewTransform();
}

export function zoomPreview(state, deltaY) {
  const direction = deltaY < 0 ? 1 : -1;
  const multiplier = direction > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
  const scale = clampScale(state.scale * multiplier);

  if (scale === MIN_SCALE) {
    return createPreviewTransform();
  }

  return {
    ...state,
    scale,
  };
}

export function dragPreview(state, deltaX, deltaY) {
  if (state.scale <= MIN_SCALE) {
    return createPreviewTransform();
  }

  return {
    ...state,
    x: state.x + deltaX,
    y: state.y + deltaY,
  };
}

export function clampPreviewTransform(state, dimensions = {}) {
  if (state.scale <= MIN_SCALE) return createPreviewTransform();

  const viewerWidth = positiveDimension(dimensions.viewerWidth);
  const viewerHeight = positiveDimension(dimensions.viewerHeight);
  const imageWidth = positiveDimension(dimensions.imageWidth);
  const imageHeight = positiveDimension(dimensions.imageHeight);
  if (!viewerWidth || !viewerHeight || !imageWidth || !imageHeight) return state;

  const containScale = Math.min(viewerWidth / imageWidth, viewerHeight / imageHeight);
  const scaledWidth = imageWidth * containScale * state.scale;
  const scaledHeight = imageHeight * containScale * state.scale;
  const maxX = Math.max(0, (scaledWidth - viewerWidth) / 2);
  const maxY = Math.max(0, (scaledHeight - viewerHeight) / 2);

  return {
    ...state,
    x: maxX ? round(clamp(state.x, -maxX, maxX)) : 0,
    y: maxY ? round(clamp(state.y, -maxY, maxY)) : 0,
  };
}

export function transformStyle(state) {
  return `translate(${round(state.x)}px, ${round(state.y)}px) scale(${round(state.scale)})`;
}

function clampScale(value) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, round(value)));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function positiveDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
