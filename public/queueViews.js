export function partitionQueueRows(rows) {
  const active = [];
  const completed = [];

  for (const row of rows) {
    if (row.status === "done") completed.push(row);
    else active.push(row);
  }

  return { active, completed };
}

export function runnableQueueRows(rows) {
  return rows.filter((row) => row.status === "pending" || row.status === "error");
}

export function pageCapacityForHeight(height, rowHeight = 92, gap = 8) {
  const availableHeight = Math.max(0, Number(height) || 0);
  const stableRowHeight = Math.max(1, Number(rowHeight) || 92);
  const stableGap = Math.max(0, Number(gap) || 0);
  return Math.max(1, Math.floor((availableHeight + stableGap) / (stableRowHeight + stableGap)));
}

export function paginateRows(rows, page, pageSize) {
  const stablePageSize = Math.max(1, Math.trunc(Number(pageSize)) || 1);
  const totalPages = Math.max(1, Math.ceil(rows.length / stablePageSize));
  const currentPage = Math.min(totalPages, Math.max(1, Math.trunc(Number(page)) || 1));
  const start = (currentPage - 1) * stablePageSize;
  return {
    rows: rows.slice(start, start + stablePageSize),
    currentPage,
    totalPages,
  };
}
