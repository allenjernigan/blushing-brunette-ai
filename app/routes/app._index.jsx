import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query ProductOptimizerProducts($first: Int!) {
        products(first: $first, sortKey: UPDATED_AT, reverse: true) {
          nodes {
            id
            title
            status
            descriptionHtml
            totalInventory
          }
        }
      }
    `,
    {
      variables: {
        first: 25,
      },
    },
  );

  const json = await response.json();

  if (json.errors) {
    throw new Response("Unable to load products from Shopify.", {
      status: 500,
    });
  }

  return {
    products: json.data.products.nodes,
  };
};

function descriptionPreview(descriptionHtml) {
  if (!descriptionHtml) return "No description";

  return descriptionHtml
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export default function ProductOptimizer() {
  const { products } = useLoaderData();

  return (
    <s-page heading="Product Optimizer">
      <s-button slot="primary-action" disabled>
        Optimize selected
      </s-button>

      <s-section heading="Blushing Brunette product descriptions">
        <s-paragraph>
          Review products, improve weak descriptions, and publish approved copy
          back to Shopify.
        </s-paragraph>
      </s-section>

      <s-section heading={`Products (${products.length})`}>
        {products.length === 0 ? (
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-heading>No products found</s-heading>
            <s-paragraph>
              Add a test product in Shopify Admin so we can verify the
              optimizer safely.
            </s-paragraph>
          </s-box>
        ) : (
          <s-stack direction="block" gap="base">
            {products.map((product) => {
              const preview = descriptionPreview(product.descriptionHtml);

              return (
                <s-box
                  key={product.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: "20px",
                      alignItems: "start",
                    }}
                  >
                    <div>
                      <s-heading>{product.title}</s-heading>

                      <p
                        style={{
                          margin: "8px 0",
                          color: "#616161",
                          lineHeight: 1.5,
                        }}
                      >
                        {preview}
                        {preview.length >= 180 ? "…" : ""}
                      </p>

                      <p
                        style={{
                          margin: 0,
                          fontSize: "13px",
                          color: "#737373",
                        }}
                      >
                        Status: {product.status} · Inventory:{" "}
                        {product.totalInventory}
                      </p>
                    </div>

                    <s-button
                      href={`/app/product-review?productId=${encodeURIComponent(
                        product.id,
                      )}`}
                    >
                      Review
                    </s-button>
                  </div>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
