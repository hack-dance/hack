import type { MetadataRoute } from "next";
import { source } from "@/lib/source";
export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", ...source.getPages().map((page) => page.url)].map((path) => ({
    url: `https://hack.foo${path}`,
  }));
}
