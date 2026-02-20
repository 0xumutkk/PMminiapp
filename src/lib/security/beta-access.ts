import { isAddress } from "viem";

function normalizeList(raw: string | undefined) {
  if (!raw) {
    return [] as string[];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isBetaModeEnabled() {
  return process.env.BETA_MODE === "true";
}

export function isAddressAllowedForBeta(address: string | undefined) {
  if (!isBetaModeEnabled()) {
    return true;
  }

  if (!address || !isAddress(address)) {
    return false;
  }

  const allowlist = normalizeList(process.env.BETA_ALLOWLIST_ADDRESSES).map((item) => item.toLowerCase());
  if (allowlist.length === 0) {
    return false;
  }

  return allowlist.includes(address.toLowerCase());
}
