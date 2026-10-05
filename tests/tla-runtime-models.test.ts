import { expect, test } from "bun:test";
import {
  runtimeModelControlConfig,
  runtimeModels,
} from "../scripts/lib/tla-runtime-models.ts";

const contracts = runtimeModels.flatMap((model) => [
  model,
  ...("additionalControls" in model
    ? (model.additionalControls ?? []).map((control) => ({
        ...control,
        name: `${model.name}/${control.name}`,
      }))
    : []),
]);
for (const model of contracts) {
  test(`${model.name}: evidence must establish exploration and the intended failure`, () => {
    const positive = `Model checking completed. No error has been found.\n${model.states} distinct states found, 0 states left on queue.`;
    expect(
      model.verify({ negative: false, exitCode: 0, output: positive })
    ).toBe(true);
    for (const output of [
      "",
      positive.replace(`${model.states} distinct`, "999 distinct"),
      positive.replace("0 states left", "1 states left"),
    ]) {
      expect(model.verify({ negative: false, exitCode: 0, output })).toBe(
        false
      );
    }
    const header = `Invariant ${model.invariant} is violated.\nState 2: <${model.action} line 1>`;
    const fields = model.fields.map((field) => `/\\ ${field}`);
    const output = `${header}\n${fields.join("\n")}`;
    expect(model.verify({ negative: true, exitCode: 12, output })).toBe(true);
    for (const exitCode of [null, 0, 1, 124]) {
      expect(model.verify({ negative: true, exitCode, output })).toBe(false);
    }
    for (const invalid of [
      "Parse error",
      output.replace(`Invariant ${model.invariant}`, "Invariant Wrong"),
      output.replace(`<${model.action} `, "<Other "),
      `${header}\n${fields[0]}\nState 3: <Other line 2>\n${fields[1]}`,
    ]) {
      expect(
        model.verify({ negative: true, exitCode: 12, output: invalid })
      ).toBe(false);
    }
  });
}

test("runtime model config selection rejects paths and arbitrary filenames", () => {
  expect(runtimeModelControlConfig("mixed-completed")).toBe(
    "mixed-completed.cfg"
  );
  for (const name of [
    "../positive",
    "/tmp/control",
    "mixed.cfg",
    "",
    "a".repeat(65),
    "mixed/completed",
    "negative\0",
    "Mixed",
  ]) {
    expect(() => runtimeModelControlConfig(name)).toThrow(
      "Invalid runtime model control name"
    );
  }
});

test("registry ownership control requires live successor deletion in the same Reap state", () => {
  const model = runtimeModels.find((entry) => entry.name === "registry-writer");
  expect(model).toBeDefined();
  const output =
    "Invariant NoLiveOwnershipLoss is violated.\nState 16: <Reap line 72>\n/\\ unsafeReap = TRUE\n/\\ lock = 0\n/\\ guard = 0\n";
  expect(model?.verify({ negative: true, exitCode: 12, output })).toBe(true);
  for (const invalid of [
    output.replace("unsafeReap = TRUE", "unsafeReap = FALSE"),
    output.replace("lock = 0", "lock = 2"),
    output.replace("guard = 0", "guard = 1"),
    output.replace("/\\ lock", "State 17: <Reap line 72>\n/\\ lock"),
  ]) {
    expect(
      model?.verify({ negative: true, exitCode: 12, output: invalid })
    ).toBe(false);
  }
});
