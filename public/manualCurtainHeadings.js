export const MANUAL_CURTAIN_HEADING_STYLES = ["grommet", "doublePinch"];

export function normalizeManualCurtainHeadingStyles(styles) {
  const selected = new Set(Array.from(styles || []));
  return MANUAL_CURTAIN_HEADING_STYLES.filter((style) => selected.has(style));
}

export function expandManualCurtainRows(files, headingStyles, createRow) {
  const styles = normalizeManualCurtainHeadingStyles(headingStyles);
  return Array.from(files || []).flatMap((file) => styles.map((style) => createRow(file, style)));
}
