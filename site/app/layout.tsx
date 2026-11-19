import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import { description, tagline } from "@/lib/home";
import "./global.css";
export const metadata: Metadata = {
  metadataBase: new URL("https://hack.foo"),
  title: {
    default: `hack.foo — ${tagline.charAt(0).toLowerCase()}${tagline.slice(1)}`,
    template: "%s | Hack",
  },
  description,
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
