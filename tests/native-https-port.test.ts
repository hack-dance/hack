import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { checkNativeHttpsPort } from "../src/backends/native-https-port.ts";

test("port probe reports an existing listener without closing or adopting it", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture has no TCP address");
    }
    await expect(checkNativeHttpsPort(address.port)).rejects.toThrow(
      "already in use"
    );
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("port probe releases its own temporary listener", async () => {
  await expect(checkNativeHttpsPort(0)).resolves.toBeUndefined();
});
