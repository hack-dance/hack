import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./global.css";
export const metadata: Metadata = {
  metadataBase: new URL("https://hack.foo"),
  title: {
    default: "hack.foo — run every project, branch and worktree at once",
    template: "%s | Hack",
  },
  description:
    "Run your whole project locally. Every project, branch and git worktree runs side by side at its own HTTPS address.",
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
