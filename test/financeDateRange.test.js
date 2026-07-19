import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProcessedAtRangeQuery,
  FinanceDateRangeError,
  getFinanceDateRange,
  isOrderWithinDateRange,
} from "../app/services/financeDateRange.js";
import { DateTime } from "luxon";

const start = "2026-07-18T04:00:00.000Z";
const end = "2026-07-19T04:00:00.000Z";

test("quotes both timestamps in the Shopify processed-at range", () => {
  assert.equal(
    buildProcessedAtRangeQuery(start, end),
    "processed_at:>='2026-07-18T04:00:00.000Z' " +
      "processed_at:<'2026-07-19T04:00:00.000Z'",
  );
});

test("excludes orders at or after the exclusive end boundary", () => {
  assert.equal(
    isOrderWithinDateRange(
      { processedAt: "2026-07-19T03:59:59.999Z" },
      start,
      end,
    ),
    true,
  );
  assert.equal(
    isOrderWithinDateRange(
      { processedAt: "2026-07-19T04:00:00.000Z" },
      start,
      end,
    ),
    false,
  );
  assert.equal(
    isOrderWithinDateRange(
      { processedAt: "2026-07-19T04:12:38.000Z" },
      start,
      end,
    ),
    false,
  );
});

test("builds every preset in the store timezone", () => {
  const now = DateTime.fromISO("2026-07-19T12:30:00", {
    zone: "America/New_York",
  });

  assert.deepEqual(
    getFinanceDateRange({
      periodKey: "last-7-days",
      timezone: "America/New_York",
      now,
    }),
    {
      key: "last-7-days",
      label: "Last 7 Days — Jul 13–Jul 19, 2026",
      start: "2026-07-13T04:00:00.000Z",
      end: "2026-07-19T16:30:00.000Z",
      startDate: "2026-07-13",
      endDate: "2026-07-19",
    },
  );

  const lastMonth = getFinanceDateRange({
    periodKey: "last-month",
    timezone: "America/New_York",
    now: DateTime.fromISO("2026-01-10T10:00:00", {
      zone: "America/New_York",
    }),
  });
  assert.equal(lastMonth.start, "2025-12-01T05:00:00.000Z");
  assert.equal(lastMonth.end, "2026-01-01T05:00:00.000Z");

  const monthToDate = getFinanceDateRange({
    periodKey: "month-to-date",
    timezone: "America/New_York",
    now,
  });
  assert.equal(monthToDate.startDate, "2026-07-01");
  assert.equal(monthToDate.endDate, "2026-07-19");
});

test("treats a custom end date as inclusive across DST", () => {
  const range = getFinanceDateRange({
    periodKey: "custom",
    timezone: "America/New_York",
    customStart: "2026-03-07",
    customEnd: "2026-03-08",
  });

  assert.equal(range.start, "2026-03-07T05:00:00.000Z");
  assert.equal(range.end, "2026-03-09T04:00:00.000Z");
  assert.equal(range.startDate, "2026-03-07");
  assert.equal(range.endDate, "2026-03-08");
});

test("rejects missing, invalid, and reversed custom dates", () => {
  for (const values of [
    { customStart: "", customEnd: "2026-07-19" },
    { customStart: "2026-02-30", customEnd: "2026-03-01" },
    { customStart: "2026-07-20", customEnd: "2026-07-19" },
  ]) {
    assert.throws(
      () =>
        getFinanceDateRange({
          periodKey: "custom",
          timezone: "America/Chicago",
          ...values,
        }),
      FinanceDateRangeError,
    );
  }
});
