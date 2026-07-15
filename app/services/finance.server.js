import { DateTime } from "luxon";

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

async function getOrdersForRange(admin, start, end) {
  const orders = [];
  let hasNextPage = true;
  let cursor = null;

  const searchQuery =
    `processed_at:>=${start} processed_at:<${end}`;

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
              displayFinancialStatus
              cancelledAt

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

              lineItems(first: 100) {
                nodes {
                  id
                  name
                  quantity
                  currentQuantity

                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }

                  discountedUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
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

    orders.push(...result.nodes);

    hasNextPage = result.pageInfo.hasNextPage;
    cursor = result.pageInfo.endCursor;
  }

  return orders;
}

export async function getFinanceSales(admin, periodKey) {
  const shop = await getShopSettings(admin);

  const period = getPeriodRange(
    periodKey,
    shop.timezone,
  );

  const orders = await getOrdersForRange(
    admin,
    period.start,
    period.end,
  );

  return {
    orders,
    period,
    timezone: shop.timezone,
    currencyCode: shop.currencyCode,
  };
}