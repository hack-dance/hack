import { afterAll } from "bun:test";
import { testMux } from "./tmux-isolation-preload.ts";

// Register last: the checkout guard also spawns children during its teardown.
afterAll(() => testMux.close());
