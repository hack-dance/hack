import type { MetadataRoute } from "next";
import { sources } from "@/lib/source";
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    "/",
    ...Object.values(sources).flatMap((s) => s.getPages().map((p) => p.url)),
  ].map((path) => ({ url: `https://hack.foo${path}` }));
}
