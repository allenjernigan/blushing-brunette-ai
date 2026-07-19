import { DateTime } from "luxon";

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

function parseStoreDate(value, timezone, fieldLabel) {
  if (!value) {
    throw new FinanceDateRangeError(
      `Choose a ${fieldLabel.toLowerCase()}.`,
    );
  }

  const date = DateTime.fromISO(value, { zone: timezone });

  if (!date.isValid || date.toFormat("yyyy-MM-dd") !== value) {
    throw new FinanceDateRangeError(
      `Enter a valid ${fieldLabel.toLowerCase()}.`,
    );
  }

  return date.startOf("day");
}

export function getFinanceDateRange({
  periodKey,
  timezone,
  customStart,
  customEnd,
  now = DateTime.now(),
}) {
  const storeNow = DateTime.isDateTime(now)
    ? now.setZone(timezone)
    : DateTime.fromISO(now, { setZone: true }).setZone(timezone);

  if (!storeNow.isValid) {
    throw new FinanceDateRangeError("Unable to determine the current date.");
  }

  let start;
  let end;
  let label;
  let shopifyqlStartDate;
  let shopifyqlEndDate;

  switch (periodKey) {
    case "today":
      start = storeNow.startOf("day");
      end = storeNow;
      label = `Today — ${storeNow.toFormat("MMMM d, yyyy")}`;
      break;
    case "yesterday": {
      const yesterday = storeNow.minus({ days: 1 }).startOf("day");
      start = yesterday;
      end = yesterday.plus({ days: 1 });
      label = `Yesterday — ${yesterday.toFormat("MMMM d, yyyy")}`;
      break;
    }
    case "last-7-days":
      start = storeNow.startOf("day").minus({ days: 6 });
      end = storeNow;
      label = `Last 7 Days — ${start.toFormat("MMM d")}–${storeNow.toFormat("MMM d, yyyy")}`;
      break;
    case "month-to-date":
      start = storeNow.startOf("month");
      end = storeNow;
      label = `Month to Date — ${storeNow.toFormat("MMMM yyyy")}`;
      break;
    case "last-month": {
      const lastMonth = storeNow.minus({ months: 1 });
      start = lastMonth.startOf("month");
      end = storeNow.startOf("month");
      label = lastMonth.toFormat("MMMM yyyy");
      break;
    }
    case "custom": {
      start = parseStoreDate(customStart, timezone, "Start date");
      const visibleEnd = parseStoreDate(
        customEnd,
        timezone,
        "End date",
      );

      if (start > visibleEnd) {
        throw new FinanceDateRangeError(
          "Start date must be on or before end date.",
        );
      }

      shopifyqlStartDate = customStart;
      shopifyqlEndDate = customEnd;
      end = visibleEnd.endOf("day").plus({ milliseconds: 1 });
      label = `${start.toFormat("MMMM d, yyyy")}–${visibleEnd.toFormat("MMMM d, yyyy")}`;
      break;
    }
    default:
      throw new FinanceDateRangeError("Choose a valid reporting period.");
  }

  return {
    key: periodKey,
    label,
    start: start.toUTC().toISO(),
    end: end.toUTC().toISO(),
    startDate:
      shopifyqlStartDate || start.toFormat("yyyy-MM-dd"),
    endDate:
      shopifyqlEndDate ||
      end.minus({ milliseconds: 1 }).toFormat("yyyy-MM-dd"),
  };
}
export const FINANCE_PERIODS = [
  "today",
  "yesterday",
  "last-7-days",
  "month-to-date",
  "last-month",
  "custom",
];

export class FinanceDateRangeError extends Error {
  constructor(message) {
    super(message);
    this.name = "FinanceDateRangeError";
  }
}
