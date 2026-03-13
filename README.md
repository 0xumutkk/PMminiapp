# Swipen Base Mini App

This repository implements a Base App-ready web app with live Limitless markets and onchain trade intents on Base.

## Scope

1. Base App foundation
- Base Account connector + injected wallet fallback
- Base app metadata via `NEXT_PUBLIC_BASE_APP_ID`
- Builder code support via `NEXT_PUBLIC_BASE_BUILDER_CODE`
- Read-only first load (no auto-connect)

2. Market data plane
- Limitless API v1 polling (`GET /markets/active`) with point-budget protection
- Redis-backed snapshot cache with in-memory fallback
- `GET /api/markets` snapshot endpoint
- `GET /api/markets/stream` SSE realtime updates

3. Onchain trade intent
- `POST /api/trade/intent` supports `buy`, `sell`, and `redeem` actions
- SIWE-backed auth is required by default in production (override with `TRADE_AUTH_REQUIRED`)
- Market venue metadata used first
- Env fallback support:
  - `USDC_TOKEN_ADDRESS`
  - `LIMITLESS_TRADE_CONTRACT_ADDRESS`
  - `LIMITLESS_TRADE_FUNCTION_SIGNATURE`
  - `LIMITLESS_TRADE_ARG_MAP`
  - `LIMITLESS_SELL_CONTRACT_ADDRESS`
  - `LIMITLESS_SELL_FUNCTION_SIGNATURE`
  - `LIMITLESS_SELL_ARG_MAP`
  - `LIMITLESS_REDEEM_CONTRACT_ADDRESS`
  - `LIMITLESS_REDEEM_FUNCTION_SIGNATURE`
  - `LIMITLESS_REDEEM_ARG_MAP`
  - `TRADE_APPROVE_ACTIONS`

4. Feed performance and reliability
- Vertical virtualized market feed
- Visibility-aware stream connect/disconnect
- Route-level graceful recovery for upstream failures

5. Launch security
- API rate limiting for markets, stream, trade intent
- SIWE auth verification (`POST /api/auth/siwe`) with signed session cookies
- Session endpoint (`GET|DELETE /api/auth/session`) backed by HttpOnly auth cookie
- Optional beta allowlist mode
- `GET /api/health` status endpoint

## Environment

Copy `.env.example` to `.env.local` and fill production values.

Required:
- `NEXT_PUBLIC_MINI_APP_URL`
- `AUTH_SESSION_SECRET`

Recommended:
- `REDIS_URL`
- `LIMITLESS_API_BASE_URL`
- `NEXT_PUBLIC_BASE_APP_ID`
- `NEXT_PUBLIC_BASE_BUILDER_CODE`

If market metadata is incomplete, set:
- `LIMITLESS_TRADE_CONTRACT_ADDRESS`
- `LIMITLESS_TRADE_FUNCTION_SIGNATURE`
- `LIMITLESS_TRADE_ARG_MAP`

For position exits and settlement claims, set:
- `LIMITLESS_SELL_CONTRACT_ADDRESS`
- `LIMITLESS_SELL_FUNCTION_SIGNATURE`
- `LIMITLESS_SELL_ARG_MAP`
- `LIMITLESS_REDEEM_CONTRACT_ADDRESS`
- `LIMITLESS_REDEEM_FUNCTION_SIGNATURE`
- `LIMITLESS_REDEEM_ARG_MAP`

## Run

```bash
npm install
npm run dev
```

Optional Redis:

```bash
docker compose up -d redis
```

Optional worker:

```bash
npm run worker
```

## Key files

- `src/components/providers.tsx`
- `src/components/miniapp-auth-provider.tsx`
- `src/lib/wagmi.ts`
- `src/lib/security/miniapp-auth.ts`
- `src/app/api/auth/siwe/route.ts`
- `src/app/api/auth/session/route.ts`
- `src/components/vertical-market-feed.tsx`
- `src/app/api/markets/route.ts`
- `src/app/api/markets/stream/route.ts`
- `src/app/api/trade/intent/route.ts`
