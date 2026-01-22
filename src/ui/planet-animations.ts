import { isRecord, isStringArray } from "../lib/guards.ts";

import { PLANET_ANIMATIONS_DATA } from "./planet-animations.data.ts";

export type PlanetAnimationName =
  (typeof PLANET_ANIMATIONS_DATA)[number]["name"];

export interface PlanetAnimation {
  readonly name: PlanetAnimationName;
  readonly fps: number;
  readonly frames: readonly string[];
}

export function getPlanetAnimation(opts: {
  readonly variant: PlanetAnimationName | "random";
}): PlanetAnimation {
  const entries = PLANET_ANIMATIONS_DATA;

  const chosen =
    opts.variant === "random"
      ? entries[Math.floor(Math.random() * entries.length)]
      : entries.find((e) => e.name === opts.variant);

  const entry = chosen ?? entries[0];
  if (!entry) {
    // Should be impossible unless the generated file is empty.
    throw new Error("Planet animations are missing (no variants available).");
  }

  return {
    name: entry.name,
    fps: entry.fps,
    frames: decodeFrames(entry.framesGzipBase64),
  };
}

function decodeFrames(framesGzipBase64: string): readonly string[] {
  const compressed = Buffer.from(framesGzipBase64, "base64");
  const jsonBytes = Bun.gunzipSync(compressed);
  const jsonText = new TextDecoder().decode(jsonBytes);
  const parsed: unknown = JSON.parse(jsonText);

  if (!isRecord(parsed)) {
    throw new Error("Invalid planet animation payload (expected an object).");
  }

  const frames = parsed.frames;
  if (!isStringArray(frames)) {
    throw new Error(
      "Invalid planet animation payload (expected frames: string[])."
    );
  }

  return frames.map(stripCursorVisibilityCodes);
}

function stripCursorVisibilityCodes(frame: string): string {
  // We manage cursor visibility at the player level (avoid per-frame flicker).
  return frame.replaceAll("\x1b[?25l", "").replaceAll("\x1b[?25h", "");
}
