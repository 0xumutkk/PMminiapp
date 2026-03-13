import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { AppProviders } from "@/components/providers";
import { LegalDisclaimer } from "@/components/legal-disclaimer";

function resolveMetadataBase(raw: string | undefined) {
  if (!raw) {
    return new URL("https://example.com");
  }

  const value = raw.trim();
  if (!value) {
    return new URL("https://example.com");
  }

  try {
    const url = new URL(value);
    if (url.hostname.endsWith(".trycloudflare.com")) {
      return new URL("https://example.com");
    }
    return url;
  } catch {
    if (!/^https?:\/\//i.test(value)) {
      try {
        return new URL(`https://${value}`);
      } catch {
        return new URL("https://example.com");
      }
    }

    return new URL("https://example.com");
  }
}

function resolveAssetUrl(raw: string | undefined, fallbackPath: string) {
  const value = raw?.trim();
  if (!value) {
    return new URL(fallbackPath, metadataBase).toString();
  }

  try {
    return new URL(value).toString();
  } catch {
    return new URL(value.startsWith("/") ? value : `/${value}`, metadataBase).toString();
  }
}

const metadataBase = resolveMetadataBase(process.env.NEXT_PUBLIC_MINI_APP_URL);
const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Swipen";
const appDescription =
  process.env.NEXT_PUBLIC_APP_DESCRIPTION ?? "Base Mini App for live prediction markets on Base";
const ogTitle = process.env.NEXT_PUBLIC_OG_TITLE ?? appName;
const ogDescription = process.env.NEXT_PUBLIC_OG_DESCRIPTION ?? appDescription;
const baseAppId = process.env.NEXT_PUBLIC_BASE_APP_ID?.trim() || null;
const buttonTitle = process.env.NEXT_PUBLIC_APP_BUTTON_TITLE?.trim() || "Open app";
const iconUrl = "/icon.png";
const ogImageUrl = "/og.png";
const splashImageUrl = resolveAssetUrl(process.env.NEXT_PUBLIC_SPLASH_IMAGE_URL, "/Splash.png");
const miniAppImageUrl = resolveAssetUrl(process.env.NEXT_PUBLIC_IMAGE_URL, "/miniapp-preview.png");
const miniAppUrl = new URL("/", metadataBase).toString();
const miniAppEmbed = JSON.stringify({
  version: "1",
  imageUrl: miniAppImageUrl,
  aspectRatio: "3:2",
  button: {
    title: buttonTitle,
    action: {
      type: "launch_miniapp",
      name: appName.slice(0, 32),
      url: miniAppUrl,
      splashImageUrl,
      splashBackgroundColor: process.env.NEXT_PUBLIC_SPLASH_BG ?? "#0b1020"
    }
  }
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content"
};

export const metadata: Metadata = {
  metadataBase,
  title: appName,
  description: appDescription,
  alternates: {
    canonical: "/"
  },
  icons: {
    icon: iconUrl
  },
  openGraph: {
    title: ogTitle,
    description: ogDescription,
    url: "/",
    siteName: appName,
    images: [ogImageUrl],
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: ogTitle,
    description: ogDescription,
    images: [ogImageUrl]
  },
  other: {
    "fc:frame": miniAppEmbed,
    "fc:miniapp": miniAppEmbed,
    ...(baseAppId ? { "base:app_id": baseAppId } : {})
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="fc:frame" content={miniAppEmbed} />
        <meta name="fc:miniapp" content={miniAppEmbed} />
        {baseAppId ? <meta name="base:app_id" content={baseAppId} /> : null}
      </head>
      <body>
        <Script id="miniapp-runtime-guards" strategy="beforeInteractive">
          {`
            (function () {
              var blockedHosts = {
                "browser-intake-datadoghq.com": true,
                "exceptions.coinbase.com": true,
                "as.coinbase.com": true,
                "cca-lite.coinbase.com": true,
                "www.google-analytics.com": true
              };
              function toMessage(reason) {
                if (reason && typeof reason.message === "string") return reason.message;
                if (typeof reason === "string") return reason;
                return "";
              }
              function parseUrl(input) {
                try {
                  return new URL(String(input), window.location.origin);
                } catch (error) {
                  return null;
                }
              }
              function shouldBlockNetwork(urlValue) {
                if (!urlValue) return false;
                var parsed = parseUrl(urlValue);
                if (!parsed) return false;
                if (parsed.origin === window.location.origin) {
                  if (parsed.pathname.indexOf("/_next/") === 0) return false;
                  if (parsed.pathname.indexOf("/api/") === 0) return false;
                }
                var host = parsed.hostname.toLowerCase();
                if (blockedHosts[host]) return true;
                if (parsed.pathname.indexOf("/cdn-cgi/rum") === 0) {
                  return true;
                }
                return false;
              }
              function getFetchUrl(input) {
                if (typeof input === "string") return input;
                if (input && typeof input === "object") {
                  if (typeof input.url === "string") return input.url;
                  if (typeof input.href === "string") return input.href;
                }
                return "";
              }
              function shouldIgnore(reason) {
                var message = toMessage(reason);
                return (
                  message.indexOf("Unsupported action: eip6963RequestProvider") !== -1 ||
                  message.indexOf("DataCloneError") !== -1 ||
                  message.indexOf("access control checks") !== -1 ||
                  message.indexOf("browser-intake-datadoghq.com") !== -1 ||
                  message.indexOf("wallet.farcaster.xyz") !== -1 ||
                  message.indexOf("analytics_events") !== -1 ||
                  message.indexOf("Access-Control-Allow-Origin") !== -1
                );
              }
              function stopProviderRequest(event) {
                if (!event) return;
                event.stopImmediatePropagation();
              }
              if (typeof window !== "undefined") {
                var originalFetch = window.fetch.bind(window);
                window.fetch = function (input, init) {
                  if (shouldBlockNetwork(getFetchUrl(input))) {
                    return Promise.resolve(new Response(null, { status: 204, statusText: "No Content" }));
                  }
                  return originalFetch(input, init);
                };

                var OriginalXHR = window.XMLHttpRequest;
                if (OriginalXHR) {
                  window.XMLHttpRequest = function () {
                    var xhr = new OriginalXHR();
                    var originalOpen = xhr.open;
                    xhr.open = function (method, url) {
                      if (shouldBlockNetwork(url)) {
                        xhr._blocked = true;
                        xhr._blockedUrl = url;
                      }
                      return originalOpen.apply(xhr, arguments);
                    };
                    var originalSend = xhr.send;
                    xhr.send = function () {
                      if (xhr._blocked) {
                        xhr.readyState = 4;
                        xhr.status = 204;
                        xhr.statusText = "No Content";
                        if (typeof xhr.onreadystatechange === "function") xhr.onreadystatechange();
                        try {
                          var ev = new Event("readystatechange");
                          xhr.dispatchEvent(ev);
                        } catch (e) {}
                        return;
                      }
                      return originalSend.apply(xhr, arguments);
                    };
                    return xhr;
                  };
                }

                window.addEventListener("eip6963:requestProvider", stopProviderRequest, true);
                window.addEventListener("unhandledrejection", function (event) {
                  if (event && shouldIgnore(event.reason)) {
                    event.preventDefault();
                  }
                });
                window.addEventListener("error", function (event) {
                  var reason = event && (event.error || event.message);
                  if (shouldIgnore(reason)) {
                    event.preventDefault();
                  }
                });

                if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
                  var originalSendBeacon = navigator.sendBeacon.bind(navigator);
                  navigator.sendBeacon = function (url, data) {
                    if (shouldBlockNetwork(url)) {
                      return true;
                    }

                    return originalSendBeacon(url, data);
                  };
                }
              }
              if (typeof document !== "undefined") {
                document.addEventListener("eip6963:requestProvider", stopProviderRequest, true);
              }
            })();
          `}
        </Script>
        <AppProviders>
          <LegalDisclaimer />
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
