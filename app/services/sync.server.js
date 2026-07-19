
import prisma from "../db.server";
import { fetchProducts } from "../shopify/products.server";
import { fetchHistoricalOrders } from "../shopify/orders.server";

function optionalDate(value) {
  return value ? new Date(value) : null;
}

function optionalDecimal(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return String(value);
}

function getCostDetails(variant) {
  const rawCost = variant.inventoryItem?.unitCost?.amount;

  if (
    rawCost === null ||
    rawCost === undefined ||
    rawCost === ""
  ) {
    return {
      unitCost: null,
      costStatus: "MISSING",
      costUpdatedAt: null,
    };
  }

  const numericCost = Number(rawCost);

  if (!Number.isFinite(numericCost)) {
    return {
      unitCost: null,
      costStatus: "MISSING",
      costUpdatedAt: null,
    };
  }

  if (numericCost <= 0) {
    return {
      unitCost: String(numericCost),
      costStatus: "ZERO",
      costUpdatedAt: new Date(),
    };
  }

  return {
    unitCost: String(numericCost),
    costStatus: "VALID",
    costUpdatedAt: new Date(),
  };
}

async function saveProduct(shop, shopifyProduct) {
  return prisma.product.upsert({
    where: {
      shop_shopifyProductId: {
        shop,
        shopifyProductId: shopifyProduct.id,
      },
    },

    update: {
      title: shopifyProduct.title,
      handle: shopifyProduct.handle || null,
      status: shopifyProduct.status || null,
      vendor: shopifyProduct.vendor || null,
      productType: shopifyProduct.productType || null,
      createdAtShopify: optionalDate(
        shopifyProduct.createdAt,
      ),
      updatedAtShopify: optionalDate(
        shopifyProduct.updatedAt,
      ),
      syncedAt: new Date(),
    },

    create: {
      shop,
      shopifyProductId: shopifyProduct.id,
      title: shopifyProduct.title,
      handle: shopifyProduct.handle || null,
      status: shopifyProduct.status || null,
      vendor: shopifyProduct.vendor || null,
      productType: shopifyProduct.productType || null,
      createdAtShopify: optionalDate(
        shopifyProduct.createdAt,
      ),
      updatedAtShopify: optionalDate(
        shopifyProduct.updatedAt,
      ),
      syncedAt: new Date(),
    },
  });
}

async function saveVariant(shop, product, shopifyVariant) {
  const cost = getCostDetails(shopifyVariant);

  return prisma.variant.upsert({
    where: {
      shop_shopifyVariantId: {
        shop,
        shopifyVariantId: shopifyVariant.id,
      },
    },

    update: {
      productId: product.id,
      shopifyInventoryItemId:
        shopifyVariant.inventoryItem?.id || null,
      title: shopifyVariant.title,
      sku: shopifyVariant.sku || null,
      barcode: shopifyVariant.barcode || null,
      price: optionalDecimal(shopifyVariant.price),
      compareAtPrice: optionalDecimal(
        shopifyVariant.compareAtPrice,
      ),
      unitCost: cost.unitCost,
      inventoryQuantity:
        shopifyVariant.inventoryQuantity ?? null,
      costStatus: cost.costStatus,
      costUpdatedAt: cost.costUpdatedAt,
      syncedAt: new Date(),
    },

    create: {
      shop,
      shopifyVariantId: shopifyVariant.id,
      shopifyInventoryItemId:
        shopifyVariant.inventoryItem?.id || null,
      productId: product.id,
      title: shopifyVariant.title,
      sku: shopifyVariant.sku || null,
      barcode: shopifyVariant.barcode || null,
      price: optionalDecimal(shopifyVariant.price),
      compareAtPrice: optionalDecimal(
        shopifyVariant.compareAtPrice,
      ),
      unitCost: cost.unitCost,
      inventoryQuantity:
        shopifyVariant.inventoryQuantity ?? null,
      costStatus: cost.costStatus,
      costUpdatedAt: cost.costUpdatedAt,
      syncedAt: new Date(),
    },
  });
}

export async function syncProducts(admin, shop) {
  console.log(`Starting product sync for ${shop}`);

  const shopifyProducts = await fetchProducts(admin);

  let syncedProducts = 0;
  let syncedVariants = 0;
  let validCostVariants = 0;
  let missingCostVariants = 0;
  let zeroCostVariants = 0;

  for (const shopifyProduct of shopifyProducts) {
    const product = await saveProduct(
      shop,
      shopifyProduct,
    );

    syncedProducts += 1;

    const variants =
      shopifyProduct.variants?.nodes || [];

    for (const shopifyVariant of variants) {
      const savedVariant = await saveVariant(
        shop,
        product,
        shopifyVariant,
      );

      syncedVariants += 1;

      if (savedVariant.costStatus === "VALID") {
        validCostVariants += 1;
      } else if (
        savedVariant.costStatus === "ZERO"
      ) {
        zeroCostVariants += 1;
      } else {
        missingCostVariants += 1;
      }
    }
  }

  const results = {
    success: true,
    syncedProducts,
    syncedVariants,
    validCostVariants,
    missingCostVariants,
    zeroCostVariants,
  };

  console.log(
    `Finished product sync for ${shop}`,
    results,
  );

  return results;
}
function moneyAmount(moneySet) {
  return Number(
    moneySet?.shopMoney?.amount || 0,
  );
}

async function findLocalVariant(
  shop,
  shopifyVariantId,
) {
  if (!shopifyVariantId) {
    return null;
  }

  return prisma.variant.findUnique({
    where: {
      shop_shopifyVariantId: {
        shop,
        shopifyVariantId,
      },
    },
  });
}

function calculateLineCost(
  variant,
  currentQuantity,
) {
  if (
    !variant ||
    variant.unitCost === null ||
    variant.unitCost === undefined
  ) {
    return {
      costStatus: "MISSING",
      unitCostAtSale: null,
      totalCostAtSale: null,
    };
  }

  const unitCost = Number(variant.unitCost);

  if (
    !Number.isFinite(unitCost) ||
    unitCost <= 0
  ) {
    return {
      costStatus: "MISSING",
      unitCostAtSale: null,
      totalCostAtSale: null,
    };
  }

  return {
    costStatus: "VALID",
    unitCostAtSale: String(unitCost),
    totalCostAtSale: String(
      unitCost * currentQuantity,
    ),
  };
}

async function saveOrderLine(
  shop,
  order,
  shopifyLine,
) {
  const shopifyVariantId =
    shopifyLine.variant?.id || null;

  const variant = await findLocalVariant(
    shop,
    shopifyVariantId,
  );

  const originalQuantity = Number(
    shopifyLine.quantity || 0,
  );

  const currentQuantity = Number(
    shopifyLine.currentQuantity || 0,
  );

  const originalUnitPrice = moneyAmount(
    shopifyLine.originalUnitPriceSet,
  );

  const discountedUnitPrice = moneyAmount(
    shopifyLine
      .discountedUnitPriceAfterAllDiscountsSet,
  );

  const netSales =
    discountedUnitPrice * currentQuantity;

  const cost = calculateLineCost(
    variant,
    currentQuantity,
  );

  return prisma.orderLine.upsert({
    where: {
      shop_shopifyLineItemId: {
        shop,
        shopifyLineItemId: shopifyLine.id,
      },
    },

    update: {
      orderId: order.id,
      variantId: variant?.id || null,
      shopifyVariantId,
      title: shopifyLine.title,
      variantTitle:
        shopifyLine.variantTitle || null,
      sku: shopifyLine.sku || null,
      originalQuantity,
      currentQuantity,
      originalUnitPrice: String(
        originalUnitPrice,
      ),
      discountedUnitPrice: String(
        discountedUnitPrice,
      ),
      netSales: String(netSales),
      unitCostAtSale: cost.unitCostAtSale,
      totalCostAtSale:
        cost.totalCostAtSale,
      costStatus: cost.costStatus,
    },

    create: {
      shop,
      shopifyLineItemId: shopifyLine.id,
      orderId: order.id,
      variantId: variant?.id || null,
      shopifyVariantId,
      title: shopifyLine.title,
      variantTitle:
        shopifyLine.variantTitle || null,
      sku: shopifyLine.sku || null,
      originalQuantity,
      currentQuantity,
      originalUnitPrice: String(
        originalUnitPrice,
      ),
      discountedUnitPrice: String(
        discountedUnitPrice,
      ),
      netSales: String(netSales),
      unitCostAtSale: cost.unitCostAtSale,
      totalCostAtSale:
        cost.totalCostAtSale,
      costStatus: cost.costStatus,
    },
  });
}

async function updateOrderProfit(orderId) {
  const lines = await prisma.orderLine.findMany({
    where: {
      orderId,
    },
  });

  const hasMissingCosts = lines.some(
    (line) => line.costStatus !== "VALID",
  );

  if (hasMissingCosts) {
    return prisma.order.update({
      where: {
        id: orderId,
      },

      data: {
        cogsStatus: "INCOMPLETE",
        totalCogs: null,
        grossProfit: null,
      },
    });
  }

  const totalCogs = lines.reduce(
    (total, line) =>
      total + Number(line.totalCostAtSale || 0),
    0,
  );

  const order = await prisma.order.findUnique({
    where: {
      id: orderId,
    },
  });

  const grossProfit =
    Number(order?.netProductSales || 0) -
    totalCogs;

  return prisma.order.update({
    where: {
      id: orderId,
    },

    data: {
      cogsStatus: "COMPLETE",
      totalCogs: String(totalCogs),
      grossProfit: String(grossProfit),
    },
  });
}

export async function syncOrders(admin, shop) {
  console.log(`Starting order sync for ${shop}`);

  const shopifyOrders =
    await fetchHistoricalOrders(admin);

  let syncedOrders = 0;
  let syncedOrderLines = 0;
  let completeCogsOrders = 0;
  let incompleteCogsOrders = 0;

  for (const shopifyOrder of shopifyOrders) {
    const grossProductSales =
      shopifyOrder.lineItems?.nodes?.reduce(
        (total, line) => {
          return (
            total +
            moneyAmount(
              line.originalUnitPriceSet,
            ) *
              Number(line.quantity || 0)
          );
        },
        0,
      ) || 0;

    const order = await prisma.order.upsert({
      where: {
        shop_shopifyOrderId: {
          shop,
          shopifyOrderId: shopifyOrder.id,
        },
      },

      update: {
        orderName: shopifyOrder.name,
        processedAt: new Date(
          shopifyOrder.processedAt,
        ),
        createdAtShopify: new Date(
          shopifyOrder.createdAt,
        ),
        cancelledAt: shopifyOrder.cancelledAt
          ? new Date(shopifyOrder.cancelledAt)
          : null,
        financialStatus:
          shopifyOrder.displayFinancialStatus ||
          null,
        currencyCode:
          shopifyOrder.currencyCode,
        grossProductSales: String(
          grossProductSales,
        ),
        discounts: String(
          moneyAmount(
            shopifyOrder.currentTotalDiscountsSet,
          ),
        ),
        netProductSales: String(
          moneyAmount(
            shopifyOrder.currentSubtotalPriceSet,
          ),
        ),
        shippingCollected: String(
          moneyAmount(
            shopifyOrder.currentShippingPriceSet,
          ),
        ),
        taxesCollected: String(
          moneyAmount(
            shopifyOrder.currentTotalTaxSet,
          ),
        ),
        totalSales: String(
          moneyAmount(
            shopifyOrder.currentTotalPriceSet,
          ),
        ),
        syncedAt: new Date(),
      },

      create: {
        shop,
        shopifyOrderId: shopifyOrder.id,
        orderName: shopifyOrder.name,
        processedAt: new Date(
          shopifyOrder.processedAt,
        ),
        createdAtShopify: new Date(
          shopifyOrder.createdAt,
        ),
        cancelledAt: shopifyOrder.cancelledAt
          ? new Date(shopifyOrder.cancelledAt)
          : null,
        financialStatus:
          shopifyOrder.displayFinancialStatus ||
          null,
        currencyCode:
          shopifyOrder.currencyCode,
        grossProductSales: String(
          grossProductSales,
        ),
        discounts: String(
          moneyAmount(
            shopifyOrder.currentTotalDiscountsSet,
          ),
        ),
        netProductSales: String(
          moneyAmount(
            shopifyOrder.currentSubtotalPriceSet,
          ),
        ),
        shippingCollected: String(
          moneyAmount(
            shopifyOrder.currentShippingPriceSet,
          ),
        ),
        taxesCollected: String(
          moneyAmount(
            shopifyOrder.currentTotalTaxSet,
          ),
        ),
        totalSales: String(
          moneyAmount(
            shopifyOrder.currentTotalPriceSet,
          ),
        ),
        syncedAt: new Date(),
      },
    });

    syncedOrders += 1;

    const lines =
      shopifyOrder.lineItems?.nodes || [];

    for (const line of lines) {
      await saveOrderLine(shop, order, line);
      syncedOrderLines += 1;
    }

    const updatedOrder =
      await updateOrderProfit(order.id);

    if (
      updatedOrder.cogsStatus === "COMPLETE"
    ) {
      completeCogsOrders += 1;
    } else {
      incompleteCogsOrders += 1;
    }
  }

  const result = {
    success: true,
    syncedOrders,
    syncedOrderLines,
    completeCogsOrders,
    incompleteCogsOrders,
  };

  console.log(
    `Finished order sync for ${shop}`,
    result,
  );

  return result;
}