import { createFromSource } from "fumadocs-core/search/server";
import { sources } from "@/lib/source";
const handlers = {
  v4: createFromSource(sources.v4),
  v5: createFromSource(sources.v5),
};
export function GET(request: Request) {
  const version = new URL(request.url).searchParams.get("version") ?? "v5";
  if (version !== "v4" && version !== "v5")
    return Response.json({ error: "Unknown docs version" }, { status: 400 });
  return handlers[version].GET(request);
}
