import { DateTime } from "luxon";
import {
  buildProcessedAtRangeQuery,
  isOrderWithinDateRange,
} from "./financeDateRange";

const STANDARD_SOURCE_NAMES = new Set([
  "web",
  "pos",
  "shopify_draft_order",
]);

export function normalizeSourceName(sourceName) {
  return String(sourceName || "")
    .trim()
    .toLowerCase();
}

export function classifyOrderChannel(order) {
  return normalizeSourceName(order.sourceName) === "pos"
    ? "pos"
    : "ecommerce";
}

function withChannelClassification(order) {
  return {
    ...order,
    rawSourceName: order.sourceName || null,
    salesChannel: classifyOrderChannel(order),
  };
}

function getUnexpectedSourceNames(orders) {
  return Array.from(
    new Set(
      orders
        .map((order) => normalizeSourceName(order.sourceName))
        .filter(
          (sourceName) =>
            !STANDARD_SOURCE_NAMES.has(sourceName),
        )
        .map((sourceName) => sourceName || "(missing)"),
    ),
  ).sort();
}

function moneyAmount(moneySet) {
  return Number(moneySet?.shopMoney?.amount || 0);
}

function getLineItemCost(lineItem) {
  const rawCost =
    lineItem.variant?.inventoryItem?.unitCost?.amount;

  if (
    rawCost === null ||
    rawCost === undefined ||
    rawCost === ""
  ) {
    return null;
  }

  const unitCost = Number(rawCost);

  return Number.isFinite(unitCost) ? unitCost : null;
}

function getLineItemVariantKey(lineItem) {
  return (
    lineItem.variant?.id ||
    [lineItem.title, lineItem.variantTitle, lineItem.sku]
      .filter(Boolean)
      .join("::") ||
    lineItem.id
  );
}

function calculateProductCosts(orders) {
  let knownCogs = 0;
  let knownCostSales = 0;
  let unitsMissingCost = 0;
  let missingCostSales = 0;
  const missingCostItems = new Map();
  const zeroCostVariantKeys = new Set();

  for (const order of orders) {
    for (const lineItem of order.lineItems?.nodes || []) {
      const quantity = Number(lineItem.currentQuantity || 0);

      if (quantity <= 0) continue;

      const salesAmount =
        moneyAmount(
          lineItem.discountedUnitPriceAfterAllDiscountsSet,
        ) * quantity;
      const unitCost = getLineItemCost(lineItem);

      if (unitCost !== null) {
        if (unitCost === 0) {
          zeroCostVariantKeys.add(
            getLineItemVariantKey(lineItem),
          );
        }

        knownCogs += unitCost * quantity;
        knownCostSales += salesAmount;
        continue;
      }

      unitsMissingCost += quantity;
      missingCostSales += salesAmount;

      const key = getLineItemVariantKey(lineItem);
      const existing = missingCostItems.get(key);

      if (existing) {
        existing.quantity += quantity;
        existing.salesAmount += salesAmount;
        continue;
      }

      missingCostItems.set(key, {
        id: key,
        productName: lineItem.title,
        variantName:
          lineItem.variantTitle ||
          lineItem.variant?.title ||
          "Default variant",
        sku: lineItem.sku || lineItem.variant?.sku || null,
        quantity,
        salesAmount,
      });
    }
  }

  return {
    knownCogs,
    knownCostSales,
    unitsMissingCost,
    missingCostSales,
    zeroCostVariantCount: zeroCostVariantKeys.size,
    isComplete: unitsMissingCost === 0,
    missingCostItems: Array.from(missingCostItems.values()).sort(
      (left, right) => right.salesAmount - left.salesAmount,
    ),
  };
}

async function getShopSettings(admin) {
  const response = await admin.graphql(
    `#graphql
      query FinanceShopSettings {
        shop {
          ianaTimezone
          currencyCode
        }
      }
    `,
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(
      json.errors.map((error) => error.message).join(", "),
    );
  }

  return {
    timezone: json.data.shop.ianaTimezone,
    currencyCode: json.data.shop.currencyCode,
  };
}

function getPeriodRange(periodKey, timezone) {
  const now = DateTime.now().setZone(timezone);

  switch (periodKey) {
    case "today":
      return {
        key: "today",
        label: `Today — ${now.toFormat("MMMM d, yyyy")}`,
        start: now.startOf("day").toUTC().toISO(),
        end: now.toUTC().toISO(),
      };

    case "month-to-date":
      return {
        key: "month-to-date",
        label: `Month to Date — ${now.toFormat("MMMM yyyy")}`,
        start: now.startOf("month").toUTC().toISO(),
        end: now.toUTC().toISO(),
      };

    case "last-month": {
      const lastMonth = now.minus({ months: 1 });

      return {
        key: "last-month",
        label: lastMonth.toFormat("MMMM yyyy"),
        start: lastMonth.startOf("month").toUTC().toISO(),
        end: now.startOf("month").toUTC().toISO(),
      };
    }

    case "yesterday":
    default: {
      const yesterday = now.minus({ days: 1 });

      return {
        key: "yesterday",
        label: `Yesterday — ${yesterday.toFormat(
          "MMMM d, yyyy",
        )}`,
        start: yesterday.startOf("day").toUTC().toISO(),
        end: yesterday
          .plus({ days: 1 })
          .startOf("day")
          .toUTC()
          .toISO(),
      };
    }
  }
}

const SHOPIFYQL_SALES_METRICS = [
  "gross_sales",
  "discounts",
  "sales_reversals",
  "net_sales",
  "shipping_charges",
  "taxes",
  "total_sales",
  "orders",
  "average_order_value",
];

function buildShopifyqlSalesQuery(
  period,
  timezone,
  groupByPos,
) {
  const startDate = DateTime.fromISO(period.start)
    .setZone(timezone)
    .toFormat("yyyy-MM-dd");
  const endDate = DateTime.fromISO(period.end)
    .minus({ milliseconds: 1 })
    .setZone(timezone)
    .toFormat("yyyy-MM-dd");
  const grouping = groupByPos
    ? "\n    GROUP BY is_pos_sale"
    : "";

  return `FROM sales
    SHOW ${SHOPIFYQL_SALES_METRICS.join(", ")}${grouping}
    SINCE ${startDate} UNTIL ${endDate}`;
}

function isPosSalesRow(row) {
  return (
    row.is_pos_sale === true ||
    row.is_pos_sale === "true"
  );
}

function normalizeShopifyqlSales(row = {}) {
  return {
    grossProductSales: Number(row.gross_sales || 0),
    discounts: Number(row.discounts || 0),
    returnsAndEdits: Number(
      row.sales_reversals || 0,
    ),
    netProductSales: Number(row.net_sales || 0),
    shippingCollected: Number(
      row.shipping_charges || 0,
    ),
    taxes: Number(row.taxes || 0),
    totalSales: Number(row.total_sales || 0),
    orders: Number(row.orders || 0),
    averageOrderValue: Number(
      row.average_order_value || 0,
    ),
  };
}

async function runShopifyqlSalesQuery(
  admin,
  query,
  operationName,
) {
  const response = await admin.graphql(
    `#graphql
      query FinanceShopifyqlSales($query: String!) {
        shopifyqlQuery(query: $query) {
          parseErrors
          tableData {
            rows
          }
        }
      }
    `,
    {
      variables: { query },
    },
  );

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `${operationName} failed: ${json.errors
        .map((error) => error.message)
        .join(", ")}`,
    );
  }

  const result = json.data?.shopifyqlQuery;

  if (!result) {
    throw new Error(
      `${operationName} returned no ShopifyQL result.`,
    );
  }

  if (result.parseErrors?.length) {
    throw new Error(
      `${operationName} parse errors: ${result.parseErrors.join(
        ", ",
      )}`,
    );
  }

  if (!result.tableData) {
    throw new Error(
      `${operationName} returned no table data.`,
    );
  }

  return result.tableData.rows || [];
}

async function getShopifyqlSalesTotals(
  admin,
  period,
  timezone,
) {
  const [groupedRows, allRows] = await Promise.all([
    runShopifyqlSalesQuery(
      admin,
      buildShopifyqlSalesQuery(
        period,
        timezone,
        true,
      ),
      "Grouped Finance ShopifyQL query",
    ),
    runShopifyqlSalesQuery(
      admin,
      buildShopifyqlSalesQuery(
        period,
        timezone,
        false,
      ),
      "All-channel Finance ShopifyQL query",
    ),
  ]);

  const ecommerceRow = groupedRows.find(
    (row) => !isPosSalesRow(row),
  );
  const posRow = groupedRows.find(isPosSalesRow);
  const allRow = allRows[0];

  if (!allRow) {
    throw new Error(
      "All-channel Finance ShopifyQL query returned no totals row.",
    );
  }

  return {
    all: normalizeShopifyqlSales(allRow),
    ecommerce: normalizeShopifyqlSales(ecommerceRow),
    pos: normalizeShopifyqlSales(posRow),
  };
}

async function getOrdersForRange(admin, start, end) {
  const orders = [];
  let hasNextPage = true;
  let cursor = null;

  const searchQuery = buildProcessedAtRangeQuery(start, end);

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query FinanceOrders(
          $query: String!
          $cursor: String
        ) {
          orders(
            first: 250
            after: $cursor
            query: $query
            sortKey: PROCESSED_AT
          ) {
            nodes {
              id
              name
              createdAt
              processedAt
              sourceName
              requiresShipping
              displayFinancialStatus
              displayFulfillmentStatus
              cancelledAt

              retailLocation {
                id
                name
              }

              transactions(first: 250) {
                id
                kind
                status
                processedAt
                test
                manualPaymentGateway
                formattedGateway

                amountSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }

                fees {
                  amount {
                    amount
                    currencyCode
                  }
                  taxAmount {
                    amount
                    currencyCode
                  }
                  type
                }
              }

              originalTotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              subtotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              totalShippingPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              totalTaxSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              totalDiscountsSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              currentTotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              currentSubtotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              currentShippingPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              currentTotalTaxSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              currentTotalDiscountsSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }

              lineItems(first: 250) {
                nodes {
                  id
                  title
                  variantTitle
                  sku
                  quantity
                  currentQuantity

                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }

                  discountedUnitPriceAfterAllDiscountsSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }

                  variant {
                    id
                    title
                    sku
                    inventoryItem {
                      unitCost {
                        amount
                        currencyCode
                      }
                    }
                  }
                }

                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }

            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        variables: {
          query: searchQuery,
          cursor,
        },
      },
    );

    const json = await response.json();

    if (json.errors?.length) {
      throw new Error(
        json.errors.map((error) => error.message).join(", "),
      );
    }

    const result = json.data.orders;

    for (const order of result.nodes) {
      order.lineItems.nodes = await getRemainingOrderLineItems(
        admin,
        order.id,
        order.lineItems.nodes,
        order.lineItems.pageInfo,
      );

      if (isOrderWithinDateRange(order, start, end)) {
        orders.push(order);
      }
    }

    hasNextPage = result.pageInfo.hasNextPage;
    cursor = result.pageInfo.endCursor;
  }

  return orders;
}

async function getRemainingOrderLineItems(
  admin,
  orderId,
  initialItems,
  initialPageInfo,
) {
  const lineItems = [...initialItems];
  let hasNextPage = initialPageInfo.hasNextPage;
  let cursor = initialPageInfo.endCursor;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query FinanceOrderLineItems(
          $orderId: ID!
          $cursor: String
        ) {
          order(id: $orderId) {
            lineItems(
              first: 250
              after: $cursor
            ) {
              nodes {
                id
                title
                variantTitle
                sku
                quantity
                currentQuantity

                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }

                discountedUnitPriceAfterAllDiscountsSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }

                variant {
                  id
                  title
                  sku
                  inventoryItem {
                    unitCost {
                      amount
                      currencyCode
                    }
                  }
                }
              }

              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      {
        variables: {
          orderId,
          cursor,
        },
      },
    );

    const json = await response.json();

    if (json.errors?.length) {
      throw new Error(
        json.errors.map((error) => error.message).join(", "),
      );
    }

    const result = json.data.order?.lineItems;

    if (!result) {
      throw new Error(
        `Unable to load line items for Shopify order ${orderId}.`,
      );
    }

    lineItems.push(...result.nodes);
    hasNextPage = result.pageInfo.hasNextPage;
    cursor = result.pageInfo.endCursor;
  }

  return lineItems;
}

export async function getFinanceSales(
  admin,
  periodKey,
  channel = "ecommerce",
) {
  const shop = await getShopSettings(admin);

  const period = getPeriodRange(
    periodKey,
    shop.timezone,
  );

  const [loadedOrders, shopifyqlSales] =
    await Promise.all([
      getOrdersForRange(
        admin,
        period.start,
        period.end,
      ),
      getShopifyqlSalesTotals(
        admin,
        period,
        shop.timezone,
      ),
    ]);
  const allOrders = loadedOrders.map(
    withChannelClassification,
  );
  const orders =
    channel === "all"
      ? allOrders
      : allOrders.filter(
          (order) => order.salesChannel === channel,
        );
  const ecommerceOrders = allOrders.filter(
    (order) => order.salesChannel === "ecommerce",
  );
  const posOrders = allOrders.filter(
    (order) => order.salesChannel === "pos",
  );

  return {
    orders,
    allOrders,
    productCosts: calculateProductCosts(orders),
    productCostsByChannel: {
      ecommerce: calculateProductCosts(ecommerceOrders),
      pos: calculateProductCosts(posOrders),
    },
    shopifyqlSales: shopifyqlSales[channel],
    shopifyqlSalesByChannel: shopifyqlSales,
    unexpectedSourceNames: getUnexpectedSourceNames(allOrders),
    period,
    timezone: shop.timezone,
    currencyCode: shop.currencyCode,
  };
}
