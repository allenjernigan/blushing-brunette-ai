import { auditProduct } from "../services/productAudit";
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useRouteError,
} from "react-router";
import { useAppBridge } from "@Shopify/app-bridge-react";
import { boundary } from "@Shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { generateText } from "../services/ai.server";
import {
  PRODUCT_DESCRIPTION_SYSTEM,
  buildProductDescriptionPrompt,
} from "../services/productPrompts";

const PRODUCT_QUERY = `#graphql
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
`;

const PRODUCT_UPDATE_MUTATION = `#graphql
  mutation PublishProductDescription($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
        descriptionHtml
        updatedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function loadProduct(admin, productId) {
  const response = await admin.graphql(PRODUCT_QUERY, {
    variables: {
      id: productId,
    },
  });

  const json = await response.json();

  if (json.errors || !json.data?.product) {
    throw new Response("Unable to load this product.", {
      status: 404,
    });
  }

  return json.data.product;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function draftToHtml(draft) {
  const lines = draft
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const html = [];
  let bulletItems = [];

  function flushBullets() {
    if (!bulletItems.length) return;

    html.push(
      `<ul>${bulletItems
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")}</ul>`,
    );

    bulletItems = [];
  }

  lines.forEach((line, index) => {
    const isBullet = /^[•*-]\s+/.test(line);

    if (isBullet) {
      bulletItems.push(line.replace(/^[•*-]\s+/, ""));
      return;
    }

    flushBullets();

    const normalized = line.toLowerCase();

    const isSectionHeading =
      normalized === "why you'll love it" ||
      normalized === "fit & details" ||
      normalized === "sizing" ||
      normalized === "fit note";

    if (index === 0 || isSectionHeading) {
      html.push(`<p><strong>${escapeHtml(line)}</strong></p>`);
      return;
    }

    html.push(`<p>${escapeHtml(line)}</p>`);
  });

  flushBullets();

  return html.join("");
}
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId");

  if (!productId) {
    throw new Response("Product ID is required.", {
      status: 400,
    });
  }

  const product = await loadProduct(admin, productId);

  return {
    product,
    audit: auditProduct(product),
  };
};
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const productId = formData.get("productId");
  const intent = formData.get("intent");

  if (typeof productId !== "string" || !productId) {
    return {
      ok: false,
      intent,
      error: "Product ID is required.",
    };
  }

  try {
    if (intent === "generate") {
      const product = await loadProduct(admin, productId);

      const draft = await generateText({
        system: PRODUCT_DESCRIPTION_SYSTEM,
        prompt: buildProductDescriptionPrompt(product),
      });

      return {
        ok: true,
        intent: "generate",
        draft,
      };
    }

    if (intent === "publish") {
      const draft = formData.get("draft");

      if (typeof draft !== "string" || !draft.trim()) {
        return {
          ok: false,
          intent: "publish",
          error: "The draft cannot be empty.",
        };
      }

      const descriptionHtml = draftToHtml(draft);

      const response = await admin.graphql(PRODUCT_UPDATE_MUTATION, {
        variables: {
          product: {
            id: productId,
            descriptionHtml,
          },
        },
      });

      const json = await response.json();

      if (json.errors) {
        throw new Error(json.errors[0]?.message || "Shopify update failed.");
      }

      const result = json.data.productUpdate;

      if (result.userErrors.length) {
        return {
          ok: false,
          intent: "publish",
          error: result.userErrors
            .map((error) => error.message)
            .join(", "),
        };
      }

      return {
        ok: true,
        intent: "publish",
        publishedDescriptionHtml: result.product.descriptionHtml,
      };
    }

    return {
      ok: false,
      intent,
      error: "Unknown action.",
    };
  } catch (error) {
    console.error("Product optimizer action failed:", error);

    return {
      ok: false,
      intent,
      error:
        error instanceof Error
          ? error.message
          : "The requested action failed.",
    };
  }
};

function stripHtml(html) {
  if (!html) return "";

  return html
    .replace(/<li>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/ul>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function ProductReview() {
  const { product, audit } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [draft, setDraft] = useState("");

  const activeIntent = fetcher.formData?.get("intent");

  const isGenerating =
    fetcher.state !== "idle" && activeIntent === "generate";

  const isPublishing =
    fetcher.state !== "idle" && activeIntent === "publish";

  const imageUrl = product.featuredMedia?.preview?.image?.url;
  const currentDescription = stripHtml(product.descriptionHtml);

  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.intent === "generate") {
      setDraft(fetcher.data.draft);
      shopify.toast.show("Description generated");
    }

    if (fetcher.data?.ok && fetcher.data.intent === "publish") {
      shopify.toast.show("Description published to Shopify");
    }

    if (fetcher.data?.error) {
      shopify.toast.show(fetcher.data.error, {
        isError: true,
      });
    }
  }, [fetcher.data, shopify]);

  function generateDescription() {
    fetcher.submit(
      {
        intent: "generate",
        productId: product.id,
      },
      {
        method: "POST",
      },
    );
  }

  function publishDescription() {
    fetcher.submit(
      {
        intent: "publish",
        productId: product.id,
        draft,
      },
      {
        method: "POST",
      },
    );
  }

  return (
    <s-page
      heading={product.title}
      backAction={{ content: "Products", url: "/app" }}
    >
      <s-button
        slot="primary-action"
        onClick={generateDescription}
        {...(isGenerating ? { loading: true } : {})}
      >
        {draft ? "Regenerate description" : "Generate description"}
      </s-button>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: "20px",
          alignItems: "start",
        }}
      >
        <s-section heading="Current Shopify description">
          <textarea
            value={currentDescription}
            readOnly
            placeholder="No current description"
            style={{
              boxSizing: "border-box",
              width: "100%",
              minHeight: "460px",
              padding: "14px",
              border: "1px solid #c9cccf",
              borderRadius: "8px",
              font: "inherit",
              lineHeight: 1.5,
              resize: "vertical",
              background: "#f6f6f7",
            }}
          />
        </s-section>

        <s-section heading="AI draft">
          {draft ? (
            <>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                style={{
                  boxSizing: "border-box",
                  width: "100%",
                  minHeight: "460px",
                  padding: "14px",
                  border: "1px solid #8c9196",
                  borderRadius: "8px",
                  font: "inherit",
                  lineHeight: 1.5,
                  resize: "vertical",
                  background: "#ffffff",
                }}
              />

              <div
                style={{
                  display: "flex",
                  gap: "10px",
                  marginTop: "14px",
                }}
              >
                <s-button
                  variant="primary"
                  onClick={publishDescription}
                  disabled={!draft.trim() || isGenerating}
                  {...(isPublishing ? { loading: true } : {})}
                >
                  Publish to Shopify
                </s-button>

                <s-button
                  onClick={() => setDraft("")}
                  disabled={isPublishing}
                >
                  Clear draft
                </s-button>
              </div>
            </>
          ) : (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-heading>No draft generated</s-heading>
              <s-paragraph>
                Generate a description to create an editable draft.
              </s-paragraph>
            </s-box>
          )}
        </s-section>
      </div>
<s-section heading="Product Readiness">
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: "24px",
      marginBottom: "20px",
    }}
  >
    <div
      style={{
        fontSize: "56px",
        fontWeight: "700",
      }}
    >
      {audit.score}%
    </div>

    <div>
      <h3 style={{ margin: 0 }}>Overall Readiness</h3>
      <p style={{ marginTop: "6px", color: "#666" }}>
        This score measures how complete this product page is.
      </p>
    </div>
  </div>

  <s-stack direction="block" gap="base">
    {audit.checks.map((check) => (
      <s-box
        key={check.key}
        padding="base"
        borderWidth="base"
        borderRadius="base"
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <strong>{check.label}</strong>

          <span
            style={{
              fontSize: "20px",
            }}
          >
            {check.passed ? "✅" : "❌"}
          </span>
        </div>
      </s-box>
    ))}
  </s-stack>
</s-section>
      <s-section heading="Verified Shopify data">
        <s-stack direction="block" gap="base">
          {imageUrl && (
            <img
              src={imageUrl}
              alt={
                product.featuredMedia?.preview?.image?.altText || product.title
              }
              style={{
                display: "block",
                width: "180px",
                borderRadius: "10px",
              }}
            />
          )}

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
