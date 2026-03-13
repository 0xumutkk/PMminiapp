export function shouldPreferWalletSendCalls(connectorId?: string | null) {
  return connectorId === "baseAccount" || connectorId === "farcaster" || connectorId === "farcaster-miniapp";
}

export function shouldUseDirectTransactionSubmission(
  totalCalls: number,
  connectorId?: string | null,
  action?: "buy" | "sell" | "redeem"
) {
  if (totalCalls !== 1) {
    return false;
  }

  if (action === "redeem") {
    return true;
  }

  return !shouldPreferWalletSendCalls(connectorId);
}
