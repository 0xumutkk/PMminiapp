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
  "farcaster.org",
  "wallet.farcaster.xyz",
  "base.app",
  "base.org",
  "base.dev",
  "warpcast.com",
  "warpcast.org",
  "www.warpcast.com",
  "app.warpcast.com"
];

function isKnownHost(host: string) {
  const h = host.toLowerCase();
  return KNOWN_MINI_APP_HOSTS.some((known) => h === known || h.endsWith("." + known) || h.endsWith(known));
}

function referrerMatchesKnownHost(referrer: string) {
  if (!referrer || !referrer.trim()) {
    return false;
  }
  try {
    const host = new URL(referrer).host.toLowerCase();
    return isKnownHost(host) || host.includes("warpcast") || host.includes("farcaster") || host.includes("base.");
  } catch {
    return referrer.toLowerCase().includes("warpcast") || referrer.toLowerCase().includes("farcaster");
  }
}

export function isLikelyMiniAppHost() {
  const currentWindow = getWindowObject();
  if (!currentWindow) {
    return false;
  }

  try {
    if (Boolean(currentWindow.ReactNativeWebView)) {
      return true;
    }

    const referrer = getDocumentObject()?.referrer?.trim() ?? "";
    const referrerHost = getReferrerHost();
    if (referrerHost && isKnownHost(referrerHost)) {
      return true;
    }
    if (referrer && referrerMatchesKnownHost(referrer)) {
      return true;
    }

    if (currentWindow.top === currentWindow.self) {
      return false;
    }

    if (!referrerHost) {
      return true;
    }

    return isKnownHost(referrerHost) || referrerMatchesKnownHost(referrer);
  } catch {
    return true;
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
  if (!isLikelyMiniAppHost()) {
    return null;
  }

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
    await sdk.actions.ready();
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
