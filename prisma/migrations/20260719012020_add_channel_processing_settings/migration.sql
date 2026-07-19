-- Add channel-specific processing settings without removing the legacy values.
ALTER TABLE "ShopSettings"
ADD COLUMN "ecommerceProcessingPercentage" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "ecommerceProcessingFixedFee" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "posProcessingPercentage" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "posProcessingFixedFee" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- Preserve existing generic assumptions as Ecommerce defaults. POS stays at zero.
UPDATE "ShopSettings"
SET
  "ecommerceProcessingPercentage" = "paymentProcessingPercentage",
  "ecommerceProcessingFixedFee" = "paymentProcessingFixedFee";
