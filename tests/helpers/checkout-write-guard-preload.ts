/**
 * `bun test` preload (bunfig.toml): fails the run when a test creates or
 * changes a file in the repository checkout or leaves a project in /tmp.
 * See checkout-write-guard.ts.
 */
import { afterAll } from "bun:test";
import { lstatSync } from "node:fs";
import { installCheckoutWriteGuard } from "./checkout-write-guard.ts";

installCheckoutWriteGuard({ start: import.meta.dir, afterAll });

afterAll(() => {
  if (lstatSync("/tmp/.hack", { throwIfNoEntry: false })) {
    throw new Error(
      "Suite left a Hack project at /tmp/.hack or inherited one. Use an owned project fixture. The shared path was not removed."
    );
  }
});
