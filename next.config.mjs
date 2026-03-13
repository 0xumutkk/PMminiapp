import path from "node:path";

const emptyModulePath = path.resolve("./src/lib/shims/empty-module.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  experimental: {
    optimizePackageImports: ["wagmi", "viem", "@tanstack/react-query"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.googleusercontent.com" },
      { protocol: "https", hostname: "*.limitless.exchange" },
      { protocol: "https", hostname: "imagedelivery.net" }
    ]
  },
  turbopack: {
    resolveAlias: {
      "@react-native-async-storage/async-storage": {
        browser: emptyModulePath
      }
    }
  },
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@react-native-async-storage/async-storage": emptyModulePath
    };
    return config;
  },
  async headers() {
    const frameAncestors = [
      "'self'",
      "https://base.app",
      "https://*.base.app",
      "https://base.dev",
      "https://*.base.dev",
      "https://base.org",
      "https://*.base.org"
    ].join(" ");

    const cspConnectSrc = [
      "'self'",
      "https://explorer-api.walletconnect.com",
      "https://rpc.walletconnect.com",
      "https://relay.walletconnect.com",
      "wss://relay.walletconnect.com",
      "https://api.limitless.exchange",
      "https://api.upbit.com",
      "https://api.coingecko.com",
      "https://*.base.org",
      "https://base-rpc.publicnode.com",
      "https://mainnet.base.org"
    ].join(" ");

    const cspHeader = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https://*.googleusercontent.com https://*.limitless.exchange https://imagedelivery.net blob:",
      "font-src 'self' https://fonts.gstatic.com",
      `connect-src ${cspConnectSrc}`,
      `frame-ancestors ${frameAncestors}`,
      "frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org",
      "base-uri 'self'",
      "form-action 'self'"
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: cspHeader },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,OPTIONS,PATCH,DELETE,POST,PUT" },
          { key: "Access-Control-Allow-Headers", value: "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version" }
        ]
      }
    ];
  }
};

export default nextConfig;
