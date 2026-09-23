import {
  clampPreviewTransform,
  createPreviewTransform,
  dragPreview,
  resetPreviewTransform,
  transformStyle,
  zoomPreview,
} from "./previewZoom.js";

export function createPreviewViewerController({
  dialog,
  viewport,
  image,
  closeButton,
  windowTarget,
  titleElement = null,
  formatTitle = ({ name }) => name || "",
}) {
  const listeners = [];
  let transform = createPreviewTransform();
  let drag = null;
  let destroyed = false;

  const listen = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    listeners.push({ target, type, listener, options });
  };

  const dimensions = () => ({
    viewerWidth: viewport.clientWidth,
    viewerHeight: viewport.clientHeight,
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
  });

  const apply = () => {
    image.style.transform = transformStyle(transform);
    viewport.classList.toggle("zoomed", transform.scale > 1);
  };

  const clamp = () => {
    transform = clampPreviewTransform(transform, dimensions());
    apply();
  };

  const releasePointer = (pointerId) => {
    if (pointerId === undefined || typeof viewport.releasePointerCapture !== "function") return;
    try {
      if (typeof viewport.hasPointerCapture !== "function" || viewport.hasPointerCapture(pointerId)) {
        viewport.releasePointerCapture(pointerId);
      }
    } catch {
      // Pointer capture may already be released when the pointer leaves the document.
    }
  };

  const stopDrag = (pointerId = drag?.pointerId) => {
    releasePointer(pointerId);
    drag = null;
    viewport.classList.remove("dragging");
  };

  const reset = () => {
    stopDrag();
    transform = resetPreviewTransform();
    apply();
  };

  const close = () => {
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    else reset();
  };

  const handleWheel = (event) => {
    event.preventDefault();
    transform = clampPreviewTransform(zoomPreview(transform, event.deltaY), dimensions());
    apply();
  };

  const handlePointerDown = (event) => {
    if (transform.scale <= 1 || drag) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    if (typeof viewport.setPointerCapture === "function") {
      try {
        viewport.setPointerCapture(event.pointerId);
      } catch {
        // Capture is optional for synthetic or already-ended pointers.
      }
    }
    viewport.classList.add("dragging");
  };

  const handlePointerMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    transform = clampPreviewTransform(
      dragPreview(transform, event.clientX - drag.x, event.clientY - drag.y),
      dimensions(),
    );
    drag = { pointerId: drag.pointerId, x: event.clientX, y: event.clientY };
    apply();
  };

  const handlePointerEnd = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    stopDrag(event.pointerId);
  };

  const handleBackdropClick = (event) => {
    if (event.target === dialog) close();
  };

  listen(image, "load", clamp);
  listen(viewport, "wheel", handleWheel, { passive: false });
  listen(viewport, "pointerdown", handlePointerDown);
  listen(viewport, "pointermove", handlePointerMove);
  listen(viewport, "pointerup", handlePointerEnd);
  listen(viewport, "pointercancel", handlePointerEnd);
  listen(windowTarget, "resize", clamp);
  listen(dialog, "close", reset);
  listen(dialog, "click", handleBackdropClick);
  listen(closeButton, "click", close);
  apply();

  return {
    open(payload) {
      if (destroyed || !payload?.src) return false;
      reset();
      const name = payload.name || "";
      if (titleElement) titleElement.textContent = formatTitle(payload);
      image.alt = name;
      image.src = payload.src;
      if (!dialog.open) dialog.showModal();
      return true;
    },
    close,
    reset,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const { target, type, listener, options } of listeners) {
        target.removeEventListener(type, listener, options);
      }
      listeners.length = 0;
      reset();
    },
  };
}
