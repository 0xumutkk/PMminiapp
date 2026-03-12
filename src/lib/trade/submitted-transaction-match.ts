type PendingCall = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
};

type SubmittedTransaction = {
  from?: `0x${string}` | null;
  to?: `0x${string}` | null;
  input?: `0x${string}` | null;
  value?: bigint | null;
};

function normalizeHex(value: string | null | undefined) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function normalizeAddress(value: string | null | undefined) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function matchesSubmittedCall(
  transaction: SubmittedTransaction | null | undefined,
  call: PendingCall,
  expectedFrom?: `0x${string}` | null
) {
  if (!transaction) {
    return false;
  }

  const txTo = normalizeAddress(transaction.to);
  const callTo = normalizeAddress(call.to);
  if (!txTo || txTo !== callTo) {
    return false;
  }

  const txInput = normalizeHex(transaction.input);
  const callData = normalizeHex(call.data);
  if (!txInput || txInput !== callData) {
    return false;
  }

  const txValue = transaction.value ?? null;
  if (typeof txValue !== "bigint" || txValue !== call.value) {
    return false;
  }

  if (expectedFrom) {
    const txFrom = normalizeAddress(transaction.from);
    if (!txFrom || txFrom !== normalizeAddress(expectedFrom)) {
      return false;
    }
  }

  return true;
}
