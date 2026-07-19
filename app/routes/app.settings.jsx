import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  SettingsValidationError,
  getOrCreateShopSettings,
  serializeShopSettings,
  updateShopSettings,
} from "../services/settings.server";

const SETTING_FIELDS = [
  {
    name: "ecommerceShippingCost",
    label: "Estimated outbound shipping cost per ecommerce shipment",
    step: "0.01",
  },
  {
    name: "posShippingCost",
    label: "Estimated outbound shipping cost per shipped POS order",
    step: "0.01",
  },
  {
    name: "ecommerceProcessingPercentage",
    label: "Ecommerce processing percentage",
    step: "0.01",
  },
  {
    name: "ecommerceProcessingFixedFee",
    label: "Ecommerce fixed fee per processed order",
    step: "0.01",
  },
  {
    name: "posProcessingPercentage",
    label: "POS processing percentage",
    step: "0.01",
  },
  {
    name: "posProcessingFixedFee",
    label: "POS fixed fee per processed order",
    step: "0.01",
  },
  {
    name: "monthlyFixedOperatingExpenses",
    label: "Monthly fixed operating expenses",
    step: "0.01",
  },
  {
    name: "targetContributionMarginPercentage",
    label: "Target contribution margin percentage",
    step: "0.01",
  },
  {
    name: "targetRoas",
    label: "Target ROAS",
    step: "0.01",
  },
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const settings = await getOrCreateShopSettings(session.shop);

  return { settings: serializeShopSettings(settings) };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const values = Object.fromEntries(formData);

  try {
    const settings = await updateShopSettings(
      session.shop,
      values,
    );

    return {
      success: true,
      values: serializeShopSettings(settings),
      errors: {},
    };
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return {
        success: false,
        values: error.values,
        errors: error.errors,
      };
    }

    console.error("Unable to save shop settings", error);

    return {
      success: false,
      values,
      errors: {
        form: "Settings could not be saved. Please try again.",
      },
    };
  }
};

export default function SettingsPage() {
  const { settings } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const values = actionData?.values || settings;
  const errors = actionData?.errors || {};
  const isSaving = navigation.state === "submitting";

  return (
    <s-page heading="Settings">
      <s-section heading="Finance assumptions">
        <s-paragraph>
          These values are stored separately for this Shopify shop and are
          used by Finance reporting.
        </s-paragraph>

        <Form method="post">
          <div
            style={{
              display: "grid",
              gap: "16px",
              maxWidth: "720px",
              marginTop: "16px",
            }}
          >
            {SETTING_FIELDS.map((field) => (
              <label key={field.name}>
                <span
                  style={{
                    display: "block",
                    fontWeight: 600,
                    marginBottom: "6px",
                  }}
                >
                  {field.label}
                </span>
                <input
                  type="number"
                  name={field.name}
                  min="0"
                  step={field.step}
                  defaultValue={values[field.name]}
                  style={{
                    boxSizing: "border-box",
                    width: "100%",
                    padding: "10px 12px",
                    border: "1px solid #8c9196",
                    borderRadius: "8px",
                  }}
                />
                {errors[field.name] ? (
                  <span
                    style={{
                      display: "block",
                      color: "#b42318",
                      marginTop: "4px",
                    }}
                  >
                    {errors[field.name]}
                  </span>
                ) : null}
              </label>
            ))}

            <label>
              <span
                style={{
                  display: "block",
                  fontWeight: 600,
                  marginBottom: "6px",
                }}
              >
                Default Finance channel
              </span>
              <select
                name="defaultFinanceChannel"
                defaultValue={values.defaultFinanceChannel}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  border: "1px solid #8c9196",
                  borderRadius: "8px",
                  background: "#ffffff",
                }}
              >
                <option value="ecommerce">Ecommerce</option>
                <option value="pos">POS</option>
                <option value="all">All Channels</option>
              </select>
              {errors.defaultFinanceChannel ? (
                <span
                  style={{
                    display: "block",
                    color: "#b42318",
                    marginTop: "4px",
                  }}
                >
                  {errors.defaultFinanceChannel}
                </span>
              ) : null}
            </label>

            {actionData?.success ? (
              <s-paragraph>✅ Settings saved.</s-paragraph>
            ) : null}

            {errors.form ? (
              <s-paragraph>⚠ {errors.form}</s-paragraph>
            ) : null}

            <button
              type="submit"
              disabled={isSaving}
              style={{
                justifySelf: "start",
                padding: "10px 16px",
                border: "none",
                borderRadius: "8px",
                background: "#202223",
                color: "#ffffff",
                fontWeight: 600,
                cursor: isSaving ? "not-allowed" : "pointer",
                opacity: isSaving ? 0.6 : 1,
              }}
            >
              {isSaving ? "Saving..." : "Save settings"}
            </button>
          </div>
        </Form>
      </s-section>

      <s-section heading="Not yet included in calculations">
        <s-paragraph>
          Monthly fixed expenses, contribution-margin targets, and ROAS targets
          are saved for future Finance features but are not applied to current
          results.
        </s-paragraph>
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
