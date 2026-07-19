export const UNATTRIBUTED_CHANNEL = "__unattributed__";

export function normalizeShopifyChannel(value, isPos = false) {
  const shopifyValue = value ?? null;

  return {
    key: shopifyValue || UNATTRIBUTED_CHANNEL,
    label: shopifyValue || "Unattributed",
    shopifyValue,
    isPos: Boolean(isPos),
  };
}

export function normalizeOrderChannel(order) {
  return order?.app?.name || UNATTRIBUTED_CHANNEL;
}

export function parseSelectedChannels(searchParams, channels) {
  if (!searchParams.has("channel")) {
    return getPresetChannels("all", channels);
  }

  const validKeys = new Set(channels.map((channel) => channel.key));

  return Array.from(
    new Set(
      searchParams
        .getAll("channel")
        .filter(Boolean)
        .filter((channel) => validKeys.has(channel)),
    ),
  );
}

export function setChannelParams(searchParams, selectedChannels) {
  searchParams.delete("channel");

  if (selectedChannels.length === 0) {
    searchParams.append("channel", "");
    return searchParams;
  }

  for (const channel of selectedChannels) {
    searchParams.append("channel", channel);
  }

  return searchParams;
}

export function getPresetChannels(preset, channels) {
  if (preset === "pos-only") {
    return channels
      .filter((channel) => channel.isPos)
      .map((channel) => channel.key);
  }

  if (preset === "all-except-pos") {
    return channels
      .filter((channel) => !channel.isPos)
      .map((channel) => channel.key);
  }

  return channels.map((channel) => channel.key);
}

function sameSelection(left, right) {
  if (left.length !== right.length) return false;

  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function getActiveChannelPreset(selectedChannels, channels) {
  for (const preset of ["all", "all-except-pos", "pos-only"]) {
    if (
      sameSelection(
        selectedChannels,
        getPresetChannels(preset, channels),
      )
    ) {
      return preset;
    }
  }

  return null;
}

export function getPeriodChannelKeys(shopifySummaries, orders) {
  return Array.from(
    new Set([
      ...shopifySummaries.map((summary) => summary.channel.key),
      ...orders.map((order) => order.salesChannel),
    ]),
  );
}
