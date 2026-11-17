/** Only a login-service renderer grants automatic project replay authority. */
export function isLoginServiceAutostart(opts: {
  readonly env: Readonly<Record<string, string | undefined>>;
}): boolean {
  return (
    opts.env.HACK_DAEMON_LOGIN_SERVICE === "1" &&
    opts.env.HACK_DAEMON_AUTOSTART_DISABLE !== "1"
  );
}

/**
 * Owns one startup pass at a time. Engine availability can resume an unclaimed
 * timed-out pass; ordinary daemon starts never acquire this authority.
 */
export function createLoginAutostart(opts: {
  readonly enabled: boolean;
  readonly run: (
    signal: AbortSignal
  ) => Promise<{ readonly waitingForEngine: boolean }>;
  readonly onError: () => void;
}): {
  readonly start: () => void;
  readonly observeEngine: (ready: boolean) => void;
  readonly stop: () => Promise<void>;
} {
  const abort = new AbortController();
  let started = false;
  let waiting = false;
  let work: Promise<void> | null = null;
  const dispatch = () => {
    if (!opts.enabled || abort.signal.aborted || work) {
      return;
    }
    work = opts
      .run(abort.signal)
      .then(
        (result) => {
          waiting = result.waitingForEngine;
        },
        () => {
          waiting = false;
          opts.onError();
        }
      )
      .finally(() => {
        work = null;
      });
  };
  return {
    start: () => {
      if (started) {
        return;
      }
      started = true;
      dispatch();
    },
    observeEngine: (ready) => {
      if (started && ready && waiting) {
        dispatch();
      }
    },
    stop: async () => {
      abort.abort();
      await work;
    },
  };
}
