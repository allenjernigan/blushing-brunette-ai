import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@Shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  if (!productId) {
    throw new Response("Product ID is required.", {
      status: 400,
    });
  }

  const response = await admin.graphql(
    `#graphql
      query ProductOptimizerProduct($id: ID!) {
        product(id: $id) {
          id
          title
          status
          descriptionHtml
          totalInventory
          productType
          vendor
          tags
          featuredMedia {
            preview {
              image {
                url
                altText
              }
            }
          }
          variants(first: 50) {
            nodes {
              id
              title
              price
              inventoryQuantity
            }
          }
        }
      }
    `,
    {
      variables: {
        id: productId,
      },
    },
  );

  const json = await response.json();

  if (json.errors || !json.data.product) {
    throw new Response("Unable to load this product.", {
      status: 404,
    });
  }

  return {
    product: json.data.product,
  };
};

function stripHtml(html) {
  if (!html) return "";

  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function ProductReview() {
  const { product } = useLoaderData();
  const imageUrl = product.featuredMedia?.preview?.image?.url;
  const currentDescription = stripHtml(product.descriptionHtml);

  return (
    <s-page
      heading={product.title}
      backAction={{ content: "Products", url: "/app" }}
    >
      <s-button slot="primary-action" disabled>
        Generate description
      </s-button>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: "20px",
          alignItems: "start",
        }}
      >
        <s-section heading="Product information">
          {imageUrl && (
            <img
              src={imageUrl}
              alt={
                product.featuredMedia?.preview?.image?.altText || product.title
              }
              style={{
                display: "block",
                width: "100%",
                maxWidth: "360px",
                borderRadius: "12px",
                marginBottom: "18px",
              }}
            />
          )}

          <s-stack direction="block" gap="base">
            <s-paragraph>
              <strong>Status:</strong> {product.status}
            </s-paragraph>

            <s-paragraph>
              <strong>Inventory:</strong> {product.totalInventory}
            </s-paragraph>

            <s-paragraph>
              <strong>Product type:</strong>{" "}
              {product.productType || "Not provided"}
            </s-paragraph>

            <s-paragraph>
              <strong>Vendor:</strong> {product.vendor || "Not provided"}
            </s-paragraph>

            <s-paragraph>
              <strong>Tags:</strong>{" "}
              {product.tags.length ? product.tags.join(", ") : "None"}
            </s-paragraph>
          </s-stack>
        </s-section>

        <s-section heading="Current description">
          {currentDescription ? (
            <textarea
              value={currentDescription}
              readOnly
              style={{
                boxSizing: "border-box",
                width: "100%",
                minHeight: "420px",
                padding: "14px",
                border: "1px solid #c9cccf",
                borderRadius: "8px",
                font: "inherit",
                lineHeight: 1.5,
                resize: "vertical",
                background: "#f6f6f7",
              }}
            />
          ) : (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-heading>No description</s-heading>
              <s-paragraph>
                This product does not currently have a description.
              </s-paragraph>
            </s-box>
          )}
        </s-section>
      </div>

      <s-section heading="Sizes and inventory">
        <s-stack direction="block" gap="base">
          {product.variants.nodes.map((variant) => (
            <s-box
              key={variant.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-paragraph>
                <strong>{variant.title}</strong> · ${variant.price} · Inventory:{" "}
                {variant.inventoryQuantity}
              </s-paragraph>
            </s-box>
          ))}
        </s-stack>
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
