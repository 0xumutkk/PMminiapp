type ConnectorLike = {
  id: string;
  type?: string;
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

function isBaseAccountConnector(connector: ConnectorLike) {
  return connector.id === "baseAccount" || connector.type === "baseAccount";
}

function isInjectedConnector(connector: ConnectorLike) {
  return connector.id === "injected" || connector.type === "injected";
}

function resolveInjectedConnector<T extends ConnectorLike>(
  connectors: readonly T[],
  environment: WalletRuntimeEnvironment
) {
  const injectedConnectors = connectors.filter(isInjectedConnector);
  if (injectedConnectors.length === 0) {
    return undefined;
  }

  const targetedInjectedConnector = injectedConnectors.find((connector) => connector.id !== "injected");
  if (environment.hasInjectedProvider) {
    return injectedConnectors.find((connector) => connector.id === "injected") ?? targetedInjectedConnector;
  }

  return targetedInjectedConnector;
}

export function getWalletConnectUnavailableReason<T extends ConnectorLike>(
  connectors: readonly T[],
  environment: WalletRuntimeEnvironment = getWalletRuntimeEnvironment()
) {
  if (!environment.isFramed) {
    return null;
  }

  return resolveInjectedConnector(connectors, environment)
    ? null
    : "No injected wallet is available in this host. Open the app in a wallet-enabled browser or supported mini app.";
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

export function isInjectedNotFoundError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("provider not found") || message.includes("no provider");
}

export function formatWalletConnectError(
  error: unknown,
  environment: WalletRuntimeEnvironment = getWalletRuntimeEnvironment()
) {
  if (isCrossOriginFrameConnectError(error)) {
    return "This host blocks Base Account in an iframe. Retry with your injected wallet.";
  }

  if (isInjectedNotFoundError(error)) {
    if (environment.isFramed) {
      return "No injected wallet is available in this host. Open the app in a wallet-enabled browser or supported mini app.";
    }

    return "No wallet found. Install Coinbase Wallet or MetaMask, or try Base Account.";
  }

  const message = errorMessage(error).trim();
  return message || "Wallet connection failed.";
}

export function resolvePreferredConnector<T extends ConnectorLike>(
  connectors: readonly T[],
  environment: WalletRuntimeEnvironment = getWalletRuntimeEnvironment()
) {
  const baseAccount = connectors.find(isBaseAccountConnector);
  const injected = resolveInjectedConnector(connectors, environment);

  if (injected) {
    return injected;
  }

  if (environment.isFramed) {
    return undefined;
  }

  return baseAccount ?? injected ?? connectors[0];
}

export function resolveFallbackConnector<T extends ConnectorLike>(
  attemptedConnectorId: string | undefined,
  connectors: readonly T[],
  error: unknown,
  environment: WalletRuntimeEnvironment = getWalletRuntimeEnvironment()
) {
  const attemptedConnector = connectors.find((connector) => connector.id === attemptedConnectorId);

  if (attemptedConnector && isBaseAccountConnector(attemptedConnector)) {
    if (!isCrossOriginFrameConnectError(error)) {
      return undefined;
    }

    return resolveInjectedConnector(connectors, environment);
  }

  if (attemptedConnector && isInjectedConnector(attemptedConnector)) {
    if (environment.isFramed) {
      return undefined;
    }

    if (isInjectedNotFoundError(error)) {
      return connectors.find(isBaseAccountConnector);
    }
  }

  return undefined;
}
