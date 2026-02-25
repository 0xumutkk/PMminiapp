import { AppShell } from "@/components/app-shell";
import { PositionsPanel } from "@/components/positions-panel";

export default function PortfolioPage() {
  return (
    <AppShell title="Portfolio" subtitle="Track positions and claimables" scrollContent>
      <div className="stack">
        <PositionsPanel />
      </div>
    </AppShell>
  );
}
