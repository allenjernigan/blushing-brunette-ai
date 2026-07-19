import test from "node:test";
import assert from "node:assert/strict";

import { parseShopifyqlResult } from "../app/services/finance.server.js";
import {
  aggregateSalesMetrics,
  buildPeriodSalesQuery,
  calculateWaterfallTotal,
  normalizeSalesRow,
} from "../app/services/financeShopifyql.js";

test("returns ShopifyQL rows", () => {
  assert.deepEqual(
    parseShopifyqlResult({
      data: {
        shopifyqlQuery: {
          parseErrors: [],
          tableData: { rows: [{ sales_channel: "Online Store" }] },
        },
      },
    }),
    [{ sales_channel: "Online Store" }],
  );
});

test("queries current ShopifyQL sales reversals and shipping metrics", () => {
  const query = buildPeriodSalesQuery({
    startDate: "2026-07-01",
    endDate: "2026-07-19",
  });

  assert.match(query, /sales_reversals/);
  assert.match(query, /shipping_charges/);
  assert.match(query, /average_order_value/);
  assert.match(query, /SINCE 2026-07-01 UNTIL 2026-07-19/);
  assert.doesNotMatch(query, /\breturns\b/);
});

test("preserves negative reversal signs without double subtraction", () => {
  const metrics = normalizeSalesRow({
    gross_sales: 100,
    discounts: -10,
    sales_reversals: -20,
    net_sales: 70,
    shipping_charges: 8,
    taxes: 5,
    duties: 1,
    additional_fees: 2,
    total_sales: 86,
    orders: 1,
    average_order_value: 86,
  });

  assert.equal(metrics.salesReversals, -20);
  assert.equal(metrics.shippingCharges, 8);
  assert.equal(calculateWaterfallTotal(metrics), 86);
});

test("aggregates only selected ShopifyQL channel rows", () => {
  const summaries = [
    {
      channel: { key: "Online Store" },
      ...normalizeSalesRow({
        gross_sales: 100,
        discounts: -10,
        sales_reversals: -5,
        net_sales: 85,
        shipping_charges: 10,
        taxes: 5,
        total_sales: 100,
        orders: 2,
        average_order_value: 50,
      }),
    },
    {
      channel: { key: "Point of Sale" },
      ...normalizeSalesRow({
        gross_sales: 200,
        net_sales: 200,
        total_sales: 200,
        orders: 4,
        average_order_value: 50,
      }),
    },
  ];

  const selected = aggregateSalesMetrics(summaries, ["Online Store"]);
  assert.equal(selected.totalSales, 100);
  assert.equal(selected.orders, 2);
  assert.equal(selected.averageOrderValue, 50);
  assert.equal(selected.shippingCharges, 10);
});

test("surfaces GraphQL, parse, and missing table errors", () => {
  assert.throws(
    () => parseShopifyqlResult({ errors: [{ message: "Denied" }] }),
    /Denied/,
  );
  assert.throws(
    () =>
      parseShopifyqlResult({
        data: {
          shopifyqlQuery: {
            parseErrors: ["Bad query"],
            tableData: null,
          },
        },
      }),
    /Bad query/,
  );
  assert.throws(
    () =>
      parseShopifyqlResult({
        data: { shopifyqlQuery: { parseErrors: [], tableData: null } },
      }),
    /no report table/i,
  );
});
