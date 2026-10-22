/**
 * `bun test` preload (bunfig.toml): fails the run when a test leaves an
 * untracked file in the repository checkout. See checkout-write-guard.ts.
 */
import { afterAll } from "bun:test";
import { installCheckoutWriteGuard } from "./checkout-write-guard.ts";

installCheckoutWriteGuard({ start: import.meta.dir, afterAll });
