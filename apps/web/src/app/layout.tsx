import type { Metadata } from "next";
import "./globals.css";

// System font stack for now; DESIGN.md (A-DES-5) picks the type before Task 4.1.
// Avoids next/font/google, which needs network access at build time.

export const metadata: Metadata = {
  title: "OBD2 Diagnostics",
  description: "AI automotive diagnostics",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
