import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProcessedAtRangeQuery,
  isOrderWithinDateRange,
} from "../app/services/financeDateRange.js";

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
