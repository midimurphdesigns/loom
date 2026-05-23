import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "loom — durable AI-commerce backend",
  description:
    "Cart abandonment, dynamic checkout with margin-bounded discount negotiation, shipping monitor, return triage. Vercel Workflows + Stripe + Anthropic with cost-aware model routing. Companion build to forge.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /* suppressHydrationWarning silences false-positive React warnings
     * for attributes browser extensions write onto <html> before React
     * hydrates (Google Analytics Opt-Out, dark-reader, etc.). It only
     * suppresses direct attribute mismatches on <html>/<body> — real
     * hydration mismatches deeper in the tree still surface. */
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
