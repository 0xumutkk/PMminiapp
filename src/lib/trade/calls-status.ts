type CallsStatusLike = {
  receipts?: Array<{
    transactionHash?: string | null;
  }> | null;
};

export function extractCallsStatusTxHashes(result: CallsStatusLike | null | undefined) {
  return (
    result?.receipts
      ?.map((receipt) =>
        typeof receipt?.transactionHash === "string" && receipt.transactionHash.startsWith("0x")
          ? (receipt.transactionHash as `0x${string}`)
          : null
      )
      .filter((hash): hash is `0x${string}` => Boolean(hash)) ?? []
  );
}
