import type { Metadata, Viewport } from "next";
import { geistMono, instrumentSerif, spaceGrotesk } from "@/lib/fonts";
import Cursor from "@/components/Cursor";
import "./globals.css";

export const metadata: Metadata = {
  title: "loom — durable AI-commerce backend",
  description:
    "Cart abandonment, dynamic checkout with margin-bounded discount negotiation, shipping monitor, return triage. Vercel Workflows + Stripe + Anthropic with cost-aware model routing. Companion build to forge.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0A0A0B",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${spaceGrotesk.variable} ${geistMono.variable} ${instrumentSerif.variable}`}
    >
      <head>
        <link
          rel="preload"
          href="/fonts/migra/Migra-Italic-Regular.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body className="min-h-screen w-full overflow-x-hidden">
        <Cursor />
        {children}
      </body>
    </html>
  );
}
