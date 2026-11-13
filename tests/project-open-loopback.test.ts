import { expect, spyOn, test } from "bun:test";
import { emitOpenOrigin } from "../src/commands/project.ts";

test("open refuses a confirmed loopback failure before JSON or browser output", async () => {
  for (const json of [true, false]) {
    const write = spyOn(process.stdout, "write");
    try {
      await expect(
        emitOpenOrigin({
          url: "https://app.example.test",
          json,
          checkLoopback: async () =>
            "port 443 on loopback is not reaching the Hack proxy",
        })
      ).rejects.toMatchObject({
        code: "E_GLOBAL_INFRA_DOWN",
        message: "port 443 on loopback is not reaching the Hack proxy",
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  }
});
