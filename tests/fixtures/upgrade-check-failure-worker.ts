import { CommandError } from "../../src/lib/shell.ts";
import { upgradeCheckFailureClass } from "../../src/lib/upgrade-check-failure.ts";

// Other test files replace shell.ts's CommandError constructor. Classify real
// module instances in one fresh child, without printing their private fields.
const sentinel = "fixture-value-must-stay-private";
const cases: unknown[] = [
  new TypeError(sentinel),
  new SyntaxError(sentinel),
  new RangeError(sentinel),
  Object.assign(new Error(sentinel), { code: "EACCES" }),
  Object.assign(new Error(sentinel), { code: "ENOENT" }),
  Object.assign(new Error(sentinel), { code: sentinel, name: sentinel }),
  new CommandError({
    cmd: [sentinel],
    exitCode: 1,
    stdout: sentinel,
    stderr: sentinel,
  }),
  sentinel,
];
console.log(JSON.stringify(cases.map(upgradeCheckFailureClass)));
