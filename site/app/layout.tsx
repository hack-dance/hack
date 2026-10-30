import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import "./global.css";
export const metadata: Metadata = {
  metadataBase: new URL("https://hack.foo"),
  title: {
    default: "hack.foo — local project environments",
    template: "%s | Hack",
  },
  description:
    "Run project services, environment, secrets, local HTTPS and logs from configuration kept in your repository.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
