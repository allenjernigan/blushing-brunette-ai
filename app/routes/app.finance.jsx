import {
  Form,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  useRouteError,
} from "react-router";
import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import {
  syncOrders,
  syncProducts,
} from "../services/sync.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getFinanceSales } from "../services/finance.server";
import {
  getOrCreateShopSettings,
  serializeShopSettings,
} from "../services/settings.server";
import {
  getActiveChannelPreset,
  getPresetChannels,
} from "../services/financeFilters";
import { calculateWaterfallTotal } from "../services/financeShopifyql";
import {
  getFinanceRevalidationAction,
  parseFinanceRequestUrl,
} from "../services/financeRequest";
import prisma from "../db.server";

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
    key: "last-7-days",
    label: "Last 7 Days",
  },
  {
    key: "month-to-date",
    label: "Month to Date",
  },
  {
    key: "last-month",
    label: "Last Month",
  },
  {
    key: "custom",
    label: "Custom Range",
  },
];

function money(value, currencyCode = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
  }).format(Number(value || 0));
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

function getOrderCurrentUnits(order) {
  return countUnitsSold([order]);
}

function classifyShippingEligibility(order) {
  const hasCurrentUnits = getOrderCurrentUnits(order) > 0;

  if (!order.isPos) {
    return !order.cancelledAt && hasCurrentUnits
      ? "ecommerce-shipment"
      : "excluded";
  }

  if (order.cancelledAt || !hasCurrentUnits) {
    return "excluded";
  }

  const isFulfilled = [
    "FULFILLED",
    "PARTIALLY_FULFILLED",
  ].includes(order.displayFulfillmentStatus);

  if (order.requiresShipping === true && isFulfilled) {
    return "pos-shipment";
  }

  if (
    order.requiresShipping === false &&
    order.retailLocation
  ) {
    return "pos-walkout";
  }

  return "ambiguous";
}

function calculateEstimatedShipping(orders, settings) {
  const counts = {
    ecommerceShipments: 0,
    posShipments: 0,
    posWalkouts: 0,
    ambiguous: 0,
  };

  for (const order of orders) {
    const eligibility = classifyShippingEligibility(order);

    if (eligibility === "ecommerce-shipment") {
      counts.ecommerceShipments += 1;
    } else if (eligibility === "pos-shipment") {
      counts.posShipments += 1;
    } else if (eligibility === "pos-walkout") {
      counts.posWalkouts += 1;
    } else if (eligibility === "ambiguous") {
      counts.ambiguous += 1;
    }
  }

  const ecommerceCost = Number(
    settings.ecommerceShippingCost,
  );
  const posCost = Number(settings.posShippingCost);

  return {
    ...counts,
    ecommerceCost,
    posCost,
    expense:
      counts.ecommerceShipments * ecommerceCost +
      counts.posShipments * posCost,
  };
}

const RELEVANT_TRANSACTION_KINDS = new Set([
  "SALE",
  "CAPTURE",
  "REFUND",
]);

const KNOWN_TRANSACTION_KINDS = new Set([
  ...RELEVANT_TRANSACTION_KINDS,
  "AUTHORIZATION",
  "VOID",
  "CHANGE",
  "EMV_AUTHORIZATION",
  "SUGGESTED_REFUND",
]);

const ZERO_FEE_GATEWAY_TERMS = [
  "cash",
  "gift card",
  "store credit",
  "manual",
  "bank deposit",
  "money order",
  "cash on delivery",
  "cod",
  "complimentary",
];

function transactionAmount(transaction) {
  return Number(
    transaction.amountSet?.shopMoney?.amount || 0,
  );
}

function signedTransactionAmount(transaction) {
  const amount = transactionAmount(transaction);

  return transaction.kind === "REFUND"
    ? -Math.abs(amount)
    : amount;
}

function actualTransactionFee(transaction) {
  return (transaction.fees || []).reduce(
    (total, fee) =>
      total +
      Number(fee.amount?.amount || 0) +
      Number(fee.taxAmount?.amount || 0),
    0,
  );
}

function gatewayName(transaction) {
  return transaction.formattedGateway?.trim() || "Unknown";
}

function isKnownZeroFeeMethod(transaction) {
  if (transaction.manualPaymentGateway === true) return true;

  const normalizedGateway = gatewayName(transaction).toLowerCase();

  return ZERO_FEE_GATEWAY_TERMS.some((term) =>
    normalizedGateway.includes(term),
  );
}

function getProcessingAssumptions(isPos, settings) {
  if (isPos) {
    return {
      percentage: Number(settings.posProcessingPercentage),
      fixedFee: Number(settings.posProcessingFixedFee),
    };
  }

  return {
    percentage: Number(
      settings.ecommerceProcessingPercentage,
    ),
    fixedFee: Number(settings.ecommerceProcessingFixedFee),
  };
}

function addPaymentMethodCoverage(
  paymentMethods,
  order,
  transaction,
  actualFees = 0,
  estimatedFees = 0,
) {
  const gateway = gatewayName(transaction);
  const key = `${order.salesChannel}::${gateway}`;
  const existing = paymentMethods.get(key) || {
    gateway,
    channel: order.salesChannelLabel,
    orderIds: new Set(),
    salesAmount: 0,
    actualFees: 0,
    estimatedFees: 0,
  };

  existing.orderIds.add(order.id);
  existing.salesAmount += signedTransactionAmount(transaction);
  existing.actualFees += actualFees;
  existing.estimatedFees += estimatedFees;
  paymentMethods.set(key, existing);
}

function calculateProcessingFees(orders, settings) {
  const paymentMethods = new Map();
  const unexpectedKinds = new Set();
  const unexpectedStatuses = new Set();
  const ambiguousGateways = new Set();
  let actualFees = 0;
  let estimatedFees = 0;
  let ordersWithActualFees = 0;
  let ordersEstimated = 0;
  let ordersExcluded = 0;
  let ambiguousOrders = 0;
  let ordersWithNoFeeData = 0;
  let partialActualCoverageOrders = 0;

  for (const order of orders) {
    const transactions = order.transactions || [];

    for (const transaction of transactions) {
      if (!KNOWN_TRANSACTION_KINDS.has(transaction.kind)) {
        unexpectedKinds.add(transaction.kind);
      }

      if (transaction.status !== "SUCCESS") {
        unexpectedStatuses.add(
          `${transaction.kind}:${transaction.status}`,
        );
      }
    }

    const relevantTransactions = transactions.filter(
      (transaction) =>
        !transaction.test &&
        transaction.status === "SUCCESS" &&
        RELEVANT_TRANSACTION_KINDS.has(transaction.kind),
    );
    const feeTransactions = relevantTransactions.filter(
      (transaction) => transaction.fees?.length > 0,
    );

    if (feeTransactions.length > 0) {
      ordersWithActualFees += 1;

      if (feeTransactions.length < relevantTransactions.length) {
        partialActualCoverageOrders += 1;
      }

      for (const transaction of relevantTransactions) {
        const transactionFee = actualTransactionFee(transaction);

        actualFees += transactionFee;
        addPaymentMethodCoverage(
          paymentMethods,
          order,
          transaction,
          transactionFee,
          0,
        );
      }

      continue;
    }

    if (relevantTransactions.length > 0) {
      ordersWithNoFeeData += 1;
    }

    const chargeTransactions = relevantTransactions.filter(
      (transaction) =>
        transaction.kind === "SALE" ||
        transaction.kind === "CAPTURE",
    );

    if (chargeTransactions.length === 0) {
      ambiguousOrders += 1;
      ambiguousGateways.add(
        transactions.length > 0
          ? gatewayName(transactions[0])
          : "No transaction data",
      );
      continue;
    }

    const zeroFeeTransactions = chargeTransactions.filter(
      isKnownZeroFeeMethod,
    );
    const ambiguousTransactions = chargeTransactions.filter(
      (transaction) =>
        !isKnownZeroFeeMethod(transaction) &&
        gatewayName(transaction) === "Unknown",
    );

    if (ambiguousTransactions.length > 0) {
      ambiguousOrders += 1;

      for (const transaction of ambiguousTransactions) {
        ambiguousGateways.add(gatewayName(transaction));
        addPaymentMethodCoverage(
          paymentMethods,
          order,
          transaction,
        );
      }

      continue;
    }

    if (zeroFeeTransactions.length === chargeTransactions.length) {
      ordersExcluded += 1;

      for (const transaction of zeroFeeTransactions) {
        addPaymentMethodCoverage(
          paymentMethods,
          order,
          transaction,
        );
      }

      continue;
    }

    const estimableTransactions = chargeTransactions.filter(
      (transaction) => !isKnownZeroFeeMethod(transaction),
    );
    const assumptions = getProcessingAssumptions(
      order.isPos,
      settings,
    );
    const percentageRate = assumptions.percentage / 100;
    const percentageFees = estimableTransactions.reduce(
      (total, transaction) =>
        total + transactionAmount(transaction) * percentageRate,
      0,
    );
    const orderEstimatedFees =
      percentageFees + assumptions.fixedFee;

    estimatedFees += orderEstimatedFees;
    ordersEstimated += 1;

    estimableTransactions.forEach((transaction, index) => {
      const transactionEstimatedFee =
        transactionAmount(transaction) * percentageRate +
        (index === 0 ? assumptions.fixedFee : 0);

      addPaymentMethodCoverage(
        paymentMethods,
        order,
        transaction,
        0,
        transactionEstimatedFee,
      );
    });

    for (const transaction of zeroFeeTransactions) {
      addPaymentMethodCoverage(
        paymentMethods,
        order,
        transaction,
      );
    }
  }

  return {
    actualFees,
    estimatedFees,
    totalFees: actualFees + estimatedFees,
    ordersWithActualFees,
    ordersEstimated,
    ordersExcluded,
    ambiguousOrders,
    ordersWithNoFeeData,
    partialActualCoverageOrders,
    unexpectedKinds: Array.from(unexpectedKinds).sort(),
    unexpectedStatuses: Array.from(
      unexpectedStatuses,
    ).sort(),
    ambiguousGateways: Array.from(ambiguousGateways).sort(),
    paymentMethods: Array.from(paymentMethods.values())
      .map((method) => ({
        gateway: method.gateway,
        channel: method.channel,
        orderCount: method.orderIds.size,
        salesAmount: method.salesAmount,
        actualFees: method.actualFees,
        estimatedFees: method.estimatedFees,
      }))
      .sort((left, right) =>
        left.channel === right.channel
          ? right.salesAmount - left.salesAmount
          : left.channel.localeCompare(right.channel),
      ),
  };
}

function buildFinanceSummary(
  orders,
  productCosts,
  settings,
  shopifyMetrics,
) {
  const profitSales = productCosts.isComplete
    ? shopifyMetrics.netSales
    : productCosts.knownCostSales;
  const grossProfit = profitSales - productCosts.knownCogs;
  const grossMargin =
    profitSales > 0
      ? (grossProfit / profitSales) * 100
      : 0;
  const estimatedShipping = calculateEstimatedShipping(
    orders,
    settings,
  );
  const processingFees = calculateProcessingFees(
    orders,
    settings,
  );
  const contributionProfit =
    grossProfit -
    estimatedShipping.expense -
    processingFees.totalFees;
  // ShopifyQL Net Sales is the revenue base and contribution-margin
  // denominator. Customer shipping charges are revenue and are not subtracted.
  const contributionMargin =
    shopifyMetrics.netSales > 0
      ? (contributionProfit / shopifyMetrics.netSales) * 100
      : 0;

  const metrics = {
    ...shopifyMetrics,
    unitsSold: countUnitsSold(orders),
  };

  return {
    metrics,
    profitability: {
      ...productCosts,
      grossProfit,
      grossMargin,
      estimatedShipping,
      estimatedShippingExpense: estimatedShipping.expense,
      processingFees,
      contributionProfit,
      contributionMargin,
    },
  };
}
export const action = async ({ request }) => {
  const { admin, session } =
    await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (
  intent !== "sync-products" &&
  intent !== "sync-orders"
) {
  return {
    success: false,
    error: "Unknown finance action.",
  };
}
  try {
    if (intent === "sync-products") {
  return {
    syncType: "products",
    ...(await syncProducts(
      admin,
      session.shop,
    )),
  };
}

return {
  syncType: "orders",
  ...(await syncOrders(
    admin,
    session.shop,
  )),
};
  } catch (error) {
    console.error("Product sync failed", error);

    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Product sync failed.",
    };
  }
};
export const loader = async ({ request }) => {
const { admin, session } =
  await authenticate.admin(request);

  const {
    selectedPeriod,
    customStart,
    customEnd,
    requestedChannels,
  } = parseFinanceRequestUrl(request.url);
  const savedSettings = serializeShopSettings(
    await getOrCreateShopSettings(session.shop),
  );

  const financeData = await getFinanceSales(
    admin,
    {
      periodKey: selectedPeriod,
      customStart,
      customEnd,
      requestedChannels,
    },
  );
  const [
  missingCostCount,
  zeroCostCount,
  rawCostIssues,
] = await Promise.all([
  prisma.variant.count({
    where: {
      shop: session.shop,
      costStatus: "MISSING",
    },
  }),

  prisma.variant.count({
    where: {
      shop: session.shop,
      costStatus: "ZERO",
    },
  }),

  prisma.variant.findMany({
    where: {
      shop: session.shop,
      costStatus: {
        in: ["MISSING", "ZERO"],
      },
    },

    orderBy: [
      {
        costStatus: "asc",
      },
      {
        updatedAt: "desc",
      },
    ],

    take: 50,

    select: {
      id: true,
      title: true,
      sku: true,
      price: true,
      inventoryQuantity: true,
      costStatus: true,

      product: {
        select: {
          title: true,
        },
      },
    },
  }),
]);

const costIssues = rawCostIssues.map(
  (variant) => ({
    id: variant.id,
    productTitle: variant.product.title,
    variantTitle: variant.title,
    sku: variant.sku,
    price:
      variant.price === null
        ? null
        : Number(variant.price),
    inventoryQuantity:
      variant.inventoryQuantity,
    costStatus: variant.costStatus,
  }),
);

const costIssueSummary = {
  missing: missingCostCount,
  zero: zeroCostCount,
  total: missingCostCount + zeroCostCount,
};

  const orders = financeData.orders;
  const { metrics, profitability } =
    buildFinanceSummary(
      orders,
      financeData.productCosts,
      savedSettings,
      financeData.shopifyMetrics,
    );
  const channelBreakdown = financeData.channelBreakdown
    .map((entry) => {
      const shopify = entry.shopify || {
        grossSales: 0,
        discounts: 0,
        salesReversals: 0,
        netSales: 0,
        shippingCharges: 0,
        taxes: 0,
        duties: 0,
        additionalFees: 0,
        totalSales: 0,
        orders: 0,
        averageOrderValue: 0,
      };
      const operational = buildFinanceSummary(
        entry.orders,
        entry.productCosts,
        savedSettings,
        shopify,
      );
      const totalSales = shopify.totalSales;
      const orderCount = shopify.orders;

      return {
        key: entry.channel.key,
        label: entry.channel.label,
        totalSales,
        orders: orderCount,
        averageOrderValue: shopify.averageOrderValue,
        grossSales: shopify.grossSales,
        discounts: shopify.discounts,
        salesReversals: shopify.salesReversals,
        netSales: shopify.netSales,
        shippingCharges: shopify.shippingCharges,
        taxes: shopify.taxes,
        productCogs: operational.profitability.knownCogs,
        grossProfit: operational.profitability.grossProfit,
        contributionProfit:
          operational.profitability.contributionProfit,
        hasOrderCoverage: entry.orders.length > 0,
        hasShopifyCoverage: entry.shopify !== null,
      };
    })
    .sort((left, right) => right.totalSales - left.totalSales);

return {
  selectedPeriod,
  selectedChannels: financeData.selectedChannels,
  channels: financeData.channels,
  customStart,
  customEnd,
  dateError: financeData.dateError,
  period: financeData.period,
  timezone: financeData.timezone,
  currencyCode: financeData.currencyCode,
  metrics,
  orders,
  costIssues,
  costIssueSummary,
  profitability,
  channelBreakdown,
  unexpectedSourceNames:
    financeData.unexpectedSourceNames,
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

MetricCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([
    PropTypes.number,
    PropTypes.string,
  ]).isRequired,
  description: PropTypes.string.isRequired,
  currencyCode: PropTypes.string.isRequired,
  isMoney: PropTypes.bool,
};

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

WaterfallRow.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([
    PropTypes.number,
    PropTypes.string,
  ]).isRequired,
  currencyCode: PropTypes.string.isRequired,
  prefix: PropTypes.string,
  strong: PropTypes.bool,
};

function ChannelBreakdownTable({ rows, currencyCode }) {
  if (rows.length === 0) {
    return <s-paragraph>No channel sales were found for this period.</s-paragraph>;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "960px" }}>
        <thead>
          <tr>
            {["Channel", "Total sales", "Orders", "AOV", "Net sales", "Sales reversals", "Shipping charges", "Product COGS", "Gross profit", "Contribution profit"].map((heading) => (
              <th key={heading} scope="col" style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #c9cccf" }}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" style={{ padding: "10px", textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                {row.label}
              </th>
              <td>{row.hasShopifyCoverage ? money(row.totalSales, currencyCode) : "Unavailable"}</td>
              <td>{row.hasShopifyCoverage ? row.orders : "Unavailable"}</td>
              <td>{row.hasShopifyCoverage ? money(row.averageOrderValue, currencyCode) : "Unavailable"}</td>
              <td>{row.hasShopifyCoverage ? money(row.netSales, currencyCode) : "Unavailable"}</td>
              <td>{row.hasShopifyCoverage ? money(row.salesReversals, currencyCode) : "Unavailable"}</td>
              <td>{row.hasShopifyCoverage ? money(row.shippingCharges, currencyCode) : "Unavailable"}</td>
              <td>{row.hasOrderCoverage ? money(row.productCogs, currencyCode) : "Unavailable"}</td>
              <td>{row.hasOrderCoverage ? money(row.grossProfit, currencyCode) : "Unavailable"}</td>
              <td>{row.hasOrderCoverage ? money(row.contributionProfit, currencyCode) : "Unavailable"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

ChannelBreakdownTable.propTypes = {
  rows: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      totalSales: PropTypes.number.isRequired,
      orders: PropTypes.number.isRequired,
      averageOrderValue: PropTypes.number.isRequired,
      netSales: PropTypes.number.isRequired,
      grossSales: PropTypes.number.isRequired,
      discounts: PropTypes.number.isRequired,
      salesReversals: PropTypes.number.isRequired,
      shippingCharges: PropTypes.number.isRequired,
      productCogs: PropTypes.number.isRequired,
      grossProfit: PropTypes.number.isRequired,
      contributionProfit: PropTypes.number.isRequired,
      hasOrderCoverage: PropTypes.bool.isRequired,
      hasShopifyCoverage: PropTypes.bool.isRequired,
    }),
  ).isRequired,
  currencyCode: PropTypes.string.isRequired,
};

export default function FinanceDashboard() {  const actionData = useActionData();
  const location = useLocation();
  const navigation = useNavigation();
  const revalidationAction = getFinanceRevalidationAction(location);

  const activeIntent =
  navigation.formData?.get("intent");

const isSyncingProducts =
  navigation.state === "submitting" &&
  activeIntent === "sync-products";

const isSyncingOrders =
  navigation.state === "submitting" &&
  activeIntent === "sync-orders";

 const {
  selectedPeriod,
  selectedChannels,
  channels,
  customStart,
  customEnd,
  dateError,
  period,
  timezone,
  currencyCode,
  metrics,
  orders,
  costIssues,
  costIssueSummary,
  profitability,
  channelBreakdown,
  unexpectedSourceNames,
} = useLoaderData();
  const [filterPeriod, setFilterPeriod] = useState(selectedPeriod);
  const [channelSelection, setChannelSelection] = useState(
    selectedChannels,
  );
  useEffect(() => {
    setFilterPeriod(selectedPeriod);
    setChannelSelection(selectedChannels);
  }, [selectedChannels, selectedPeriod]);
  const activePreset = getActiveChannelPreset(
    channelSelection,
    channels,
  );
  const waterfallDifference =
    calculateWaterfallTotal(metrics) - metrics.totalSales;

  function toggleChannel(channelKey) {
    setChannelSelection((current) =>
      current.includes(channelKey)
        ? current.filter((key) => key !== channelKey)
        : [...current, channelKey],
    );
  }

  return (
    <s-page heading="Finance">
              <s-section heading="Catalog Sync">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Import Shopify products, variants,
            inventory quantities, and product costs
            into the local finance database.
          </s-paragraph>

<Form method="post" action={revalidationAction}>
  <input
    type="hidden"
    name="intent"
    value="sync-products"
  />

  <button
    type="submit"
    disabled={
      isSyncingProducts || isSyncingOrders
    }
    style={{
      padding: "10px 16px",
      borderRadius: "8px",
      border: "none",
      background: "#202223",
      color: "#ffffff",
      fontWeight: 600,
      cursor:
        isSyncingProducts || isSyncingOrders
          ? "not-allowed"
          : "pointer",
      opacity:
        isSyncingProducts || isSyncingOrders
          ? 0.6
          : 1,
    }}
  >
    {isSyncingProducts
      ? "Syncing Products..."
      : "Sync Products"}
  </button>
</Form>

<Form method="post" action={revalidationAction}>
  <input
    type="hidden"
    name="intent"
    value="sync-orders"
  />

  <button
    type="submit"
    disabled={
      isSyncingProducts || isSyncingOrders
    }
    style={{
      padding: "10px 16px",
      borderRadius: "8px",
      border: "1px solid #202223",
      background: "#ffffff",
      color: "#202223",
      fontWeight: 600,
      cursor:
        isSyncingProducts || isSyncingOrders
          ? "not-allowed"
          : "pointer",
      opacity:
        isSyncingProducts || isSyncingOrders
          ? 0.6
          : 1,
    }}
  >
    {isSyncingOrders
      ? "Syncing Orders..."
      : "Sync Orders"}
  </button>
</Form>

{actionData?.success &&
actionData.syncType === "products" ? (
  <s-box
    padding="base"
    borderWidth="base"
    borderRadius="base"
  >
    <s-paragraph>
      Product sync completed.
    </s-paragraph>

    <s-paragraph>
      Products: {actionData.syncedProducts}
    </s-paragraph>

    <s-paragraph>
      Variants: {actionData.syncedVariants}
    </s-paragraph>

    <s-paragraph>
      Valid costs: {actionData.validCostVariants}
    </s-paragraph>

    <s-paragraph>
      Missing costs: {actionData.missingCostVariants}
    </s-paragraph>

    <s-paragraph>
      Zero costs: {actionData.zeroCostVariants}
    </s-paragraph>
  </s-box>
) : null}

{actionData?.success &&
actionData.syncType === "orders" ? (
  <s-box
    padding="base"
    borderWidth="base"
    borderRadius="base"
  >
    <s-paragraph>
      Order sync completed.
    </s-paragraph>

    <s-paragraph>
      Orders: {actionData.syncedOrders}
    </s-paragraph>

    <s-paragraph>
      Order lines: {actionData.syncedOrderLines}
    </s-paragraph>

    <s-paragraph>
      Complete COGS orders: {actionData.completeCogsOrders}
    </s-paragraph>

    <s-paragraph>
      Incomplete COGS orders: {actionData.incompleteCogsOrders}
    </s-paragraph>
  </s-box>
) : null}

{actionData?.error ? (
  <s-box
    padding="base"
    borderWidth="base"
    borderRadius="base"
  >
    <s-paragraph>
      ⚠ {actionData.error}
    </s-paragraph>
  </s-box>
) : null}
        </s-stack>
      </s-section>
      <s-section heading="Finance Filters">
        <Form method="get" action="/app/finance">
          <div style={{ display: "grid", gap: "16px" }}>
            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend style={{ fontWeight: 600 }}>Date range</legend>
              <input type="hidden" name="period" value={filterPeriod} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" }}>
                {PERIODS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setFilterPeriod(option.key)}
                    aria-pressed={filterPeriod === option.key}
                    style={{
                      padding: "8px 12px",
                      borderRadius: "8px",
                      border: "1px solid #8c9196",
                      background: filterPeriod === option.key ? "#202223" : "#ffffff",
                      color: filterPeriod === option.key ? "#ffffff" : "#202223",
                      fontWeight: filterPeriod === option.key ? 600 : 400,
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>

            {filterPeriod === "custom" ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "12px" }}>
                <label>
                  Start date
                  <input key={`start-${customStart}`} name="start" type="date" defaultValue={customStart} />
                </label>
                <label>
                  End date
                  <input key={`end-${customEnd}`} name="end" type="date" defaultValue={customEnd} />
                </label>
              </div>
            ) : null}

            <div>
              <strong>Sales channels</strong>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" }}>
                {[
                  ["all-except-pos", "All channels except POS"],
                  ["pos-only", "POS only"],
                  ["all", "All channels"],
                ].map(([preset, label]) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setChannelSelection(getPresetChannels(preset, channels))}
                    aria-pressed={activePreset === preset}
                  >
                    {label}
                  </button>
                ))}
                <button type="button" onClick={() => setChannelSelection(channels.map((channel) => channel.key))}>
                  Select all
                </button>
                <button type="button" onClick={() => setChannelSelection([])}>
                  Clear all
                </button>
              </div>
              <div style={{ display: "grid", gap: "8px", marginTop: "12px" }}>
                {channels.map((channel) => (
                  <label key={channel.key}>
                    <input
                      type="checkbox"
                      name="channel"
                      value={channel.key}
                      checked={channelSelection.includes(channel.key)}
                      onChange={() => toggleChannel(channel.key)}
                    />{" "}
                    {channel.label}{channel.isPos ? " (POS)" : ""}
                  </label>
                ))}
                {channelSelection.length === 0 ? (
                  <input type="hidden" name="channel" value="" />
                ) : null}
              </div>
            </div>

            <button type="submit" style={{ justifySelf: "start" }}>
              Apply filters
            </button>
          </div>
        </Form>

        {dateError ? <s-paragraph>⚠ {dateError}</s-paragraph> : null}
        <s-paragraph>{period.label}</s-paragraph>
        <s-paragraph>
          {selectedChannels.length} of {channels.length} channels selected. Dates use {timezone}.
        </s-paragraph>
        {selectedChannels.length === 0 ? (
          <s-paragraph>No sales channels are selected. Select one or more channels to populate the main metrics.</s-paragraph>
        ) : null}
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
          description="ShopifyQL products, shipping, taxes, duties, and fees"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Net Sales"
          value={metrics.netSales}
          description="ShopifyQL gross sales, discounts, and sales reversals"
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
          label="Gross Sales"
          value={metrics.grossSales}
          description="ShopifyQL sales before discounts and reversals"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Discounts"
          value={metrics.discounts}
          description="ShopifyQL discount value with its reported sign"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Sales Reversals"
          value={metrics.salesReversals}
          description="Refunds, returns, cancellations, and order edits"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Shipping Charges"
          value={metrics.shippingCharges}
          description="ShopifyQL shipping revenue charged to customers"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Taxes"
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
            label="Gross Sales"
            value={metrics.grossSales}
            currencyCode={currencyCode}
          />

          <WaterfallRow
            label="Discounts"
            value={metrics.discounts}
            currencyCode={currencyCode}
          />

          <WaterfallRow
            label="Sales Reversals"
            value={metrics.salesReversals}
            currencyCode={currencyCode}
          />

          <WaterfallRow
            label="= Net Sales"
            value={metrics.netSales}
            currencyCode={currencyCode}
            strong
          />

          <WaterfallRow
            label="Shipping Charges"
            value={metrics.shippingCharges}
            currencyCode={currencyCode}
            prefix="+ "
          />

          <WaterfallRow
            label="Taxes"
            value={metrics.taxes}
            currencyCode={currencyCode}
            prefix="+ "
          />

          {metrics.duties !== 0 ? (
            <WaterfallRow
              label="Duties"
              value={metrics.duties}
              currencyCode={currencyCode}
              prefix="+ "
            />
          ) : null}

          {metrics.additionalFees !== 0 ? (
            <WaterfallRow
              label="Additional Fees"
              value={metrics.additionalFees}
              currencyCode={currencyCode}
              prefix="+ "
            />
          ) : null}

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

      <s-section heading="Data Quality">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            ✅ Displayed sales metrics come directly from ShopifyQL.
          </s-paragraph>

          <s-paragraph>
            ✅ Sales reversals preserve ShopifyQL&apos;s negative sign and are not double-subtracted.
          </s-paragraph>

          <s-paragraph>
            ✅ Reporting periods use the Shopify
            store&apos;s timezone.
          </s-paragraph>

          <s-paragraph>
            ✅ Shipping Charges are customer revenue from ShopifyQL; Estimated Shipping Expense remains separate.
          </s-paragraph>

          {Math.abs(waterfallDifference) > 0.01 ? (
            <s-paragraph>
              ⚠ ShopifyQL waterfall components differ from Total Sales by {money(waterfallDifference, currencyCode)}.
            </s-paragraph>
          ) : (
            <s-paragraph>
              ✅ ShopifyQL waterfall components reconcile to Total Sales.
            </s-paragraph>
          )}

          <s-paragraph>
            ✅ Product COGS uses each sold variant&apos;s
            current Shopify inventory item unit cost.
          </s-paragraph>

          <s-paragraph>
            ✅ Processing fees use Shopify transaction
            fee data when available and labeled fallback
            estimates otherwise.
          </s-paragraph>

          <s-paragraph>
            ⚠ Meta advertising spend has not been
            connected.
          </s-paragraph>

          {profitability.processingFees
            .ordersWithNoFeeData > 0 ? (
            <s-paragraph>
              ⚠{" "}
              {
                profitability.processingFees
                  .ordersWithNoFeeData
              }{" "}
              included order
              {profitability.processingFees
                .ordersWithNoFeeData === 1
                ? ""
                : "s"}{" "}
              had successful payment transactions but no
              Shopify transaction fee records.
            </s-paragraph>
          ) : null}

          {profitability.processingFees.unexpectedKinds
            .length > 0 ? (
            <s-paragraph>
              ⚠ Unexpected transaction kinds:{" "}
              {profitability.processingFees.unexpectedKinds.join(
                ", ",
              )}
              .
            </s-paragraph>
          ) : null}

          {profitability.processingFees
            .unexpectedStatuses.length > 0 ? (
            <s-paragraph>
              ⚠ Non-success transaction statuses excluded
              from fee calculations:{" "}
              {profitability.processingFees.unexpectedStatuses.join(
                ", ",
              )}
              .
            </s-paragraph>
          ) : null}

          {profitability.processingFees.ambiguousGateways
            .length > 0 ? (
            <s-paragraph>
              ⚠ Unsupported or ambiguous payment
              gateways requiring review:{" "}
              {profitability.processingFees.ambiguousGateways.join(
                ", ",
              )}
              .
            </s-paragraph>
          ) : null}

          {profitability.processingFees
            .ordersWithActualFees > 0 &&
          profitability.processingFees.ordersEstimated >
            0 ? (
            <s-paragraph>
              ⚠ This selection contains mixed actual and
              estimated processing-fee coverage.
            </s-paragraph>
          ) : null}

          {profitability.processingFees
            .partialActualCoverageOrders > 0 ? (
            <s-paragraph>
              ⚠{" "}
              {
                profitability.processingFees
                  .partialActualCoverageOrders
              }{" "}
              order
              {profitability.processingFees
                .partialActualCoverageOrders === 1
                ? ""
                : "s"}{" "}
              had actual fees on only some qualifying
              transactions; no fallback was added.
            </s-paragraph>
          ) : null}

          {unexpectedSourceNames.length > 0 ? (
            <s-paragraph>
              ⚠ Nonstandard Shopify order source
              {unexpectedSourceNames.length === 1
                ? ""
                : "s"}{" "}
              found in Shopify source diagnostics:{" "}
              {unexpectedSourceNames.join(", ")}.
            </s-paragraph>
          ) : (
            <s-paragraph>
              ✅ No nonstandard Shopify order source names
              were found for this reporting period.
            </s-paragraph>
          )}
        </s-stack>
      </s-section>
<s-section heading="Product Cost Health">
  {costIssueSummary.total > 0 ? (
    <s-stack direction="block" gap="base">
      <s-box
        padding="base"
        borderWidth="base"
        borderRadius="base"
      >
        <s-heading>
          ⚠ {costIssueSummary.total} variant
          {costIssueSummary.total === 1
            ? ""
            : "s"}{" "}
          {costIssueSummary.total === 1
            ? "needs"
            : "need"}{" "}
          cost attention
        </s-heading>

        <s-paragraph>
          Missing costs:{" "}
          {costIssueSummary.missing}
        </s-paragraph>

        <s-paragraph>
          Zero costs: {costIssueSummary.zero}
        </s-paragraph>

        {costIssueSummary.missing > 0 ? (
          <s-paragraph>
            Profit is incomplete when sold variants do
            not have Shopify cost data.
          </s-paragraph>
        ) : null}

        {costIssueSummary.zero > 0 ? (
          <s-paragraph>
            Profit may be overstated when sold variants
            have a $0 Shopify cost.
          </s-paragraph>
        ) : null}
      </s-box>

      {costIssues.map((variant) => (
        <s-box
          key={variant.id}
          padding="base"
          borderWidth="base"
          borderRadius="base"
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "20px",
              flexWrap: "wrap",
            }}
          >
            <div>
              <s-paragraph>
                <strong>
                  {variant.productTitle}
                </strong>
              </s-paragraph>

              <s-paragraph>
                Variant: {variant.variantTitle}
              </s-paragraph>

              <s-paragraph>
                SKU: {variant.sku || "No SKU"}
              </s-paragraph>
            </div>

            <div>
              <s-paragraph>
                Price:{" "}
                {variant.price === null
                  ? "Not available"
                  : money(
                      variant.price,
                      currencyCode,
                    )}
              </s-paragraph>

              <s-paragraph>
                Inventory:{" "}
                {variant.inventoryQuantity ??
                  "Not tracked"}
              </s-paragraph>

              <s-paragraph>
                Status:{" "}
                <strong>
                  {variant.costStatus}
                </strong>
              </s-paragraph>
            </div>
          </div>
        </s-box>
      ))}

      {costIssueSummary.total >
      costIssues.length ? (
        <s-paragraph>
          Showing the first {costIssues.length} cost
          issues.
        </s-paragraph>
      ) : null}
    </s-stack>
  ) : (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
    >
      <s-paragraph>
        ✅ Every synced variant has a valid Shopify
        cost.
      </s-paragraph>
    </s-box>
  )}
</s-section>
<s-section heading="Sold Item Cost Warnings">
  {profitability.missingCostItems.length > 0 ||
  profitability.zeroCostVariantCount > 0 ? (
    <s-stack direction="block" gap="base">
      <s-box
        padding="base"
        borderWidth="base"
        borderRadius="base"
      >
        <s-heading>
          ⚠ Sold item cost attention required
        </s-heading>

        <s-paragraph>
          Missing costs:{" "}
          {profitability.missingCostItems.length} sold{" "}
          {profitability.missingCostItems.length === 1
            ? "variant"
            : "variants"}
        </s-paragraph>

        <s-paragraph>
          Zero costs:{" "}
          {profitability.zeroCostVariantCount} sold{" "}
          {profitability.zeroCostVariantCount === 1
            ? "variant"
            : "variants"}
        </s-paragraph>

        {profitability.missingCostItems.length > 0 ? (
          <s-paragraph>
            Profit is incomplete because cost data is
            unavailable for{" "}
            {profitability.missingCostItems.length} sold{" "}
            {profitability.missingCostItems.length === 1
              ? "variant"
              : "variants"}.{" "}
            {money(
              profitability.missingCostSales,
              currencyCode,
            )}{" "}
            in product sales is tied to missing-cost
            items. Missing costs are excluded from profit
            and margin, not treated as zero.
          </s-paragraph>
        ) : null}

        {profitability.zeroCostVariantCount > 0 ? (
          <s-paragraph>
            Profit may be overstated because{" "}
            {profitability.zeroCostVariantCount} sold{" "}
            {profitability.zeroCostVariantCount === 1
              ? "variant has"
              : "variants have"}{" "}
            a $0 Shopify cost.
          </s-paragraph>
        ) : null}
      </s-box>

      {profitability.missingCostItems.map((item) => (
        <s-box
          key={item.id}
          padding="base"
          borderWidth="base"
          borderRadius="base"
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "20px",
              flexWrap: "wrap",
            }}
          >
            <div>
              <s-paragraph>
                <strong>{item.productName}</strong>
              </s-paragraph>
              <s-paragraph>
                Variant: {item.variantName}
              </s-paragraph>
              <s-paragraph>
                SKU: {item.sku || "No SKU"}
              </s-paragraph>
            </div>

            <div>
              <s-paragraph>
                Quantity sold: {item.quantity}
              </s-paragraph>
              <s-paragraph>
                Sales:{" "}
                {money(item.salesAmount, currencyCode)}
              </s-paragraph>
            </div>
          </div>
        </s-box>
      ))}
    </s-stack>
  ) : (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
    >
      <s-paragraph>
        ✅ Every sold variant in this period has a
        Shopify inventory item cost.
      </s-paragraph>
    </s-box>
  )}
</s-section>

<s-section heading="Profitability">
  {orders.length === 0 ? (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
    >
      <s-paragraph>
        No sold items were found for this period.
      </s-paragraph>
    </s-box>
  ) : (
    <s-stack direction="block" gap="base">
      {!profitability.isComplete ? (
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
        >
          <s-heading>
            ⚠ Profit reporting is incomplete
          </s-heading>

          <s-paragraph>
            Profit and margin include only sales from
            items with known costs. Missing costs are not
            treated as zero.
          </s-paragraph>
        </s-box>
      ) : (
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
        >
          <s-paragraph>
            ✅ Every sold variant in this period has
            Shopify cost data.
          </s-paragraph>
        </s-box>
      )}

      {profitability.processingFees.ordersEstimated > 0 ||
      profitability.processingFees.ambiguousOrders > 0 ||
      profitability.processingFees
        .partialActualCoverageOrders > 0 ? (
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
        >
          <s-heading>
            ⚠ Processing-fee coverage is not fully actual
          </s-heading>
          {profitability.processingFees.ordersEstimated >
          0 ? (
            <s-paragraph>
              Contribution includes clearly labeled
              fallback estimates for{" "}
              {
                profitability.processingFees
                  .ordersEstimated
              }{" "}
              order
              {profitability.processingFees
                .ordersEstimated === 1
                ? ""
                : "s"}.
            </s-paragraph>
          ) : null}
          {profitability.processingFees.ambiguousOrders >
          0 ? (
            <s-paragraph>
              {
                profitability.processingFees
                  .ambiguousOrders
              }{" "}
              ambiguous order
              {profitability.processingFees
                .ambiguousOrders === 1
                ? ""
                : "s"}{" "}
              received no processing-fee estimate, so
              contribution may be overstated.
            </s-paragraph>
          ) : null}
          {profitability.processingFees
            .partialActualCoverageOrders > 0 ? (
            <s-paragraph>
              Some orders have actual fees on only part
              of their qualifying transaction activity;
              no fallback was layered onto those orders.
            </s-paragraph>
          ) : null}
        </s-box>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "16px",
        }}
      >
        <MetricCard
          label={
            profitability.isComplete
              ? "Product COGS"
              : "Known Product COGS"
          }
          value={profitability.knownCogs}
          description={
            profitability.isComplete
              ? "Shopify unit cost × current quantity"
              : "Only sold units with a Shopify cost"
          }
          currencyCode={currencyCode}
        />

        <MetricCard
          label={
            profitability.isComplete
              ? "Gross Profit Before Shipping, Payment Fees, and Ads"
              : "Known Gross Profit Before Shipping, Payment Fees, and Ads"
          }
          value={profitability.grossProfit}
          description={
            profitability.isComplete
              ? "ShopifyQL Net Sales minus product COGS"
              : "Known-cost item sales minus known product COGS"
          }
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Gross Margin Percentage"
          value={`${profitability.grossMargin.toFixed(
            1,
          )}%`}
          description={
            profitability.isComplete
              ? "Gross profit divided by ShopifyQL Net Sales"
              : "Based only on sold items with known costs"
          }
          currencyCode={currencyCode}
          isMoney={false}
        />

        <MetricCard
          label="Estimated Shipping Expense"
          value={profitability.estimatedShippingExpense}
          description={[
            profitability.estimatedShipping
              .ecommerceShipments,
            " non-POS × ",
            money(
              profitability.estimatedShipping
                .ecommerceCost,
              currencyCode,
            ),
            " + ",
            profitability.estimatedShipping.posShipments,
            " shipped POS × ",
            money(
              profitability.estimatedShipping.posCost,
              currencyCode,
            ),
          ].join("")}
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Actual Processing Fees"
          value={profitability.processingFees.actualFees}
          description="Shopify transaction fees plus fee tax"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Estimated Processing Fees"
          value={profitability.processingFees.estimatedFees}
          description="Fallback assumptions; never presented as actual"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Total Processing Fees"
          value={profitability.processingFees.totalFees}
          description="Actual fees plus clearly identified estimates"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Orders with Actual Fees"
          value={
            profitability.processingFees
              .ordersWithActualFees
          }
          description="Orders using Shopify transaction fee records"
          currencyCode={currencyCode}
          isMoney={false}
        />

        <MetricCard
          label="Orders Estimated"
          value={
            profitability.processingFees.ordersEstimated
          }
          description="Orders using channel-specific fallback assumptions"
          currencyCode={currencyCode}
          isMoney={false}
        />

        <MetricCard
          label="Known Zero-Fee / Manual Orders"
          value={
            profitability.processingFees.ordersExcluded
          }
          description="Manual or identified non-card payments"
          currencyCode={currencyCode}
          isMoney={false}
        />

        <MetricCard
          label="Ambiguous Orders Requiring Review"
          value={
            profitability.processingFees.ambiguousOrders
          }
          description="No estimate applied"
          currencyCode={currencyCode}
          isMoney={false}
        />

        <MetricCard
          label={
            profitability.isComplete
              ? "Contribution Profit"
              : "Known Contribution Profit"
          }
          value={profitability.contributionProfit}
          description="ShopifyQL Net Sales minus COGS, estimated shipping expense, and total processing fees"
          currencyCode={currencyCode}
        />

        <MetricCard
          label="Contribution Margin %"
          value={
            profitability.contributionMargin.toFixed(1) +
            "%"
          }
          description={
            profitability.isComplete
              ? "ShopifyQL Net Sales minus COGS, estimated shipping expense, and processing fees"
              : "Incomplete contribution divided by ShopifyQL Net Sales"
          }
          currencyCode={currencyCode}
          isMoney={false}
        />

        <MetricCard
          label="Units Missing Cost"
          value={profitability.unitsMissingCost}
          description="Sold units without a Shopify cost"
          currencyCode={currencyCode}
          isMoney={false}
        />

        <MetricCard
          label="Sales Tied to Missing-Cost Items"
          value={profitability.missingCostSales}
          description="Sales excluded from incomplete profit figures"
          currencyCode={currencyCode}
        />
      </div>
    </s-stack>
  )}
</s-section>

<s-section heading="Channel Breakdown">
  <s-paragraph>
    Shopify sales metrics are shown for every channel active in this period, regardless of the channel selection above. Cost and profit columns use matching order-level data.
  </s-paragraph>
  <ChannelBreakdownTable rows={channelBreakdown} currencyCode={currencyCode} />
</s-section>

<s-section heading="Payment Methods and Gateways">
  {profitability.processingFees.paymentMethods.length > 0 ? (
    <s-stack direction="block" gap="base">
      {profitability.processingFees.ordersWithActualFees >
        0 &&
      profitability.processingFees.ordersEstimated > 0 ? (
        <s-paragraph>
          ⚠ This period contains mixed actual and
          estimated processing-fee coverage.
        </s-paragraph>
      ) : null}

      {profitability.processingFees.paymentMethods.map(
        (method) => (
          <s-box
            key={method.channel + "::" + method.gateway}
            padding="base"
            borderWidth="base"
            borderRadius="base"
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(150px, 1fr))",
                gap: "12px",
              }}
            >
              <s-paragraph>
                <strong>{method.gateway}</strong>
              </s-paragraph>
              <s-paragraph>
                Channel:{" "}
                {method.channel}
              </s-paragraph>
              <s-paragraph>
                Orders: {method.orderCount}
              </s-paragraph>
              <s-paragraph>
                Sales:{" "}
                {money(method.salesAmount, currencyCode)}
              </s-paragraph>
              <s-paragraph>
                Actual fees:{" "}
                {money(method.actualFees, currencyCode)}
              </s-paragraph>
              <s-paragraph>
                Estimated fees:{" "}
                {money(method.estimatedFees, currencyCode)}
              </s-paragraph>
            </div>
          </s-box>
        ),
      )}
    </s-stack>
  ) : (
    <s-paragraph>
      No successful payment transactions were available
      for this selection.
    </s-paragraph>
  )}
</s-section>

<s-section heading="Estimated Shipping Eligibility">
  <div
    style={{
      display: "grid",
      gridTemplateColumns:
        "repeat(auto-fit, minmax(220px, 1fr))",
      gap: "16px",
    }}
  >
    <MetricCard
      label="Non-POS Orders Charged"
      value={
        profitability.estimatedShipping
          .ecommerceShipments
      }
      description="Eligible shipments from non-POS channels"
      currencyCode={currencyCode}
      isMoney={false}
    />
    <MetricCard
      label="POS Orders Charged"
      value={
        profitability.estimatedShipping.posShipments
      }
      description="POS orders reliably identified as shipped"
      currencyCode={currencyCode}
      isMoney={false}
    />
    <MetricCard
      label="POS Walk-Out Orders Excluded"
      value={
        profitability.estimatedShipping.posWalkouts
      }
      description="Ordinary POS orders not charged shipping"
      currencyCode={currencyCode}
      isMoney={false}
    />
    <MetricCard
      label="Ambiguous Orders Not Charged"
      value={profitability.estimatedShipping.ambiguous}
      description="Shipping status requires review"
      currencyCode={currencyCode}
      isMoney={false}
    />
  </div>
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
