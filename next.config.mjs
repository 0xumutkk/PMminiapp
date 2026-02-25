/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  async headers() {
    const corsHeaders = [
      { key: "Access-Control-Allow-Origin", value: "*" },
      { key: "Access-Control-Allow-Methods", value: "GET,HEAD,OPTIONS" },
      { key: "Access-Control-Allow-Headers", value: "*" }
    ];

    // WalletConnect / Reown AppKit + Base + Limitless + Farcaster auth
    const cspConnectSrc = [
      "'self'",
      "https:",
      "wss:",
      "https://explorer-api.walletconnect.com",
      "https://rpc.walletconnect.com",
      "https://rpc.walletconnect.org",
      "https://relay.walletconnect.com",
      "https://relay.walletconnect.org",
      "wss://relay.walletconnect.com",
      "wss://relay.walletconnect.org",
      "https://mainnet.base.org",
      "https://*.base.org",
      "https://api.limitless.exchange",
      "https://auth.farcaster.xyz"
    ].join(" ");

    const cspHeaders = [
      {
        key: "Content-Security-Policy",
        value: `connect-src ${cspConnectSrc}`
      }
    ];

    return [
      {
        source: "/_next/static/:path*",
        headers: corsHeaders
      },
      {
        source: "/_next/webpack-hmr",
        headers: corsHeaders
      },
      {
        source: "/__nextjs_original-stack-frames",
        headers: corsHeaders
      },
      {
        source: "/:path*",
        headers: cspHeaders
      }
    ];
  },
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "@react-native-async-storage/async-storage": false
    };
    return config;
  }
};

export default nextConfig;
