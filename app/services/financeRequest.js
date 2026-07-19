import { FINANCE_PERIODS } from "./financeDateRange.js";

export function parseFinanceRequestUrl(requestUrl) {
  const url = new URL(requestUrl);
  const requestedPeriod = url.searchParams.get("period");
  const selectedPeriod = FINANCE_PERIODS.includes(requestedPeriod)
    ? requestedPeriod
    : "today";

  return {
    selectedPeriod,
    customStart: url.searchParams.get("start") || "",
    customEnd: url.searchParams.get("end") || "",
    requestedChannels: url.searchParams.has("channel")
      ? url.searchParams.getAll("channel").filter(Boolean)
      : null,
  };
}

export function getFinanceRevalidationAction(location) {
  return `${location.pathname}${location.search}`;
}
