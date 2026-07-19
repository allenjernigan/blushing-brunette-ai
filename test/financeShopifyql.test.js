import test from "node:test";
import assert from "node:assert/strict";

import {
  executeFinanceGraphql,
  getSafeGraphqlErrorDetails,
  parseShopifyqlResult,
} from "../app/services/finance.server.js";
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

test("Finance GraphQL logging exposes only approved failure details", () => {
  const details = getSafeGraphqlErrorDetails(
    {
      message:
        "Request failed at https://store.example/private access_token=secret-token",
      accessToken: "secret-token",
      session: { idToken: "secret-id-token" },
      graphQLErrors: [
        {
          message: "Access denied",
          path: ["shopifyqlQuery"],
          locations: [{ line: 2, column: 3 }],
          extensions: {
            code: "ACCESS_DENIED",
            documentation: "https://shopify.dev/access",
            hmac: "secret-hmac",
          },
        },
      ],
      networkError: {
        name: "NetworkError",
        message: "Connection failed",
        statusCode: 502,
        url: "https://store.example/admin/api?token=secret",
      },
      response: {
        status: 502,
        requestUrl: "https://store.example/private",
        errors: [{ message: "Bad gateway" }],
      },
    },
    "FinanceShopifyql",
  );

  assert.deepEqual(details, {
    operationName: "FinanceShopifyql",
    message: "Request failed at [REDACTED_URL] access_token=[REDACTED]",
    graphQLErrors: [
      {
        message: "Access denied",
        path: ["shopifyqlQuery"],
        locations: [{ line: 2, column: 3 }],
        extensions: {
          code: "ACCESS_DENIED",
          documentation: "[REDACTED_URL]",
          hmac: "[REDACTED]",
        },
      },
    ],
    networkError: {
      name: "NetworkError",
      message: "Connection failed",
      status: 502,
    },
    responseStatus: 502,
    responseErrors: [
      {
        message: "Bad gateway",
        path: null,
        locations: null,
        extensions: null,
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(details),
    /store\.example|secret-token|secret-hmac|requestUrl/i,
  );
});

test("Finance GraphQL logging rethrows the original error", async () => {
  const originalError = new Error("Network failure");
  originalError.graphQLErrors = [
    {
      message: "Required access: read_reports",
      extensions: { code: "ACCESS_DENIED" },
    },
  ];
  const originalConsoleError = console.error;
  let loggedArguments;
  console.error = (...argumentsToLog) => {
    loggedArguments = argumentsToLog;
  };

  try {
    await assert.rejects(
      executeFinanceGraphql(
        { graphql: async () => Promise.reject(originalError) },
        "FinanceOrders",
        "query FinanceOrders { shop { id } }",
      ),
      (error) => error === originalError,
    );
    assert.equal(loggedArguments[0], "[Finance GraphQL request failed]");
    assert.match(loggedArguments[1], /\n {2}"graphQLErrors": \[/);
    assert.doesNotMatch(loggedArguments[1], /\[Array\]/);
    assert.equal(
      JSON.parse(loggedArguments[1]).graphQLErrors[0].extensions.code,
      "ACCESS_DENIED",
    );
  } finally {
    console.error = originalConsoleError;
  }
});
