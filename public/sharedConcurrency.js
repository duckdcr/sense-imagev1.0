import { normalizeConcurrency } from "./concurrency.js";

export const DEFAULT_SHARED_CONCURRENCY = 97;
export const SHARED_CONCURRENCY_KEY = "sence-image-shared-concurrency-v1";
export const SHARED_CONCURRENCY_EVENT = "sence-image:concurrency-changed";

export function readSharedConcurrency(storage = globalThis.localStorage) {
  const saved = storage?.getItem(SHARED_CONCURRENCY_KEY);
  return normalizeConcurrency(saved === "20" ? DEFAULT_SHARED_CONCURRENCY : saved ?? DEFAULT_SHARED_CONCURRENCY);
}

export function writeSharedConcurrency(value, storage = globalThis.localStorage) {
  const concurrency = normalizeConcurrency(value);
  storage?.setItem(SHARED_CONCURRENCY_KEY, String(concurrency));
  return concurrency;
}
