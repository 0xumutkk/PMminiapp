# Pulse Markets Base Mini App

This repository implements a Base Mini App with live Limitless markets and onchain trade intents on Base.

## Scope

1. Base Mini App foundation
- Manifest route at `/.well-known/farcaster.json` with `miniapp` + `frame` compatibility keys
- Account association from `FARCASTER_ACCOUNT_ASSOCIATION_JSON`
- MiniKit handshake via `useMiniKit().setMiniAppReady()`
- OnchainKit provider with MiniKit enabled and Base chain wiring
- Read-only first load (no auto-connect)

2. Market data plane
- Limitless API v1 polling (`GET /markets/active`) with point-budget protection
- Redis-backed snapshot cache with in-memory fallback
- `GET /api/markets` snapshot endpoint
- `GET /api/markets/stream` SSE realtime updates

3. Onchain trade intent
- `POST /api/trade/intent` returns approve + trade calls
- SIWF/Quick Auth is required by default in production (override with `TRADE_AUTH_REQUIRED`)
- Market venue metadata used first
- Env fallback support:
  - `USDC_TOKEN_ADDRESS`
  - `LIMITLESS_TRADE_CONTRACT_ADDRESS`
  - `LIMITLESS_TRADE_FUNCTION_SIGNATURE`
  - `LIMITLESS_TRADE_ARG_MAP`

4. Feed performance and reliability
- Vertical virtualized market feed
- Visibility-aware stream connect/disconnect
- Route-level graceful recovery for upstream failures

5. Launch security
- API rate limiting for markets, stream, trade intent
- SIWF auth verification (`POST /api/auth/siwf`) with replay-protected nonce tracking
- Session endpoint (`GET|DELETE /api/auth/session`) backed by HttpOnly auth cookie
- Optional beta allowlist mode
- `GET /api/health` status endpoint

## Environment

Copy `.env.example` to `.env.local` and fill production values.

Required:
- `NEXT_PUBLIC_MINI_APP_URL`
- `FARCASTER_ACCOUNT_ASSOCIATION_JSON`

Recommended:
- `REDIS_URL`
- `LIMITLESS_API_BASE_URL`
- `NEXT_PUBLIC_ONCHAINKIT_API_KEY`

If market metadata is incomplete, set:
- `LIMITLESS_TRADE_CONTRACT_ADDRESS`
- `LIMITLESS_TRADE_FUNCTION_SIGNATURE`
- `LIMITLESS_TRADE_ARG_MAP`

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

- `src/app/.well-known/farcaster.json/route.ts`
- `src/components/providers.tsx`
- `src/components/miniapp-auth-provider.tsx`
- `src/lib/use-farcaster-ready.ts`
- `src/lib/use-miniapp-context.ts`
- `src/lib/security/miniapp-auth.ts`
- `src/app/api/auth/siwf/route.ts`
- `src/app/api/auth/session/route.ts`
- `src/components/vertical-market-feed.tsx`
- `src/app/api/markets/route.ts`
- `src/app/api/markets/stream/route.ts`
- `src/app/api/trade/intent/route.ts`
