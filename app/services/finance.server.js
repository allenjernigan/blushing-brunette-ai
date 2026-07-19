import {
  buildProcessedAtRangeQuery,
  FinanceDateRangeError,
  getFinanceDateRange,
  isOrderWithinDateRange,
} from "./financeDateRange.js";
import {
  UNATTRIBUTED_CHANNEL,
  getPresetChannels,
  getPeriodChannelKeys,
  normalizeOrderChannel,
  normalizeShopifyChannel,
} from "./financeFilters.js";
import {
  aggregateSalesMetrics,
  buildPeriodSalesQuery,
  normalizeSalesRow,
} from "./financeShopifyql.js";

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
  return normalizeOrderChannel(order);
}

function withChannelClassification(order, channelByKey) {
  const salesChannel = classifyOrderChannel(order);

  return {
    ...order,
    rawSourceName: order.sourceName || null,
    salesChannel,
    salesChannelLabel:
      channelByKey.get(salesChannel)?.label ||
      order.app?.name ||
      "Unattributed",
    isPos: channelByKey.get(salesChannel)?.isPos || false,
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

export function parseShopifyqlResult(json) {
  if (json.errors?.length) {
    throw new Error(
      json.errors.map((error) => error.message).join(", "),
    );
  }

  const result = json.data?.shopifyqlQuery;

  if (!result) {
    throw new Error("ShopifyQL returned no report data.");
  }

  if (result.parseErrors?.length) {
    throw new Error(
      `ShopifyQL could not parse the Finance report: ${result.parseErrors.join(", ")}`,
    );
  }

  if (!result.tableData) {
    throw new Error("ShopifyQL returned no report table.");
  }

  return result.tableData.rows || [];
}

async function runShopifyql(admin, query) {
  const response = await admin.graphql(
    `#graphql
      query FinanceShopifyql($query: String!) {
        shopifyqlQuery(query: $query) {
          parseErrors
          tableData {
            columns {
              name
              dataType
              displayName
            }
            rows
          }
        }
      }
    `,
    { variables: { query } },
  );

  return parseShopifyqlResult(await response.json());
}

async function getSalesChannels(admin) {
  const rows = await runShopifyql(
    admin,
    `FROM sales
      SHOW total_sales, orders
      GROUP BY sales_channel, is_pos_sale
      SINCE 2000-01-01 UNTIL today
      ORDER BY total_sales DESC`,
  );

  const channelsByKey = new Map();

  for (const row of rows) {
    const channel = normalizeShopifyChannel(
      row.sales_channel,
      row.is_pos_sale === true || row.is_pos_sale === "true",
    );
    const existing = channelsByKey.get(channel.key);
    channelsByKey.set(channel.key, {
      ...channel,
      isPos: channel.isPos || existing?.isPos || false,
    });
  }

  if (!channelsByKey.has(UNATTRIBUTED_CHANNEL)) {
    const unattributed = normalizeShopifyChannel(null);
    channelsByKey.set(unattributed.key, unattributed);
  }

  return Array.from(channelsByKey.values());
}

async function getPeriodChannelSales(admin, period) {
  const rows = await runShopifyql(
    admin,
    buildPeriodSalesQuery(period),
  );

  return rows.map((row) => ({
    channel: normalizeShopifyChannel(row.sales_channel),
    ...normalizeSalesRow(row),
  }));
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
              app {
                id
                name
              }
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
  {
    periodKey = "today",
    customStart,
    customEnd,
    requestedChannels = null,
  } = {},
) {
  const shop = await getShopSettings(admin);
  const channels = await getSalesChannels(admin);
  const channelByKey = new Map(
    channels.map((channel) => [channel.key, channel]),
  );
  const validChannelKeys = new Set(channelByKey.keys());
  const selectedChannels =
    requestedChannels === null
      ? getPresetChannels("all", channels)
      : Array.from(new Set(requestedChannels)).filter((channel) =>
          validChannelKeys.has(channel),
        );

  let period;
  let dateError = null;

  try {
    period = getFinanceDateRange({
      periodKey,
      timezone: shop.timezone,
      customStart,
      customEnd,
    });
  } catch (error) {
    if (!(error instanceof FinanceDateRangeError)) throw error;

    dateError = error.message;
    period = {
      key: periodKey,
      label: "Custom range needs attention",
      start: null,
      end: null,
      startDate: customStart || "",
      endDate: customEnd || "",
    };
  }

  const [rawOrders, shopifyChannelSales] = dateError
    ? [[], []]
    : await Promise.all([
        getOrdersForRange(admin, period.start, period.end),
        getPeriodChannelSales(admin, period),
      ]);
  const allOrders = rawOrders.map((order) =>
    withChannelClassification(order, channelByKey),
  );
  const selectedChannelSet = new Set(selectedChannels);
  const orders = allOrders.filter((order) =>
    selectedChannelSet.has(order.salesChannel),
  );
  const ordersByChannel = new Map();

  for (const order of allOrders) {
    const channelOrders = ordersByChannel.get(order.salesChannel) || [];
    channelOrders.push(order);
    ordersByChannel.set(order.salesChannel, channelOrders);
  }

  const channelSalesByKey = new Map(
    shopifyChannelSales.map((summary) => [
      summary.channel.key,
      summary,
    ]),
  );
  const activeChannelKeys = getPeriodChannelKeys(
    shopifyChannelSales,
    allOrders,
  );
  const channelBreakdown = activeChannelKeys.map((key) => {
    const channel =
      channelByKey.get(key) ||
      channelSalesByKey.get(key)?.channel ||
      normalizeShopifyChannel(
        key === UNATTRIBUTED_CHANNEL ? null : key,
      );
    const channelOrders = ordersByChannel.get(key) || [];

    return {
      channel,
      shopify: channelSalesByKey.get(key) || null,
      orders: channelOrders,
      productCosts: calculateProductCosts(channelOrders),
    };
  });

  return {
    orders,
    allOrders,
    productCosts: calculateProductCosts(orders),
    channels,
    selectedChannels,
    shopifyMetrics: aggregateSalesMetrics(
      shopifyChannelSales,
      selectedChannels,
    ),
    channelBreakdown,
    dateError,
    unexpectedSourceNames: getUnexpectedSourceNames(allOrders),
    period,
    timezone: shop.timezone,
    currencyCode: shop.currencyCode,
  };
}
