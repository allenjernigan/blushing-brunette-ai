-- CreateTable
CREATE TABLE "Product" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "status" TEXT,
    "vendor" TEXT,
    "productType" TEXT,
    "createdAtShopify" TIMESTAMP(3),
    "updatedAtShopify" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyInventoryItemId" TEXT,
    "productId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "price" DECIMAL(65,30),
    "compareAtPrice" DECIMAL(65,30),
    "unitCost" DECIMAL(65,30),
    "inventoryQuantity" INTEGER,
    "costStatus" TEXT NOT NULL DEFAULT 'MISSING',
    "costUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "createdAtShopify" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "financialStatus" TEXT,
    "currencyCode" TEXT NOT NULL,
    "grossProductSales" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "discounts" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "netProductSales" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "shippingCollected" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "taxesCollected" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "totalSales" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "cogsStatus" TEXT NOT NULL DEFAULT 'INCOMPLETE',
    "totalCogs" DECIMAL(65,30),
    "grossProfit" DECIMAL(65,30),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "orderId" INTEGER NOT NULL,
    "variantId" INTEGER,
    "shopifyVariantId" TEXT,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "originalQuantity" INTEGER NOT NULL,
    "currentQuantity" INTEGER NOT NULL,
    "originalUnitPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "discountedUnitPrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "netSales" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unitCostAtSale" DECIMAL(65,30),
    "totalCostAtSale" DECIMAL(65,30),
    "costStatus" TEXT NOT NULL DEFAULT 'MISSING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Product_shop_idx" ON "Product"("shop");

-- CreateIndex
CREATE INDEX "Product_title_idx" ON "Product"("title");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shop_shopifyProductId_key" ON "Product"("shop", "shopifyProductId");

-- CreateIndex
CREATE INDEX "Variant_shop_idx" ON "Variant"("shop");

-- CreateIndex
CREATE INDEX "Variant_productId_idx" ON "Variant"("productId");

-- CreateIndex
CREATE INDEX "Variant_sku_idx" ON "Variant"("sku");

-- CreateIndex
CREATE INDEX "Variant_costStatus_idx" ON "Variant"("costStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_shop_shopifyVariantId_key" ON "Variant"("shop", "shopifyVariantId");

-- CreateIndex
CREATE INDEX "Order_shop_idx" ON "Order"("shop");

-- CreateIndex
CREATE INDEX "Order_processedAt_idx" ON "Order"("processedAt");

-- CreateIndex
CREATE INDEX "Order_cogsStatus_idx" ON "Order"("cogsStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shop_shopifyOrderId_key" ON "Order"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "OrderLine_shop_idx" ON "OrderLine"("shop");

-- CreateIndex
CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");

-- CreateIndex
CREATE INDEX "OrderLine_variantId_idx" ON "OrderLine"("variantId");

-- CreateIndex
CREATE INDEX "OrderLine_shopifyVariantId_idx" ON "OrderLine"("shopifyVariantId");

-- CreateIndex
CREATE INDEX "OrderLine_costStatus_idx" ON "OrderLine"("costStatus");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_shop_shopifyLineItemId_key" ON "OrderLine"("shop", "shopifyLineItemId");
