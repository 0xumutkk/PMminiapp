import { AppShell } from "@/components/app-shell";
import { ProfileActivityPanel } from "@/components/profile-activity-panel";
import { PositionsPanel } from "@/components/positions-panel";
import { WalletStatusSlot } from "@/components/wallet-status-slot";
import { ProfileGuard } from "@/components/profile-guard";
import Link from "next/link";
import styles from "./profile.module.css";

type ProfilePageProps = {
  searchParams?: Promise<{
    view?: string;
  }>;
};

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  const resolvedSearchParams = await searchParams;
  const activeView = resolvedSearchParams?.view === "activity" ? "activity" : "portfolio";
  const isPortfolio = activeView === "portfolio";

  return (
    <AppShell title="Profile" subtitle="Mobile trading cockpit" scrollContent>
      <ProfileGuard>
        <div className={styles.profileHub}>
          <section className={styles.profileHero}>
            <div className={styles.profileHeroTop}>
              <p className={styles.profileHeroEyebrow}>Control Center</p>
              <WalletStatusSlot />
            </div>
            <h2>{isPortfolio ? "Positions at a glance" : "Latest market actions"}</h2>
            <p>{isPortfolio ? "Value, PnL, and claims in one flow." : "Recent opens, settles, and payouts."}</p>
          </section>

          <nav className={styles.profileSwitch} aria-label="Profile sections">
            <Link
              href="/profile?view=portfolio"
              className={`${styles.profileSwitchItem}${activeView === "portfolio" ? ` ${styles.profileSwitchItemActive}` : ""
                }`}
              aria-current={activeView === "portfolio" ? "page" : undefined}
            >
              Portfolio
            </Link>
            <Link
              href="/profile?view=activity"
              className={`${styles.profileSwitchItem}${activeView === "activity" ? ` ${styles.profileSwitchItemActive}` : ""
                }`}
              aria-current={activeView === "activity" ? "page" : undefined}
            >
              Activity
            </Link>
          </nav>

          {activeView === "portfolio" ? (
            <section className={styles.profileFocusCard} id="portfolio">
              <header className={styles.profileFocusCardHead}>
                <h2>Portfolio</h2>
                <p>Live position summary</p>
              </header>
              <PositionsPanel />
            </section>
          ) : (
            <section className={styles.profileFocusCard} id="activity">
              <header className={styles.profileFocusCardHead}>
                <h2>Activity</h2>
                <p>Latest events first</p>
              </header>
              <ProfileActivityPanel />
            </section>
          )}
        </div>
      </ProfileGuard>
    </AppShell>
  );
}
