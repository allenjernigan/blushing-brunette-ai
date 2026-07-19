import prisma from "../db.server";

export const FINANCE_CHANNELS = ["ecommerce", "pos", "all"];

export const DEFAULT_SHOP_SETTINGS = {
  ecommerceShippingCost: "6.00",
  posShippingCost: "6.00",
  ecommerceProcessingPercentage: "0",
  ecommerceProcessingFixedFee: "0",
  posProcessingPercentage: "0",
  posProcessingFixedFee: "0",
  monthlyFixedOperatingExpenses: "17000",
  targetContributionMarginPercentage: "20",
  targetRoas: "2.5",
  defaultFinanceChannel: "ecommerce",
};

const NUMERIC_FIELDS = [
  "ecommerceShippingCost",
  "posShippingCost",
  "ecommerceProcessingPercentage",
  "ecommerceProcessingFixedFee",
  "posProcessingPercentage",
  "posProcessingFixedFee",
  "monthlyFixedOperatingExpenses",
  "targetContributionMarginPercentage",
  "targetRoas",
];

export class SettingsValidationError extends Error {
  constructor(errors, values) {
    super("Please correct the highlighted settings.");
    this.name = "SettingsValidationError";
    this.errors = errors;
    this.values = values;
  }
}

function normalizeSubmittedValues(input) {
  const values = {};

  for (const field of [
    ...NUMERIC_FIELDS,
    "defaultFinanceChannel",
  ]) {
    const submittedValue = input[field];

    values[field] =
      typeof submittedValue === "string"
        ? submittedValue.trim()
        : DEFAULT_SHOP_SETTINGS[field];
  }

  return values;
}

function validateSettingsInput(input) {
  const values = normalizeSubmittedValues(input);
  const errors = {};

  for (const field of NUMERIC_FIELDS) {
    const numericValue = Number(values[field]);

    if (values[field] === "" || !Number.isFinite(numericValue)) {
      errors[field] = "Enter a valid number.";
    } else if (numericValue < 0) {
      errors[field] = "Value cannot be negative.";
    }
  }

  if (!FINANCE_CHANNELS.includes(values.defaultFinanceChannel)) {
    errors.defaultFinanceChannel =
      "Choose Ecommerce, POS, or All Channels.";
  }

  return { values, errors };
}

export function serializeShopSettings(settings) {
  return {
    ecommerceShippingCost: String(settings.ecommerceShippingCost),
    posShippingCost: String(settings.posShippingCost),
    ecommerceProcessingPercentage: String(
      settings.ecommerceProcessingPercentage,
    ),
    ecommerceProcessingFixedFee: String(
      settings.ecommerceProcessingFixedFee,
    ),
    posProcessingPercentage: String(
      settings.posProcessingPercentage,
    ),
    posProcessingFixedFee: String(
      settings.posProcessingFixedFee,
    ),
    monthlyFixedOperatingExpenses: String(
      settings.monthlyFixedOperatingExpenses,
    ),
    targetContributionMarginPercentage: String(
      settings.targetContributionMarginPercentage,
    ),
    targetRoas: String(settings.targetRoas),
    defaultFinanceChannel: settings.defaultFinanceChannel,
  };
}

export async function getShopSettings(shopDomain) {
  return prisma.shopSettings.findUnique({
    where: { shop: shopDomain },
  });
}

export async function getOrCreateShopSettings(shopDomain) {
  return prisma.shopSettings.upsert({
    where: { shop: shopDomain },
    update: {},
    create: {
      shop: shopDomain,
      ...DEFAULT_SHOP_SETTINGS,
    },
  });
}

export async function updateShopSettings(shopDomain, input) {
  const { values, errors } = validateSettingsInput(input);

  if (Object.keys(errors).length > 0) {
    throw new SettingsValidationError(errors, values);
  }

  return prisma.shopSettings.upsert({
    where: { shop: shopDomain },
    update: values,
    create: {
      shop: shopDomain,
      ...values,
    },
  });
}
