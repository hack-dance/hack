import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { dirname, resolve } from "node:path";

/** Compile-time fixture entry only. Production builds still use index.ts directly. */
const blocked = () => {
  throw new Error("Upgrade fixture refuses external network access.");
};
Object.defineProperty(dns, "lookup", { value: async () => blocked() });
syncBuiltinESMExports();
Object.defineProperty(globalThis, "fetch", { value: async () => blocked() });
const connect = net.Socket.prototype.connect;
Object.defineProperty(net.Socket.prototype, "connect", {
  value(this: net.Socket, ...args: Parameters<typeof connect>) {
    const address: unknown = args[0];
    const path =
      typeof address === "string"
        ? address
        : typeof address === "object" && address !== null && "path" in address
          ? address.path
          : null;
    const temp = process.env.TMPDIR;
    if (
      typeof path !== "string" ||
      !temp ||
      !resolve(path).startsWith(`${dirname(temp)}/`)
    ) {
      return blocked();
    }
    return Reflect.apply(connect, this, args);
  },
});

if (Bun.argv[2] === "--upgrade-fixture-network-check") {
  let refused = 0;
  try {
    await fetch("https://network-forbidden.invalid");
  } catch {
    refused++;
  }
  try {
    await dns.lookup("network-forbidden.invalid");
  } catch {
    refused++;
  }
  try {
    new net.Socket().connect(443, "network-forbidden.invalid");
  } catch {
    refused++;
  }
  process.exit(refused === 3 ? 0 : 89);
}
await import("../../index.ts");
