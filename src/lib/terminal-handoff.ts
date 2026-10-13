/**
 * Terminal handoff between a redrawing progress indicator and interactive
 * steps (confirmation prompts and the native administrator prompt).
 *
 * A clack spinner redraws its line every frame by moving to column 1 and
 * erasing to the end of the screen, and it holds stdin in a keypress reader.
 * Left running, it erases a sudo password prompt within one frame, so the user
 * never sees it. Interactive steps therefore claim the terminal first; the
 * indicator stays paused until the whole step settles (including its `sudo -n`
 * follow-ups) and resumes once.
 */

/** Progress indicator that can release and later retake the terminal. */
export interface PausableProgress {
  start(message?: string): void;
  stop(message?: string): void;
  /** Erase the indicator and stop drawing; a no-op when not drawing. */
  pause(): void;
  /** Draw again with the last message, only if `pause` stopped it. */
  resume(): void;
}

/** The subset of a clack spinner the adapter drives. */
export interface SpinnerLike {
  start(message?: string): void;
  stop(message?: string): void;
  clear(): void;
}

/** Make a spinner pausable without losing its current message. */
export function pausableSpinner(indicator: SpinnerLike): PausableProgress {
  let message: string | undefined;
  let state: "idle" | "drawing" | "paused" = "idle";
  return {
    start(next) {
      message = next;
      state = "drawing";
      indicator.start(next);
    },
    stop(final) {
      if (state === "paused") {
        indicator.start(message);
      }
      state = "idle";
      indicator.stop(final);
    },
    pause() {
      if (state !== "drawing") {
        return;
      }
      state = "paused";
      indicator.clear();
    },
    resume() {
      if (state !== "paused") {
        return;
      }
      state = "drawing";
      indicator.start(message);
    },
  };
}

/**
 * Run a step that may prompt. `claim` pauses the indicator before the first
 * prompt; a step that never claims never pauses. After a claim the indicator
 * resumes exactly once, when the step settles or throws.
 */
export async function withTerminalHandoff<T>(
  progress: Pick<PausableProgress, "pause" | "resume">,
  step: (claim: () => void) => Promise<T>
): Promise<T> {
  let claimed = false;
  const claim = () => {
    if (!claimed) {
      claimed = true;
      progress.pause();
    }
  };
  try {
    return await step(claim);
  } finally {
    if (claimed) {
      progress.resume();
    }
  }
}
