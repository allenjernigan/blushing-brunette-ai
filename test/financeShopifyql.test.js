import test from "node:test";
import assert from "node:assert/strict";

import { parseShopifyqlResult } from "../app/services/finance.server.js";

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
