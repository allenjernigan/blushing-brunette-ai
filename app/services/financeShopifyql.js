export const SHOPIFY_SALES_METRICS = [
  "gross_sales",
  "discounts",
  "sales_reversals",
  "net_sales",
  "shipping_charges",
  "taxes",
  "duties",
  "additional_fees",
  "total_sales",
  "orders",
  "average_order_value",
];

export function buildPeriodSalesQuery(period) {
  return `FROM sales
      SHOW ${SHOPIFY_SALES_METRICS.join(", ")}
      GROUP BY sales_channel
      SINCE ${period.startDate} UNTIL ${period.endDate}
      ORDER BY total_sales DESC`;
}

export function normalizeSalesRow(row) {
  return {
    grossSales: Number(row.gross_sales || 0),
    discounts: Number(row.discounts || 0),
    salesReversals: Number(row.sales_reversals || 0),
    netSales: Number(row.net_sales || 0),
    shippingCharges: Number(row.shipping_charges || 0),
    taxes: Number(row.taxes || 0),
    duties: Number(row.duties || 0),
    additionalFees: Number(row.additional_fees || 0),
    totalSales: Number(row.total_sales || 0),
    orders: Number(row.orders || 0),
    averageOrderValue: Number(row.average_order_value || 0),
  };
}

export function aggregateSalesMetrics(summaries, selectedChannels) {
  const selected = new Set(selectedChannels);
  const selectedSummaries = summaries.filter((summary) =>
    selected.has(summary.channel.key),
  );
  const totals = selectedSummaries.reduce(
      (result, summary) => {
        for (const key of [
          "grossSales",
          "discounts",
          "salesReversals",
          "netSales",
          "shippingCharges",
          "taxes",
          "duties",
          "additionalFees",
          "totalSales",
          "orders",
        ]) {
          result[key] += summary[key];
        }

        return result;
      },
      {
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
      },
    );

  return {
    ...totals,
    averageOrderValue:
      totals.orders > 0
        ? selectedSummaries.reduce(
              (total, summary) =>
                total + summary.averageOrderValue * summary.orders,
              0,
            ) / totals.orders
        : 0,
  };
}

export function calculateWaterfallTotal(metrics) {
  return (
    metrics.grossSales +
    metrics.discounts +
    metrics.salesReversals +
    metrics.shippingCharges +
    metrics.taxes +
    metrics.duties +
    metrics.additionalFees
  );
}
