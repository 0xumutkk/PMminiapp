import { AppShell } from "@/components/app-shell";
import { MiniAppContextBadge } from "@/components/miniapp-context-badge";
import { WalletStatus } from "@/components/wallet-status";

export default function ProfilePage() {
  return (
    <AppShell title="Profile" subtitle="Identity and account settings" scrollContent>
      <section className="profile-card">
        <h2>Session</h2>
        <MiniAppContextBadge />
        <div className="profile-card__wallet">
          <WalletStatus />
        </div>
      </section>

      <section className="profile-card">
        <h2>Preferences</h2>
        <p>Notifications: Market movements, trade confirmations, and settlement reminders.</p>
        <p>Risk defaults: Stake presets can be tuned from the feed stake input.</p>
      </section>
    </AppShell>
  );
}
