import test from "node:test";
import assert from "node:assert/strict";

import {
  UNATTRIBUTED_CHANNEL,
  getActiveChannelPreset,
  getPresetChannels,
  getPeriodChannelKeys,
  normalizeOrderChannel,
  normalizeShopifyChannel,
  parseSelectedChannels,
  setChannelParams,
} from "../app/services/financeFilters.js";

const channels = [
  normalizeShopifyChannel("Online Store"),
  normalizeShopifyChannel("Shop"),
  normalizeShopifyChannel("Point of Sale", true),
  normalizeShopifyChannel(null),
];

test("defaults to all discovered channels", () => {
  assert.deepEqual(
    parseSelectedChannels(new URLSearchParams(), channels),
    ["Online Store", "Shop", "Point of Sale", UNATTRIBUTED_CHANNEL],
  );
});

test("round trips one, many, special characters, and explicit empty selections", () => {
  const params = setChannelParams(
    new URLSearchParams("period=today"),
    ["Online Store", "TikTok & Instagram"],
  );
  assert.equal(
    params.toString(),
    "period=today&channel=Online+Store&channel=TikTok+%26+Instagram",
  );

  assert.deepEqual(
    parseSelectedChannels(params, [
      ...channels,
      normalizeShopifyChannel("TikTok & Instagram"),
    ]),
    ["Online Store", "TikTok & Instagram"],
  );

  assert.deepEqual(
    parseSelectedChannels(
      setChannelParams(new URLSearchParams(), []),
      channels,
    ),
    [],
  );
});

test("preserves a single selection and punctuation or Unicode exactly", () => {
  const specialChannels = [
    normalizeShopifyChannel("Google, YouTube & Discover"),
    normalizeShopifyChannel("Mobile App — EU"),
  ];
  const one = new URLSearchParams("channel=Online+Store");
  assert.deepEqual(parseSelectedChannels(one, channels), ["Online Store"]);

  const params = setChannelParams(
    new URLSearchParams(),
    specialChannels.map((channel) => channel.key),
  );
  assert.deepEqual(
    parseSelectedChannels(params, specialChannels),
    ["Google, YouTube & Discover", "Mobile App — EU"],
  );
});

test("presets share the channel selection model and include future POS channels", () => {
  const futureChannels = [
    ...channels,
    normalizeShopifyChannel("Retail Pop-up", true),
  ];

  assert.deepEqual(getPresetChannels("pos-only", futureChannels), [
    "Point of Sale",
    "Retail Pop-up",
  ]);
  assert.equal(
    getActiveChannelPreset(
      getPresetChannels("all-except-pos", futureChannels),
      futureChannels,
    ),
    "all-except-pos",
  );
  assert.deepEqual(getPresetChannels("all", futureChannels),
    futureChannels.map((channel) => channel.key));
});

test("maps Order.app names and missing app attribution", () => {
  assert.equal(
    normalizeOrderChannel({ app: { name: "Facebook & Instagram" } }),
    "Facebook & Instagram",
  );
  assert.equal(normalizeOrderChannel({ app: null }), UNATTRIBUTED_CHANNEL);
});

test("period channel breakdown keys are independent of selected filters", () => {
  const keys = getPeriodChannelKeys(
    [{ channel: normalizeShopifyChannel("Online Store") }],
    [{ salesChannel: "Point of Sale" }],
  );

  assert.deepEqual(keys, ["Online Store", "Point of Sale"]);
});
