import { Database } from "bun:sqlite";
import { marker } from "./marker.ts";

const db = new Database("/data/proof.sqlite", { readonly: true });
Bun.serve({
  hostname: "0.0.0.0",
  port: 3000,
  fetch() {
    const row = db
      .query<{ value: string }, []>("SELECT value FROM proof WHERE id=1")
      .get();
    if (!row) {
      throw new Error("Missing persistent token");
    }
    return Response.json({ marker, token: row.value });
  },
});
