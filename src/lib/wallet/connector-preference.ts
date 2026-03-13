type ConnectorLike = {
  id: string;
};

type WalletRuntimeEnvironment = {
  hasInjectedProvider: boolean;
  isFramed: boolean;
};

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return "";
}

export function getWalletRuntimeEnvironment(): WalletRuntimeEnvironment {
  if (typeof window === "undefined") {
    return {
      hasInjectedProvider: false,
      isFramed: false
    };
  }

  let isFramed = false;
  try {
    isFramed = window.self !== window.top;
  } catch {
    isFramed = true;
  }

  return {
    hasInjectedProvider: typeof window.ethereum !== "undefined",
    isFramed
  };
}

export function isCrossOriginFrameConnectError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes("blocked a frame with origin") ||
    message.includes("cross-origin-opener-policy") ||
    message.includes("cross-origin") ||
    message.includes("securityerror")
  );
}

export function formatWalletConnectError(error: unknown) {
  if (isCrossOriginFrameConnectError(error)) {
    return "This host blocks Base Account in an iframe. Retry with your injected wallet.";
  }

  const message = errorMessage(error).trim();
  return message || "Wallet connection failed.";
}

export function resolvePreferredConnector<T extends ConnectorLike>(
  connectors: readonly T[],
  environment: WalletRuntimeEnvironment = getWalletRuntimeEnvironment()
) {
  const baseAccount = connectors.find((connector) => connector.id === "baseAccount");
  const injected = connectors.find((connector) => connector.id === "injected");

  if (environment.hasInjectedProvider && injected) {
    return injected;
  }

  if (environment.isFramed && injected) {
    return injected;
  }

  return baseAccount ?? injected ?? connectors[0];
}

export function resolveFallbackConnector<T extends ConnectorLike>(
  attemptedConnectorId: string | undefined,
  connectors: readonly T[],
  error: unknown,
  environment: WalletRuntimeEnvironment = getWalletRuntimeEnvironment()
) {
  if (attemptedConnectorId !== "baseAccount") {
    return undefined;
  }

  if (!environment.hasInjectedProvider && !environment.isFramed) {
    return undefined;
  }

  if (!isCrossOriginFrameConnectError(error)) {
    return undefined;
  }

  return connectors.find((connector) => connector.id === "injected");
}
