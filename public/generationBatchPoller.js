const DEFAULT_POLL_INTERVAL_MS = 3000;
const MAX_STATUS_JOBS = 20;

export function createGenerationBatchPoller({
  fetchImpl = fetch,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const batches = new Map();

  function waitFor(batchId, jobId, onStatus = () => {}) {
    let batch = batches.get(batchId);
    if (!batch) {
      batch = { waiters: new Map(), started: false };
      batches.set(batchId, batch);
    }

    const result = new Promise((resolve, reject) => {
      batch.waiters.set(jobId, { resolve, reject, onStatus });
    });
    if (!batch.started) {
      batch.started = true;
      queueMicrotask(() => runBatch(batchId, batch));
    }
    return result;
  }

  async function runBatch(batchId, batch) {
    try {
      while (batch.waiters.size) {
        const jobIds = [...batch.waiters.keys()];
        for (let offset = 0; offset < jobIds.length; offset += MAX_STATUS_JOBS) {
          const chunk = jobIds.slice(offset, offset + MAX_STATUS_JOBS);
          const response = await fetchImpl(`/api/generation-batches/${encodeURIComponent(batchId)}/status`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jobIds: chunk }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "查询生成状态失败");

          for (const job of data.jobs || []) {
            const waiter = batch.waiters.get(job.id);
            if (!waiter) continue;
            waiter.onStatus(job.status, job.id);
            if (job.status === "done") {
              batch.waiters.delete(job.id);
              waiter.resolve(job.result || {});
            } else if (job.status === "error") {
              batch.waiters.delete(job.id);
              waiter.reject(new Error(job.error || "生成失败"));
            }
          }
        }
        if (batch.waiters.size) await sleep(pollIntervalMs);
      }
    } catch (error) {
      for (const waiter of batch.waiters.values()) waiter.reject(error);
      batch.waiters.clear();
    } finally {
      if (batches.get(batchId) === batch) batches.delete(batchId);
    }
  }

  return { waitFor };
}
