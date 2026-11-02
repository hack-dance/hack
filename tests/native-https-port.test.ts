import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { checkNativeHttpsPort } from "../src/backends/native-https-port.ts";
import { expectCodedRefusal } from "./helpers/closed-refusal.ts";

test("port probe reports an existing listener without closing or adopting it", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture has no TCP address");
    }
    const refusal = await expectCodedRefusal(
      checkNativeHttpsPort(address.port),
      "E_CONFIG_INVALID",
      "already in use"
    );
    // Value-free: the selected port number is not echoed.
    expect(refusal.message).not.toContain(String(address.port));
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("port probe releases its own temporary listener", async () => {
  await expect(checkNativeHttpsPort(0)).resolves.toBeUndefined();
});
