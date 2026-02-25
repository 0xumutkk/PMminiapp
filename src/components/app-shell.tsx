import { MiniAppContextBadge } from "@/components/miniapp-context-badge";
import { CustomNavBar } from "@/components/custom-nav-bar";
import { WalletStatus } from "@/components/wallet-status";

type AppShellProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  scrollContent?: boolean;
};

export function AppShell({ title, subtitle, children, scrollContent = false }: AppShellProps) {
  return (
    <main className="app-shell">
      <header className="app-shell__top">
        <div className="app-shell__identity">
          <p className="app-shell__title">{title}</p>
          {subtitle ? <p className="app-shell__subtitle">{subtitle}</p> : <MiniAppContextBadge />}
        </div>
        <WalletStatus />
      </header>

      <section className={`app-shell__content${scrollContent ? " app-shell__content--scroll" : ""}`}>
        {children}
      </section>

      <CustomNavBar />
    </main>
  );
}
