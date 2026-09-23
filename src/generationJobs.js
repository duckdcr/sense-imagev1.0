import { randomUUID } from "node:crypto";

const MAX_CONCURRENCY = 100;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function createGenerationJobService({
  worker,
  ttlMs = DEFAULT_TTL_MS,
  isConcurrencyLimitError = () => false,
} = {}) {
  if (typeof worker !== "function") throw new TypeError("worker must be a function");

  const batches = new Map();
  const jobs = new Map();
  let concurrency = 97;
  let active = 0;
  let lastScheduledBatchId = "";

  function createBatch(requestedConcurrency) {
    cleanup();
    if (requestedConcurrency !== undefined) setConcurrency(requestedConcurrency);
    const batch = {
      id: randomUUID(),
      active: 0,
      pending: [],
      state: "running",
      updatedAt: Date.now(),
    };
    batches.set(batch.id, batch);
    return publicBatch(batch);
  }

  function enqueue(batchId, payload) {
    cleanup();
    const batch = batches.get(batchId);
    if (!batch) throw new Error("Generation batch not found.");

    const job = {
      id: randomUUID(),
      batchId,
      status: "queued",
      payload,
      result: null,
      error: "",
      concurrencyAtStart: 0,
      updatedAt: Date.now(),
    };
    jobs.set(job.id, job);
    batch.pending.push(job.id);
    batch.updatedAt = job.updatedAt;
    pump();
    return publicJob(job, batch);
  }

  function getJob(jobId) {
    cleanup();
    const job = jobs.get(jobId);
    return job ? publicJob(job, batches.get(job.batchId)) : null;
  }

  function getBatch(batchId) {
    cleanup();
    const batch = batches.get(batchId);
    return batch ? publicBatch(batch) : null;
  }

  function getJobs(batchId, jobIds) {
    cleanup();
    const batch = requireBatch(batchId);
    if (!Array.isArray(jobIds) || jobIds.length > MAX_CONCURRENCY) {
      throw new Error("Generation job IDs are invalid.");
    }
    return jobIds.map((jobId) => {
      const job = jobs.get(jobId);
      if (!job || job.batchId !== batch.id) throw new Error("Generation job not found.");
      return publicJob(job, batch);
    });
  }

  function pause(batchId) {
    cleanup();
    const batch = requireBatch(batchId);
    batch.state = "paused";
    batch.updatedAt = Date.now();
    return publicBatch(batch);
  }

  function resume(batchId) {
    cleanup();
    const batch = requireBatch(batchId);
    batch.state = "running";
    batch.updatedAt = Date.now();
    pump();
    return publicBatch(batch);
  }

  function setConcurrency(value) {
    concurrency = normalizeConcurrency(value);
    pump();
    return globalState();
  }

  function getConcurrency() {
    cleanup();
    return globalState();
  }

  function pump() {
    while (active < concurrency) {
      const batch = nextRunnableBatch();
      if (!batch) return;
      const jobId = batch.pending.shift();
      const job = jobs.get(jobId);
      if (!job) continue;
      active += 1;
      batch.active += 1;
      job.status = "running";
      job.concurrencyAtStart = concurrency;
      job.updatedAt = Date.now();
      void runJob(batch, job);
    }
  }

  function nextRunnableBatch() {
    const runnable = [...batches.values()]
      .filter((batch) => batch.state === "running" && batch.pending.length);
    if (!runnable.length) return null;
    const previousIndex = runnable.findIndex((batch) => batch.id === lastScheduledBatchId);
    const batch = runnable[previousIndex < 0 ? 0 : (previousIndex + 1) % runnable.length];
    lastScheduledBatchId = batch.id;
    return batch;
  }

  async function runJob(batch, job) {
    try {
      job.result = await worker({ ...job.payload, __idempotencyKey: job.id });
      job.status = "done";
    } catch (error) {
      if (isConcurrencyLimitError(error)) {
        const reduction = reduceConcurrencyAfterLimit(job.concurrencyAtStart);
        try {
          job.result = await worker({ ...job.payload, __idempotencyKey: job.id });
          job.status = "done";
        } catch (retryError) {
          job.status = "error";
          job.error = formatConcurrencyRetryError(reduction, retryError);
        }
      } else {
        job.status = "error";
        job.error = error?.message || "Generation failed.";
      }
    } finally {
      job.payload = null;
      job.updatedAt = Date.now();
      active -= 1;
      batch.active -= 1;
      batch.updatedAt = job.updatedAt;
      pump();
    }
  }

  function reduceConcurrencyAfterLimit(observedConcurrency) {
    const before = concurrency;
    if (before < observedConcurrency) {
      return { from: observedConcurrency, to: before, changed: false };
    }
    const next = Math.max(1, Math.ceil(before / 2));
    concurrency = next;
    return { from: before, to: next, changed: next !== before };
  }

  function formatConcurrencyRetryError(reduction, error) {
    const reason = error?.message || "Generation failed.";
    if (reduction.changed) {
      return `上游并发限流，最大并发数已从 ${reduction.from} 自动降至 ${reduction.to} 后重试仍失败：${reason}`;
    }
    if (reduction.to < reduction.from) {
      return `上游并发限流，其他任务已将最大并发数降至 ${reduction.to} 后重试仍失败：${reason}`;
    }
    return `上游并发限流，最大并发数已为 ${reduction.to}，自动重试仍失败：${reason}`;
  }

  function cleanup() {
    const cutoff = Date.now() - ttlMs;
    for (const [jobId, job] of jobs) {
      if ((job.status === "done" || job.status === "error") && job.updatedAt < cutoff) {
        jobs.delete(jobId);
      }
    }
    for (const [batchId, batch] of batches) {
      if (!batch.active && !batch.pending.length && batch.updatedAt < cutoff) {
        batches.delete(batchId);
      }
    }
  }

  function requireBatch(batchId) {
    const batch = batches.get(batchId);
    if (!batch) throw new Error("Generation batch not found.");
    return batch;
  }

  function publicBatch(batch) {
    let done = 0;
    let failed = 0;
    for (const job of jobs.values()) {
      if (job.batchId !== batch.id) continue;
      if (job.status === "done") done += 1;
      if (job.status === "error") failed += 1;
    }
    return {
      id: batch.id,
      concurrency,
      state: batch.state,
      active: batch.active,
      queued: batch.pending.length,
      queuedJobIds: batch.pending.slice(),
      done,
      failed,
    };
  }

  function globalState() {
    let queued = 0;
    for (const batch of batches.values()) queued += batch.pending.length;
    return { concurrency, active, queued };
  }

  return {
    createBatch,
    enqueue,
    getJob,
    getJobs,
    getBatch,
    pause,
    resume,
    setConcurrency,
    getConcurrency,
  };
}

function normalizeConcurrency(value) {
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(Number(value) || 1)));
}

function publicJob(job, batch) {
  return {
    id: job.id,
    batchId: job.batchId,
    status: job.status === "queued" && batch?.state === "paused" ? "paused" : job.status,
    result: job.result,
    error: job.error,
  };
}
