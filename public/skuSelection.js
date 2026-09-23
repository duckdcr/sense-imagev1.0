function skuKey(value) {
  return String(value || "").trim().toLowerCase();
}

function copyState(state, changes = {}) {
  return {
    ...state,
    ...changes,
    selected: changes.selected ? new Set(changes.selected) : new Set(state.selected),
  };
}

function filteredJobs(state) {
  if (!state.search) return state.jobs.slice();
  return state.jobs.filter((job) => skuKey(job.factorySku).includes(state.search));
}

export function createSkuSelection(jobs, pageSize = 50) {
  const uniqueJobs = [];
  const selected = new Set();

  for (const job of Array.from(jobs || [])) {
    const key = skuKey(job?.factorySku);
    if (!key || selected.has(key)) continue;
    uniqueJobs.push(job);
    selected.add(key);
  }

  return {
    jobs: uniqueJobs,
    selected,
    search: "",
    page: 1,
    pageSize: Math.max(1, Math.trunc(Number(pageSize)) || 50),
  };
}

export function setSkuSearch(state, query) {
  return copyState(state, {
    search: String(query || "").trim().toLowerCase(),
    page: 1,
  });
}

export function skuSelectionPage(state) {
  const matches = filteredJobs(state);
  const totalPages = Math.max(1, Math.ceil(matches.length / state.pageSize));
  const currentPage = Math.min(totalPages, Math.max(1, Math.trunc(Number(state.page)) || 1));
  const start = (currentPage - 1) * state.pageSize;

  return {
    filteredJobs: matches,
    currentPage,
    totalPages,
    pageItems: matches.slice(start, start + state.pageSize),
    pageSize: state.pageSize,
  };
}

export function setSkuSelectionPage(state, page) {
  const matches = filteredJobs(state);
  const totalPages = Math.max(1, Math.ceil(matches.length / state.pageSize));
  const requestedPage = Math.trunc(Number(page)) || 1;
  return copyState(state, {
    page: Math.min(totalPages, Math.max(1, requestedPage)),
  });
}

export function toggleSkuSelection(state, sku, selected) {
  const key = skuKey(sku);
  const known = state.jobs.some((job) => skuKey(job.factorySku) === key);
  const nextSelected = new Set(state.selected);

  if (known && selected) nextSelected.add(key);
  else if (known) nextSelected.delete(key);

  return copyState(state, { selected: nextSelected });
}

function setJobsSelected(state, jobs, selected) {
  const nextSelected = new Set(state.selected);
  for (const job of jobs) {
    const key = skuKey(job.factorySku);
    if (selected) nextSelected.add(key);
    else nextSelected.delete(key);
  }
  return copyState(state, { selected: nextSelected });
}

export function setCurrentSkuPageSelected(state, selected) {
  return setJobsSelected(state, skuSelectionPage(state).pageItems, selected);
}

export function setAllFilteredSkuSelected(state, selected) {
  return setJobsSelected(state, filteredJobs(state), selected);
}

export function selectedSkuJobs(state) {
  return state.jobs.filter((job) => state.selected.has(skuKey(job.factorySku)));
}

export function selectedSkuCount(state) {
  return selectedSkuJobs(state).length;
}

export function filteredSelectedSkuCount(state) {
  return filteredJobs(state).filter((job) => state.selected.has(skuKey(job.factorySku))).length;
}

export function skuSelectionCounts(state) {
  const view = skuSelectionPage(state);
  return {
    total: state.jobs.length,
    selected: selectedSkuCount(state),
    filtered: view.filteredJobs.length,
    filteredSelected: view.filteredJobs.filter((job) => state.selected.has(skuKey(job.factorySku))).length,
    currentPageItems: view.pageItems.length,
    currentPageSelected: view.pageItems.filter((job) => state.selected.has(skuKey(job.factorySku))).length,
  };
}
