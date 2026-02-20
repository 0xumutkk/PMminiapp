import { getMarketIndexer } from "@/lib/indexer";
import { isBetaModeEnabled } from "@/lib/security/beta-access";

export const runtime = "nodejs";

export async function GET() {
  const now = new Date().toISOString();

  try {
    const indexer = await getMarketIndexer();

    return Response.json(
      {
        status: "ok",
        now,
        betaMode: isBetaModeEnabled(),
        indexer: {
          lastUpdatedAt: indexer.getLastUpdatedAt(),
          lastError: indexer.getLastError()
        }
      },
      {
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown health route error";

    return Response.json(
      {
        status: "degraded",
        now,
        error: message
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  }
}
