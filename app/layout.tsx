import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "HIDC 2026 · Judge Console",
  description: "Houston International Diabolo Competition scoring workspace",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
