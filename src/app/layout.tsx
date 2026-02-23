import type { Metadata } from "next";
import "./globals.css";
import { AppProviders } from "@/components/providers";

function resolveBaseUrl(raw: string | undefined) {
  try {
    return new URL(raw ?? "https://example.com");
  } catch {
    return new URL("https://example.com");
  }
}

const baseUrl = resolveBaseUrl(process.env.NEXT_PUBLIC_MINI_APP_URL);
const baseUrlString = baseUrl.toString().replace(/\/$/, "");
const appName = process.env.NEXT_PUBLIC_APP_NAME ?? "Pulse Markets";
const appDescription =
  process.env.NEXT_PUBLIC_APP_DESCRIPTION ?? "Base Mini App for live prediction markets on Base";
const ogTitle = process.env.NEXT_PUBLIC_OG_TITLE ?? appName;
const ogDescription = process.env.NEXT_PUBLIC_OG_DESCRIPTION ?? appDescription;
const iconUrl = process.env.NEXT_PUBLIC_ICON_URL ?? `${baseUrlString}/icon.png`;
const ogImageUrl = process.env.NEXT_PUBLIC_OG_IMAGE_URL ?? `${baseUrlString}/og.png`;

export const metadata: Metadata = {
  metadataBase: baseUrl,
  title: appName,
  description: appDescription,
  alternates: {
    canonical: "/"
  },
  icons: {
    icon: iconUrl
  },
  openGraph: {
    title: ogTitle,
    description: ogDescription,
    url: baseUrlString,
    siteName: appName,
    images: [ogImageUrl],
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: ogTitle,
    description: ogDescription,
    images: [ogImageUrl]
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
