import {
  Link,
  useLoaderData,
  useRouteError,
} from "react-router";
import { boundary } from "@Shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getFinanceSales } from "../services/finance.server";

const PERIODS = [
  {
    key: "today",
    label: "Today",
  },
  {
    key: "yesterday",
    label: "Yesterday",
  },
  {
    key: "month-to-date",
    label: "Month to Date",
  },
  {
    key: "last-month",
    label: "Last Month",
  },
];

function money(value, currencyCode = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
  }).format(Number(value || 0));
}

function getMoneyAmount(object) {
  return Number(object?.shopMoney?.amount || 0);
}

function sumMoney(orders, field) {
  return orders.reduce((total, order) => {
    return total + getMoneyAmount(order[field]);
  }, 0);
}

function countUnitsSold(orders) {
  return orders.reduce((total, order) => {
    const orderUnits =
      order.lineItems?.nodes?.reduce(
        (lineTotal, lineItem) =>
          lineTotal +
          Number(lineItem.currentQuantity || 0),
        0,
      ) || 0;

    return total + orderUnits;
  }, 0);
}

function calculateGrossProductSales(orders) {
  return orders.reduce((orderTotal, order) => {
    const lineItemTotal =
      order.lineItems?.nodes?.reduce(
        (lineTotal, lineItem) => {
          const unitPrice = getMoneyAmount(
            lineItem.originalUnitPriceSet,
          );

          const originalQuantity = Number(
            lineItem.quantity || 0,
          );

          return (
            lineTotal +
            unitPrice * originalQuantity
          );
        },
        0,
      ) || 0;

    return orderTotal + lineItemTotal;
  }, 0);
}

function isValidPeriod(period) {
  return PERIODS.some(
    (option) => option.key === period,
  );
}

export const loader = async ({ request }) => {
  const { admin } =
    await authenticate.admin(request);

  const url = new URL(request.url);

  const requestedPeriod =
    url.searchParams.get("period") || "today";

  const selectedPeriod = isValidPeriod(
    requestedPeriod,
  )
    ? requestedPeriod
    : "today";

  const financeData = await getFinanceSales(
    admin,
    selectedPeriod,
  );

  const orders = financeData.orders;

  const grossProductSales =
    calculateGrossProductSales(orders);

  const discounts = sumMoney(
    orders,
    "totalDiscountsSet",
  );

  const originalNetProductSales = sumMoney(
    orders,
    "subtotalPriceSet",
  );

  const currentNetProductSales = sumMoney(
    orders,
    "currentSubtotalPriceSet",
  );

  const returnsAndEdits = Math.max(
    0,
    originalNetProductSales -
      currentNetProductSales,
  );

  const shippingCollected = sumMoney(
    orders,
    "currentShippingPriceSet",
  );

  const taxes = sumMoney(
    orders,
    "currentTotalTaxSet",
  );

  const totalSales = sumMoney(
    orders,
    "currentTotalPriceSet",
  );

  const metrics = {
    orders: orders.length,
    unitsSold: countUnitsSold(orders),

    grossProductSales,
    discounts,
    returnsAndEdits,
    netProductSales: currentNetProductSales,

    shippingCollected,
    taxes,
    totalSales,
  };

  metrics.averageOrderValue =
    metrics.orders > 0
      ? metrics.totalSales / metrics.orders
      : 0;

  return {
    selectedPeriod,
    period: financeData.period,
    timezone: financeData.timezone,
    currencyCode: financeData.currencyCode,
    metrics,
    orders,
  };
};

function MetricCard({
  label,
  value,
  description,
  currencyCode,
  isMoney = true,
}) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
    >
      <s-paragraph>{label}</s-paragraph>

      <s-heading>
        {isMoney
          ? money(value, currencyCode)
          : value}
      </s-heading>

      <s-paragraph>{description}</s-paragraph>
    </s-box>
  );
}

function WaterfallRow({
  label,
  value,
  currencyCode,
  prefix = "",
  strong = false,
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "20px",
        padding: "10px 0",
        borderBottom: "1px solid #e1e3e5",
        fontWeight: strong ? 700 : 400,
      }}
    >
      <span>
        {prefix}
        {label}
      </span>

      <span>
        {money(value, currencyCode)}
      </span>
    </div>
  );
}

export default function FinanceDashboard() {
  const {
    selectedPeriod,
    period,
    timezone,
    currencyCode,
    metrics,
    orders,
  } = useLoaderData();

  return (
    <s-page heading="Finance">
      <s-section heading="Performance Period">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "8px",
            marginBottom: "16px",
          }}
        >
          {PERIODS.map((option) => {
            const isSelected =
              selectedPeriod === option.key;

            return (
              <Link
                key={option.key}
                to={`/app/finance?period=${option.key}`}
                style={{
                  display: "inline-block",
                  padding: "8px 14px",
                  borderRadius: "8px",
                  border: isSelected
                    ? "1px solid #202223"
                    : "1px solid #c9cccf",
                  background: isSelected
                    ? "#202223"
                    : "#ffffff",
                  color: isSelected
                    ? "#ffffff"
                    : "#202223",
                  textDecoration: "none",
                  fontWeight: isSelected
                    ? 600
                    : 400,
                }}
              >
                {option.label}
              </Link>
            );
          })}
        </div>

        <s-paragraph>
          {period.label}
        </s-paragraph>

        <s-paragraph>
          Shopify activity based on the store
          timezone: {timezone}.
        </s-paragraph>
      </s-section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "16px",
          marginBottom: "16px",
        }}
      >
        <MetricCard
          label="Total Sales"
          value={metrics.totalSales}
          description="Products, shipping and tax"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Net Product Sales"
          value={metrics.netProductSales}
          description="Products after discounts and returns"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Orders"
          value={metrics.orders}
          description="Orders processed during the period"
          currencyCode={currencyCode}
          isMoney={false}
        />

        <MetricCard
          label="Average Order Value"
          value={metrics.averageOrderValue}
          description="Total sales divided by orders"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Units Sold"
          value={metrics.unitsSold}
          description="Current item quantities"
          currencyCode={currencyCode}
          isMoney={false}
        />

        <MetricCard
          label="Gross Product Sales"
          value={metrics.grossProductSales}
          description="Original item prices before discounts"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Discounts"
          value={metrics.discounts}
          description="Discounts applied to selected orders"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Returns / Order Edits"
          value={metrics.returnsAndEdits}
          description="Reduction from original to current subtotal"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Shipping Collected"
          value={metrics.shippingCollected}
          description="Shipping charged to customers"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Taxes Collected"
          value={metrics.taxes}
          description="Taxes are not business revenue"
          currencyCode={currencyCode}
        />
      </div>

      <s-section heading="Sales Breakdown">
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
        >
          <WaterfallRow
            label="Gross Product Sales"
            value={metrics.grossProductSales}
            currencyCode={currencyCode}
          />

          <WaterfallRow
            label="Discounts"
            value={metrics.discounts}
            currencyCode={currencyCode}
            prefix="− "
          />

          <WaterfallRow
            label="Returns / Order Edits"
            value={metrics.returnsAndEdits}
            currencyCode={currencyCode}
            prefix="− "
          />

          <WaterfallRow
            label="Net Product Sales"
            value={metrics.netProductSales}
            currencyCode={currencyCode}
            strong
          />

          <WaterfallRow
            label="Shipping Collected"
            value={metrics.shippingCollected}
            currencyCode={currencyCode}
            prefix="+ "
          />

          <WaterfallRow
            label="Taxes Collected"
            value={metrics.taxes}
            currencyCode={currencyCode}
            prefix="+ "
          />

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "20px",
              paddingTop: "14px",
              fontWeight: 700,
              fontSize: "18px",
            }}
          >
            <span>Total Sales</span>

            <span>
              {money(
                metrics.totalSales,
                currencyCode,
              )}
            </span>
          </div>
        </s-box>
      </s-section>

      <s-section heading="Orders Included">
        {orders.length > 0 ? (
          <s-stack direction="block" gap="base">
            {orders.map((order) => {
              const orderUnits =
                order.lineItems?.nodes?.reduce(
                  (total, lineItem) =>
                    total +
                    Number(
                      lineItem.currentQuantity ||
                        0,
                    ),
                  0,
                ) || 0;

              return (
                <s-box
                  key={order.id}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-paragraph>
                    <strong>{order.name}</strong>
                  </s-paragraph>

                  <s-paragraph>
                    {money(
                      order
                        .currentTotalPriceSet
                        ?.shopMoney?.amount,
                      currencyCode,
                    )}{" "}
                    · {orderUnits} units ·{" "}
                    {
                      order.displayFinancialStatus
                    }
                  </s-paragraph>

                  {order.cancelledAt ? (
                    <s-paragraph>
                      ⚠ This order was cancelled.
                    </s-paragraph>
                  ) : null}
                </s-box>
              );
            })}
          </s-stack>
        ) : (
          <s-paragraph>
            No orders were processed during{" "}
            {period.label}.
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Data Quality">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            ✅ Order totals come directly from
            Shopify.
          </s-paragraph>

          <s-paragraph>
            ✅ Gross sales, discounts, current net
            product sales, shipping and taxes are
            displayed separately.
          </s-paragraph>

          <s-paragraph>
            ✅ Reporting periods use the Shopify
            store&apos;s timezone.
          </s-paragraph>

          <s-paragraph>
            ⚠ Returns currently reflect changes to
            orders originally processed during the
            selected period. A refund issued today
            against an older order is not yet assigned
            to today.
          </s-paragraph>

          <s-paragraph>
            ⚠ Product COGS has not been calculated.
          </s-paragraph>

          <s-paragraph>
            ⚠ Outbound shipping expense and payment
            fees are still missing.
          </s-paragraph>

          <s-paragraph>
            ⚠ Meta advertising spend has not been
            connected.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(
    useRouteError(),
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};