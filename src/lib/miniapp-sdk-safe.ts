"use client";

type MiniAppSdk = typeof import("@farcaster/miniapp-sdk").default;

type SignInOptions = {
  nonce: string;
  notBefore?: string;
  expirationTime?: string;
  acceptAuthAddress?: boolean;
};

function getWindowObject() {
  if (typeof window === "undefined") {
    return null;
  }

  return window;
}

function getDocumentObject() {
  if (typeof document === "undefined") {
    return null;
  }

  return document;
}

function getReferrerHost() {
  const currentDocument = getDocumentObject();
  if (!currentDocument) {
    return "";
  }

  const referrer = currentDocument.referrer?.trim();
  if (!referrer) {
    return "";
  }

  try {
    return new URL(referrer).host.toLowerCase();
  } catch {
    return "";
  }
}

function reasonToMessage(reason: unknown) {
  if (reason instanceof Error) {
    return reason.message;
  }

  if (typeof reason === "string") {
    return reason;
  }

  if (reason && typeof reason === "object") {
    const record = reason as Record<string, unknown>;
    if (typeof record.message === "string") {
      return record.message;
    }
  }

  return "";
}

function shouldIgnoreRejection(reason: unknown) {
  const message = reasonToMessage(reason);

  if (message.includes("Unsupported action: eip6963RequestProvider")) {
    return true;
  }

  if (reason instanceof DOMException && reason.name === "DataCloneError") {
    return true;
  }

  return message.includes("DataCloneError");
}

let guardsInstalled = false;
let sdkPromise: Promise<MiniAppSdk | null> | null = null;

const KNOWN_MINI_APP_HOSTS = [
  "farcaster.xyz",
  "wallet.farcaster.xyz",
  "base.app",
  "base.org",
  "base.dev",
  "warpcast.com",
  "warpcast.org"
];

function isKnownHost(host: string) {
  const h = host.toLowerCase();
  return KNOWN_MINI_APP_HOSTS.some((known) => h === known || h.endsWith("." + known) || h.endsWith(known));
}

export function isLikelyMiniAppHost() {
  const currentWindow = getWindowObject();
  if (!currentWindow) {
    return false;
  }

  try {
    // Only trust ReactNativeWebView if it has postMessage
    if (Boolean(currentWindow.ReactNativeWebView) && typeof currentWindow.ReactNativeWebView.postMessage === 'function') {
      return true;
    }

    const referrerHost = getReferrerHost();
    // Only trust referrer if it's a known host
    if (referrerHost && isKnownHost(referrerHost)) {
      return true;
    }

    // If we're in an iframe, check if we're on a known domain
    if (currentWindow.top !== currentWindow.self) {
      if (referrerHost) {
        return isKnownHost(referrerHost);
      }
      // If we're in an iframe but host is unknown, don't assume mini-app
      return false;
    }

    return false;
  } catch {
    return false;
  }
}

function installSdkGuards() {
  if (guardsInstalled) {
    return;
  }

  const currentWindow = getWindowObject();
  if (!currentWindow) {
    return;
  }

  // Prevent host-origin eip6963 broadcast requests from reaching MiniApp SDK listeners.
  const stopProviderRequest = (event: Event) => {
    event.stopImmediatePropagation();
  };

  currentWindow.addEventListener(
    "eip6963:requestProvider",
    stopProviderRequest,
    true
  );
  const currentDocument = getDocumentObject();
  currentDocument?.addEventListener("eip6963:requestProvider", stopProviderRequest, true);

  currentWindow.addEventListener("unhandledrejection", (event) => {
    if (shouldIgnoreRejection(event.reason)) {
      event.preventDefault();
    }
  });
  currentWindow.addEventListener("error", (event) => {
    if (shouldIgnoreRejection(event.error ?? event.message)) {
      event.preventDefault();
    }
  });

  guardsInstalled = true;
}

export async function getMiniAppSdk() {
  installSdkGuards();

  sdkPromise ??= import("@farcaster/miniapp-sdk")
    .then((module) => module.default)
    .catch(() => null);

  return sdkPromise;
}

export async function getMiniAppContext(timeoutMs = 1_200) {
  const sdk = await getMiniAppSdk();
  if (!sdk) {
    return null;
  }

  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });

    return await Promise.race([sdk.context, timeoutPromise]);
  } catch {
    return null;
  }
}

export async function markMiniAppReady() {
  const sdk = await getMiniAppSdk();
  if (!sdk) {
    return false;
  }

  try {
    const readyPromise = sdk.actions.ready();
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000));
    await Promise.race([readyPromise, timeoutPromise]);
    return true;
  } catch {
    return false;
  }
}

export async function requestMiniAppSignIn(options: SignInOptions) {
  const sdk = await getMiniAppSdk();
  if (!sdk) {
    throw new Error("Mini App SDK unavailable");
  }

  return sdk.actions.signIn(options);
}
