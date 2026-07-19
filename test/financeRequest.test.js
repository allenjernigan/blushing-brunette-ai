import test from "node:test";
import assert from "node:assert/strict";

import { getFinanceDateRange } from "../app/services/financeDateRange.js";
import {
  getFinanceRevalidationAction,
  parseFinanceRequestUrl,
} from "../app/services/financeRequest.js";

test("parameterless Finance data requests default to today", () => {
  assert.deepEqual(
    parseFinanceRequestUrl("https://example.com/app/finance.data"),
    {
      selectedPeriod: "today",
      customStart: "",
      customEnd: "",
      requestedChannels: null,
    },
  );
});

test("parses one-day and multi-day custom Finance requests", () => {
  const oneDay = parseFinanceRequestUrl(
    "https://example.com/app/finance.data?period=custom&start=2026-07-15&end=2026-07-15",
  );
  assert.equal(oneDay.selectedPeriod, "custom");
  assert.equal(oneDay.customStart, "2026-07-15");
  assert.equal(oneDay.customEnd, "2026-07-15");

  const multipleDays = parseFinanceRequestUrl(
    "https://example.com/app/finance.data?period=custom&start=2026-07-14&end=2026-07-15",
  );
  assert.equal(multipleDays.customStart, "2026-07-14");
  assert.equal(multipleDays.customEnd, "2026-07-15");
});

test("keeps malformed custom requests invalid", () => {
  for (const requestUrl of [
    "https://example.com/app/finance.data?period=custom&end=2026-07-15",
    "https://example.com/app/finance.data?period=custom&start=2026-07-15",
  ]) {
    const request = parseFinanceRequestUrl(requestUrl);

    assert.equal(request.selectedPeriod, "custom");
    assert.throws(() =>
      getFinanceDateRange({
        periodKey: request.selectedPeriod,
        timezone: "America/Chicago",
        customStart: request.customStart,
        customEnd: request.customEnd,
      }),
    );
  }
});

test("preserves every channel during custom-date revalidation", () => {
  const location = {
    pathname: "/app/finance",
    search:
      "?period=custom&start=2026-07-15&end=2026-07-15&channel=Online+Store&channel=Facebook+%26+Instagram",
  };
  const action = getFinanceRevalidationAction(location);
  const request = parseFinanceRequestUrl(`https://example.com${action}`);

  assert.equal(action, `${location.pathname}${location.search}`);
  assert.deepEqual(request.requestedChannels, [
    "Online Store",
    "Facebook & Instagram",
  ]);
});
