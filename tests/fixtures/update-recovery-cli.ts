// Compile-time fixture entry. Production index.ts has no update endpoint override.
const endpoint = new URL(
  process.env.HACK_TEST_UPDATE_FIXTURE_ENDPOINT ?? "http://127.0.0.1:1"
);
if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  !endpoint.port
) {
  throw new Error("Fixture endpoint must be explicit loopback.");
}
const network = globalThis.fetch;
Object.defineProperty(globalThis, "fetch", {
  value: (url: string | URL, init?: RequestInit) => {
    const official = new URL(String(url));
    if (
      official.protocol !== "https:" ||
      !["api.github.com", "github.com"].includes(official.hostname)
    ) {
      throw new Error("Fixture refuses external network.");
    }
    return network(new URL(official.pathname, endpoint), init);
  },
});
await import("../../index.ts");
