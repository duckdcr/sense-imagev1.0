export function parseApiKeys(value) {
  const keys = String(value || "")
    .split(/[\s,]+/)
    .map((key) => key.trim())
    .filter(Boolean);
  const uniqueKeys = [...new Set(keys)];
  return uniqueKeys.length ? uniqueKeys : [""];
}
