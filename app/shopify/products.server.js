export async function fetchProducts(admin) {
  const products = [];

  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
      query Products($cursor: String) {
        products(
          first: 100
          after: $cursor
        ) {

          nodes {

            id

            title

            handle

            status

            vendor

            productType

            createdAt

            updatedAt

            variants(first:100){

              nodes{

                id

                title

                sku

                barcode

                price

                compareAtPrice

                inventoryQuantity

                inventoryItem{

                  id

                  unitCost{
                    amount
                  }

                }

              }

            }

          }

          pageInfo{
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
          .map((e) => e.message)
          .join(", "),
      );
    }

    products.push(...json.data.products.nodes);

    hasNextPage =
      json.data.products.pageInfo.hasNextPage;

    cursor =
      json.data.products.pageInfo.endCursor;
  }

  return products;
}