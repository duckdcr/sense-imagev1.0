export function createLatestSceneLoader(readFile) {
  let latestRequest = 0;

  return async function loadScene(file) {
    const requestId = ++latestRequest;
    if (!file) return { current: true, file: null, dataUrl: "" };

    try {
      const dataUrl = await readFile(file);
      return { current: requestId === latestRequest, file, dataUrl };
    } catch (error) {
      return { current: requestId === latestRequest, file, dataUrl: "", error };
    }
  };
}

export function prepareRowsForSceneChange(rows) {
  const currentRows = Array.from(rows || []);
  const retained = currentRows.filter((row) => row.status !== "done");
  for (const row of retained) {
    row.imageDataUrl = "";
    row.sceneImageUrl = "";
    row.savedFiles = [];
    row.historyEntry = null;
    row.historyError = "";
    row.selected = true;
  }
  return {
    rows: retained,
    removed: currentRows.filter((row) => row.status === "done"),
  };
}
