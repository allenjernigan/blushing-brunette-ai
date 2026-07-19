function quoteSearchTimestamp(timestamp) {
  const escapedTimestamp = String(timestamp)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'");

  return `'${escapedTimestamp}'`;
}

export function buildProcessedAtRangeQuery(start, end) {
  return [
    `processed_at:>=${quoteSearchTimestamp(start)}`,
    `processed_at:<${quoteSearchTimestamp(end)}`,
  ].join(" ");
}

export function isOrderWithinDateRange(order, start, end) {
  const processedAt = Date.parse(order?.processedAt);
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);

  return (
    Number.isFinite(processedAt) &&
    Number.isFinite(startTime) &&
    Number.isFinite(endTime) &&
    processedAt >= startTime &&
    processedAt < endTime
  );
}
