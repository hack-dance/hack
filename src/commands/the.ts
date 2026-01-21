import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { playPlanetAnimation } from "../ui/planet.ts";
import { getPlanetAnimation } from "../ui/planet-animations.ts";

const theSpec = defineCommand({
  name: "the",
  summary: "Crash override",
  group: "Fun",
  options: [],
  positionals: [],
  subcommands: [],
  expandInRootHelp: true,
} as const);

const optVariant = defineOption({
  name: "variant",
  type: "string",
  long: "--variant",
  valueHint: "<cut|mash|cycle|random>",
  description: "Animation variant",
  defaultValue: "cycle",
} as const);

const optLoop = defineOption({
  name: "loop",
  type: "boolean",
  long: "--loop",
  description: "Loop until Ctrl+C",
  defaultValue: "true",
} as const);

const planetOptions = [optVariant, optLoop] as const;
const planetPositionals = [] as const;

type PlanetArgs = CommandArgs<typeof planetOptions, typeof planetPositionals>;

const planetSpec = defineCommand({
  name: "planet",
  summary: "Crash override",
  group: "Fun",
  options: planetOptions,
  positionals: planetPositionals,
  subcommands: [],
} as const);

export const theCommand = defineCommand({
  ...theSpec,
  subcommands: [withHandler(planetSpec, handlePlanet)],
} as const);

async function handlePlanet({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PlanetArgs;
}): Promise<number> {
  const raw = (args.options.variant ?? "random").trim().toLowerCase();
  const variant = parseVariant(raw);
  const animations =
    variant === "cycle"
      ? [
          getPlanetAnimation({ variant: "cut" }),
          getPlanetAnimation({ variant: "mash" }),
        ]
      : [getPlanetAnimation({ variant })];
  const ok = await playPlanetAnimation({
    animations,
    loop: args.options.loop === true,
  });
  return ok ? 0 : 1;
}

function parseVariant(raw: string): "cut" | "mash" | "cycle" | "random" {
  if (raw === "" || raw === "random") {
    return "random";
  }
  if (raw === "cut") {
    return "cut";
  }
  if (raw === "mash") {
    return "mash";
  }
  if (raw === "cycle") {
    return "cycle";
  }
  throw new CliUsageError(`Invalid --variant: ${raw}`);
}
