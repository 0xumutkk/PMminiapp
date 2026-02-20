import { getMarketIndexer } from "../lib/indexer";

async function main() {
  const indexer = await getMarketIndexer();
  await indexer.pollOnce();

  // Keep worker process alive for continuous polling.
  setInterval(() => {
    // no-op heartbeat
  }, 60_000);
}

main().catch((error) => {
  console.error("Indexer worker failed", error);
  process.exit(1);
});
