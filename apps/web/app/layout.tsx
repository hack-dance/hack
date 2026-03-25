import type { ReactNode } from "react";

import "./globals.css";

import { appMetadata } from "@/src/lib/workspace-scaffold";

export const metadata = appMetadata;

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
