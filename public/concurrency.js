export function normalizeConcurrency(value) {
  return Math.max(1, Math.min(100, Math.floor(Number(value) || 1)));
}

export async function runWithConcurrency(items, concurrency, worker) {
  const limit = normalizeConcurrency(concurrency);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runWorker(),
  );

  await Promise.all(workers);
}

export function createGenerationQueue({
  concurrency,
  worker,
  onError = () => {},
  onIdle = () => {},
}) {
  if (typeof worker !== "function") throw new TypeError("worker must be a function");

  let limit = normalizeConcurrency(concurrency);
  const pending = [];
  let active = 0;
  let hasWork = false;
  let idleVersion = 0;
  let paused = false;

  function enqueue(items) {
    const additions = Array.from(items || []);
    if (!additions.length) return;
    pending.push(...additions);
    hasWork = true;
    idleVersion += 1;
    pump();
  }

  function pump() {
    if (paused) return;
    while (active < limit && pending.length) {
      const item = pending.shift();
      active += 1;
      runItem(item);
    }
    scheduleIdle();
  }

  async function runItem(item) {
    try {
      await worker(item);
    } catch (error) {
      try {
        await onError(error, item);
      } catch {
        // Error reporting must not stall the remaining queue.
      }
    } finally {
      active -= 1;
      pump();
    }
  }

  function scheduleIdle() {
    if (!hasWork || active || pending.length) return;
    const version = ++idleVersion;
    queueMicrotask(() => {
      if (version !== idleVersion || active || pending.length || !hasWork) return;
      hasWork = false;
      onIdle();
    });
  }

  function pause() {
    paused = true;
    idleVersion += 1;
    return pending.slice();
  }

  function resume() {
    if (!paused) return;
    paused = false;
    idleVersion += 1;
    pump();
  }

  function setConcurrency(value) {
    limit = normalizeConcurrency(value);
    idleVersion += 1;
    pump();
    return limit;
  }

  return {
    enqueue,
    pause,
    resume,
    setConcurrency,
    snapshot: () => ({ active, pending: pending.length, paused }),
  };
}
