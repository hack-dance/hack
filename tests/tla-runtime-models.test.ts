import { expect, test } from "bun:test";
import {
  runtimeModelControlConfig,
  runtimeModels,
} from "../scripts/lib/tla-runtime-models.ts";

function tlaWitness({
  invariant,
  action,
  fields,
}: {
  invariant: string;
  action: string;
  fields: readonly string[];
}): string {
  return `Error: Invariant ${invariant} is violated.\nState 2: <${action} line 1>\n${fields.map((field) => `/\\ ${field}`).join("\n")}`;
}

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

test("missing-lock old-holder witness covers only incomplete repair stages", () => {
  const model = runtimeModels.find(
    (entry) => entry.name === "missing-publication-lock"
  );
  const control = model?.additionalControls.find(
    (entry) => entry.name === "old-holder"
  );
  expect(control).toBeDefined();
  const witness = (stage: string) =>
    tlaWitness({
      invariant: "NoUncoordinatedLegacy",
      action: "OldHolderPublish",
      fields: [
        `stage = "${stage}"`,
        'repair = "active"',
        "gate = TRUE",
        "legacyPublished = TRUE",
      ],
    });
  for (const stage of [
    "intent",
    "temp",
    "linked",
    "final",
    "journal",
    "socket",
    "owner",
  ]) {
    expect(
      control?.verify({ negative: true, exitCode: 12, output: witness(stage) })
    ).toBe(true);
  }
  for (const stage of ["absent", "complete", "unknown"]) {
    expect(
      control?.verify({ negative: true, exitCode: 12, output: witness(stage) })
    ).toBe(false);
  }
  const valid = witness("temp");
  for (const invalid of [
    valid.replace("<OldHolderPublish ", "<Commit "),
    valid.replace('repair = "active"', 'repair = "crashed"'),
    valid.replace("gate = TRUE", "gate = FALSE"),
    valid.replace("legacyPublished = TRUE", "legacyPublished = FALSE"),
    valid.replace("Invariant NoUncoordinatedLegacy", "Invariant Other"),
    valid.replace(
      '/\\ stage = "temp"',
      'State 3: <Other line 2>\n/\\ stage = "temp"'
    ),
    `Error: unrelated checker failure\n${valid}`,
  ]) {
    expect(
      control?.verify({ negative: true, exitCode: 12, output: invalid })
    ).toBe(false);
  }
});

test("previous-boot HTTPS publisher witness accepts only the two owner-archived stages", () => {
  const model = runtimeModels.find(
    (entry) => entry.name === "previous-boot-shared-https"
  );
  expect(model).toBeDefined();
  const common = [
    "intent = TRUE",
    "complete = FALSE",
    "crashed = TRUE",
    "published = TRUE",
    "unsafePublication = TRUE",
  ];
  const witness = (archived: string) =>
    tlaWitness({
      invariant: "NoPrematurePublication",
      action: "Publish",
      fields: [...common, `archived = ${archived}`],
    });
  for (const archived of ['{"owner"}', '{"owner", "socket"}']) {
    expect(
      model?.verify({ negative: true, exitCode: 12, output: witness(archived) })
    ).toBe(true);
  }
  for (const archived of ["{}", '{"socket"}']) {
    expect(
      model?.verify({ negative: true, exitCode: 12, output: witness(archived) })
    ).toBe(false);
  }
  const valid = witness('{"owner", "socket"}');
  for (const invalid of [
    valid.replace("<Publish ", "<ArchiveOwner "),
    valid.replace("complete = FALSE", "complete = TRUE"),
    valid.replace("Invariant NoPrematurePublication", "Invariant Other"),
    `${valid}\nError: unrelated checker failure`,
    `Parse error\n${valid}`,
    `Model checking completed. No error has been found.\n${valid}`,
    valid.replace(
      '/\\ archived = {"owner", "socket"}',
      'State 3: <Other line 2>\n/\\ archived = {"owner", "socket"}'
    ),
  ]) {
    expect(
      model?.verify({ negative: true, exitCode: 12, output: invalid })
    ).toBe(false);
  }
});

test("previous-boot HTTPS archive controls accept only model-derived move witnesses", () => {
  const model = runtimeModels.find(
    (entry) => entry.name === "previous-boot-shared-https"
  );
  for (const [name, invariantFields] of [
    [
      "stale-selection",
      [
        "intent = TRUE",
        "selected = 1",
        "version = 2",
        "engine = TRUE",
        'admission = "recovery"',
        "unsafeArchive = TRUE",
      ],
    ],
    [
      "unproved-archive",
      [
        "intent = TRUE",
        "eligible = FALSE",
        "engine = TRUE",
        'admission = "recovery"',
        "unsafeArchive = TRUE",
      ],
    ],
  ] as const) {
    const control = model?.additionalControls.find(
      (entry) => entry.name === name
    );
    expect(control).toBeDefined();
    const witness = (action: string, archived: string) =>
      tlaWitness({
        invariant: "NoUnprovedArchive",
        action,
        fields: [...invariantFields, `archived = ${archived}`],
      });
    for (const action of ["ArchiveOwner", "ArchiveSocket"]) {
      const own = action === "ArchiveOwner" ? "owner" : "socket";
      for (const archived of [`{"${own}"}`, '{"owner", "socket"}']) {
        expect(
          control?.verify({
            negative: true,
            exitCode: 12,
            output: witness(action, archived),
          })
        ).toBe(true);
      }
      for (const archived of [
        "{}",
        action === "ArchiveOwner" ? '{"socket"}' : '{"owner"}',
      ]) {
        expect(
          control?.verify({
            negative: true,
            exitCode: 12,
            output: witness(action, archived),
          })
        ).toBe(false);
      }
    }
    const valid = witness("ArchiveSocket", '{"owner", "socket"}');
    expect(
      control?.verify({
        negative: true,
        exitCode: 12,
        output: valid.replace(
          '/\\ archived = {"owner", "socket"}',
          'State 3: <Other line 2>\n/\\ archived = {"owner", "socket"}'
        ),
      })
    ).toBe(false);
    expect(
      control?.verify({
        negative: true,
        exitCode: 12,
        output: valid.replace("unsafeArchive = TRUE", "unsafeArchive = FALSE"),
      })
    ).toBe(false);
  }
});
