# Pulse Markets Mini App (Phase 1 + 2)

This repository implements phases 1 through 5 from your architecture document:

- Phase 1: Farcaster Mini App foundation (manifest, frame readiness, Base wallet connector)
- Phase 2: Market data plane (Limitless polling, point-budget protection, Redis cache, realtime SSE)
- Phase 3: Transaction layer (approve + trade batching with EIP-5792 path and sequential fallback)
- Phase 4: Vertical feed performance layer (virtualized window + IntersectionObserver)
- Phase 5: Launch security layer (API rate limiting, beta allowlist gating, health/observability)

## What is implemented

1. Farcaster Mini App foundation
- Dynamic manifest at `/.well-known/farcaster.json`
- Account association values read from environment
- Frame SDK boot (`sdk.actions.ready()`)
- Wagmi config on Base with `@farcaster/frame-wagmi-connector`
- Auto wallet connect behavior

2. Market data plane
- Limitless public API client with rolling point budgets:
  - 500 points / 10 seconds
  - 1500 points / minute
- Polling indexer service (`LIMITLESS_POLL_INTERVAL_MS`)
- Redis cache (`REDIS_URL`) with in-memory fallback
- Snapshot endpoint: `GET /api/markets`
- Realtime stream endpoint (SSE): `GET /api/markets/stream`
- Wallet connect fallback button for non-Farcaster browser testing

3. Transaction layer
- Trade intent endpoint: `POST /api/trade/intent`
- Server-generated call bundle (`approve` + `trade`) using configurable function signature
- Trade contract address resolved dynamically from market payload (`tradeVenue.venueExchange`)
- Client executes with `useSendCalls` (single signature) and falls back to sequential txs if wallet lacks EIP-5792

4. Feed performance layer
- Virtualized rendering window around active card (reduces DOM size in WebView)
- `IntersectionObserver` driven active-card detection
- Visibility-aware SSE behavior (stream disconnects in hidden tab and reconnects on resume)

5. Security/launch layer
- API rate limiting on markets, stream, and trade intent routes
- Optional beta allowlist (`BETA_MODE=true`)
- Health endpoint: `GET /api/health`
- Structured server logs for degraded/recovered states

## Environment

Copy `.env.example` into `.env.local` and fill values.

Required for Mini App deployment:
- `NEXT_PUBLIC_MINI_APP_URL`
- `FARCASTER_ACCOUNT_ASSOCIATION_JSON`

Recommended:
- `REDIS_URL`
- `LIMITLESS_API_BASE_URL`
- `LIMITLESS_TRADE_FUNCTION_SIGNATURE` (only as fallback override)

## Run locally

```bash
npm install
npm run dev
```

Optional Redis:

```bash
docker compose up -d redis
```

Optional dedicated indexer worker process:

```bash
npm run worker
```

## Key files

- `src/app/.well-known/farcaster.json/route.ts`
- `src/lib/wagmi.ts`
- `src/lib/use-farcaster-ready.ts`
- `src/lib/limitless-client.ts`
- `src/lib/rate-budget.ts`
- `src/lib/cache.ts`
- `src/lib/indexer.ts`
- `src/app/api/markets/route.ts`
- `src/app/api/markets/stream/route.ts`
- `src/components/vertical-market-feed.tsx`
- `src/app/api/trade/intent/route.ts`
- `src/lib/trade/use-trade-executor.ts`
- `src/lib/trade/build-intent.ts`
- `src/app/api/health/route.ts`
- `src/lib/security/rate-limit.ts`
