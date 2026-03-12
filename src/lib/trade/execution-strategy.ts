export function shouldPreferWalletSendCalls(connectorId?: string | null) {
  return connectorId === "farcaster" || connectorId === "farcaster-miniapp";
}

export function shouldUseDirectTransactionSubmission(
  totalCalls: number,
  connectorId?: string | null
) {
  return totalCalls === 1 && !shouldPreferWalletSendCalls(connectorId);
}
