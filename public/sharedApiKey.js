export const SHARED_API_KEY_KEY = "sence-image-api-keys";

export function readSharedApiKey(storage = globalThis.localStorage, legacyStorage = globalThis.sessionStorage) {
  const value = storage?.getItem(SHARED_API_KEY_KEY);
  if (value !== null && value !== undefined) return String(value).trim();
  return String(legacyStorage?.getItem(SHARED_API_KEY_KEY) || "").trim();
}

export function writeSharedApiKey(value, storage = globalThis.localStorage) {
  const apiKey = String(value || "").trim();
  storage?.setItem(SHARED_API_KEY_KEY, apiKey);
  return apiKey;
}
