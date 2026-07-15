export function auditProduct(product) {
  const checks = [
    {
      key: "description",
      label: "Product Description",
      passed:
        Boolean(product.descriptionHtml) &&
        product.descriptionHtml.replace(/<[^>]*>/g, "").trim().length > 150,
    },
    {
      key: "images",
      label: "Images",
      passed: Boolean(product.featuredMedia),
    },
    {
      key: "productType",
      label: "Product Type",
      passed: Boolean(product.productType),
    },
    {
      key: "tags",
      label: "Tags",
      passed: Array.isArray(product.tags) && product.tags.length >= 3,
    },
    {
      key: "variants",
      label: "Variants",
      passed:
        Array.isArray(product.variants?.nodes) &&
        product.variants.nodes.length > 0,
    },
  ];

  const passedCount = checks.filter((check) => check.passed).length;

  return {
    score: Math.round((passedCount / checks.length) * 100),
    checks,
  };
}