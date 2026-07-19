import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routeSource = await readFile(
  new URL("../app/routes/app.finance.jsx", import.meta.url),
  "utf8",
);
const requestSource = await readFile(
  new URL("../app/services/financeRequest.js", import.meta.url),
  "utf8",
);

test("renders every date preset as a visible button", () => {
  for (const label of [
    "Today",
    "Yesterday",
    "Last 7 Days",
    "Month to Date",
    "Last Month",
    "Custom Range",
  ]) {
    assert.match(routeSource, new RegExp(`label: "${label}"`));
  }

  assert.match(routeSource, /PERIODS\.map/);
  assert.match(routeSource, /type="hidden" name="period" value=\{filterPeriod\}/);
});

test("custom date controls submit and retain start and end URL values", () => {
  assert.match(routeSource, /filterPeriod === "custom"/);
  assert.match(routeSource, /name="start" type="date" defaultValue=\{customStart\}/);
  assert.match(routeSource, /name="end" type="date" defaultValue=\{customEnd\}/);
  assert.match(requestSource, /url\.searchParams\.get\("start"\)/);
  assert.match(requestSource, /url\.searchParams\.get\("end"\)/);
});

test("keeps customer shipping revenue separate from estimated shipping expense", () => {
  assert.match(routeSource, /label="Shipping Charges"/);
  assert.match(routeSource, /label="Estimated Shipping Expense"/);
  assert.doesNotMatch(routeSource, /label="Shipping Collected"/);
});
