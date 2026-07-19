export async function fetchHistoricalOrders(admin) {
  const orders = [];

  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query HistoricalOrders($cursor: String) {
          orders(
            first: 50
            after: $cursor
            sortKey: PROCESSED_AT
            reverse: false
          ) {
            nodes {
              id
              name
              createdAt
              processedAt
              cancelledAt
              displayFinancialStatus
              currencyCode

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
          cursor,
        },
      },
    );

    const json = await response.json();

    if (json.errors?.length) {
      throw new Error(
        json.errors
          .map((error) => error.message)
          .join(", "),
      );
    }

    const result = json.data.orders;

    orders.push(...result.nodes);

    hasNextPage = result.pageInfo.hasNextPage;
    cursor = result.pageInfo.endCursor;
  }

  return orders;
}