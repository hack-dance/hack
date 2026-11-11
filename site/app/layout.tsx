import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./global.css";
export const metadata: Metadata = {
  metadataBase: new URL("https://hack.foo"),
  title: {
    default: "hack.foo — run the whole project locally",
    template: "%s | Hack",
  },
  description:
    "Hack runs a project's services, environment, secrets, local HTTPS and logs from a .hack/ folder committed with the repository. One command per repo, every project at its own local URL.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
