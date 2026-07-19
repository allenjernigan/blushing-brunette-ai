-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "ecommerceShippingCost" DECIMAL(65,30) NOT NULL DEFAULT 6.00,
    "posShippingCost" DECIMAL(65,30) NOT NULL DEFAULT 6.00,
    "paymentProcessingPercentage" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "paymentProcessingFixedFee" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "monthlyFixedOperatingExpenses" DECIMAL(65,30) NOT NULL DEFAULT 17000,
    "targetContributionMarginPercentage" DECIMAL(65,30) NOT NULL DEFAULT 20,
    "targetRoas" DECIMAL(65,30) NOT NULL DEFAULT 2.5,
    "defaultFinanceChannel" TEXT NOT NULL DEFAULT 'ecommerce',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
