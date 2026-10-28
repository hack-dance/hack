import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import "./global.css";
export const metadata: Metadata = {
  metadataBase: new URL("https://hack.foo"),
  title: {
    default: "Hack — your machine is the platform",
    template: "%s | Hack",
  },
  description:
    "Run local project services, env, secrets, HTTPS, logs and sessions together.",
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
