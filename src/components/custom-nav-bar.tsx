"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavHref = "/feed" | "/markets" | "/portfolio" | "/activity" | "/profile";

type NavItem = {
  href: NavHref;
  label: string;
  icon: React.ReactNode;
};

function FeedIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M4 4h16v16H4z" />
      <path d="M9 8l8 4-8 4z" fill="currentColor" />
    </svg>
  );
}

function MarketsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 19h18M6 15l4-4 4 3 4-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="6" cy="15" r="1.5" />
      <circle cx="10" cy="11" r="1.5" />
      <circle cx="14" cy="14" r="1.5" />
      <circle cx="18" cy="8" r="1.5" />
    </svg>
  );
}

function PortfolioIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="7" width="18" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="M9 12h6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4h7A1.5 1.5 0 0 1 17 5.5V7" fill="none" stroke="currentColor" strokeWidth="1.9" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 12h4l2.2-4.2L13 16l2.3-4H21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 12a4.2 4.2 0 1 0-4.2-4.2A4.2 4.2 0 0 0 12 12zM4 20a8 8 0 0 1 16 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { href: "/feed", label: "Feed", icon: <FeedIcon /> },
  { href: "/markets", label: "Markets", icon: <MarketsIcon /> },
  { href: "/portfolio", label: "Portfolio", icon: <PortfolioIcon /> },
  { href: "/activity", label: "Activity", icon: <ActivityIcon /> },
  { href: "/profile", label: "Profile", icon: <ProfileIcon /> }
];

export function CustomNavBar() {
  const pathname = usePathname();

  return (
    <nav className="custom-nav" aria-label="Primary">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`custom-nav__item${active ? " custom-nav__item--active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="custom-nav__icon">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
