type ConnectorLike = {
  id: string;
  type?: string;
};

export type WalletRuntimeEnvironment = {
  hasInjectedProvider: boolean;
  hasMiniAppProvider: boolean;
  hasWindowEthereum: boolean;
  isFramed: boolean;
};

type WalletWindow = Window & {
  ethereum?: unknown;
  __swipenMiniAppEthereumProvider?: unknown;
};

const SERVER_WALLET_RUNTIME_ENVIRONMENT: WalletRuntimeEnvironment = Object.freeze({
  hasInjectedProvider: false,
  hasMiniAppProvider: false,
  hasWindowEthereum: false,
  isFramed: false
});

let cachedWalletRuntimeEnvironment: WalletRuntimeEnvironment = SERVER_WALLET_RUNTIME_ENVIRONMENT;

function toStableWalletRuntimeEnvironment(next: WalletRuntimeEnvironment) {
  const previous = cachedWalletRuntimeEnvironment;
  if (
    previous.hasInjectedProvider === next.hasInjectedProvider &&
    previous.hasMiniAppProvider === next.hasMiniAppProvider &&
    previous.hasWindowEthereum === next.hasWindowEthereum &&
    previous.isFramed === next.isFramed
  ) {
    return previous;
  }

  const stable = Object.freeze(next);
  cachedWalletRuntimeEnvironment = stable;
  return stable;
}

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
    return SERVER_WALLET_RUNTIME_ENVIRONMENT;
  }

  const walletWindow = window as WalletWindow;
  const hasWindowEthereum = typeof walletWindow.ethereum !== "undefined";
  const hasMiniAppProvider = typeof walletWindow.__swipenMiniAppEthereumProvider !== "undefined";

  let isFramed = false;
  try {
    isFramed = window.self !== window.top;
  } catch {
    isFramed = true;
  }

  return toStableWalletRuntimeEnvironment({
    hasInjectedProvider: hasWindowEthereum || hasMiniAppProvider,
    hasMiniAppProvider,
    hasWindowEthereum,
    isFramed
  });
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

  const targetedInjectedConnector = injectedConnectors.find(
    (connector) => connector.id !== "injected" && connector.id !== "farcaster-miniapp"
  );
  const miniAppConnector = injectedConnectors.find((connector) => connector.id === "farcaster-miniapp");
  if (environment.hasWindowEthereum) {
    return (
      injectedConnectors.find((connector) => connector.id === "injected") ??
      targetedInjectedConnector ??
      miniAppConnector
    );
  }

  if (environment.hasMiniAppProvider) {
    return miniAppConnector ?? targetedInjectedConnector;
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
