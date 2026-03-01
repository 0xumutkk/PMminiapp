"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavHref = "/feed" | "/markets" | "/profile";

type NavItem = {
  href: NavHref;
  label: string;
  icon: React.ReactNode;
  primary?: boolean;
};

function FeedIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M9 8l8 4-8 4z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function MarketsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M3 19h18M6 15l4-4 4 3 4-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="6" cy="15" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="10" cy="11" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="14" cy="14" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18" cy="8" r="1.4" fill="currentColor" stroke="none" />
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
  { href: "/markets", label: "Markets", icon: <MarketsIcon /> },
  { href: "/feed", label: "Feed", icon: <FeedIcon />, primary: true },
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
            className={[
              "custom-nav__item",
              item.primary ? "custom-nav__item--primary" : "",
              active ? "custom-nav__item--active" : ""
            ]
              .filter(Boolean)
              .join(" ")}
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
