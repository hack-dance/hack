const IMAGE = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MARKER = /^[a-z0-9-]{1,63}$/;

function refused(): never {
  throw new Error("Completed-job fixture inputs refused; values omitted.");
}

/** Immutable program: SQL data controls the attempted effect; authored inputs never change after admission. */
export function completedJobFixtureProgram(marker: string): string {
  if (!MARKER.test(marker)) {
    refused();
  }
  return `set -eu
psql -v ON_ERROR_STOP=1 -At -c "CREATE TABLE IF NOT EXISTS control(id integer PRIMARY KEY,mode text NOT NULL); INSERT INTO control VALUES(1,'success') ON CONFLICT(id) DO NOTHING; CREATE TABLE IF NOT EXISTS job_attempts(id bigserial PRIMARY KEY); CREATE TABLE IF NOT EXISTS job_successes(attempt bigint PRIMARY KEY); CREATE TABLE IF NOT EXISTS app_starts(id bigserial PRIMARY KEY,attempt bigint NOT NULL); CREATE TABLE IF NOT EXISTS marker(id integer PRIMARY KEY,value text NOT NULL);"
attempt="$(psql -v ON_ERROR_STOP=1 -qAt -c 'INSERT INTO job_attempts DEFAULT VALUES RETURNING id')"
mode="$(psql -v ON_ERROR_STOP=1 -At -c 'SELECT mode FROM control WHERE id=1')"
case "$mode" in
  success)
    if [ "$attempt" = 1 ]; then
      psql -v ON_ERROR_STOP=1 -At -c "INSERT INTO marker VALUES(1,'${marker}') ON CONFLICT(id) DO NOTHING"
    else
      retained="$(psql -v ON_ERROR_STOP=1 -At -c 'SELECT value FROM marker WHERE id=1')"
      [ "$retained" = '${marker}' ] || exit 47
    fi ;;
  fail) exit 17 ;;
  hold) trap 'exit 0' TERM; while :; do sleep 1; done ;;
  *) exit 91 ;;
esac
psql -v ON_ERROR_STOP=1 -At -c "INSERT INTO job_successes VALUES($attempt)"`;
}

export const COMPLETED_JOB_APP_PROGRAM = `set -eu
attempt="$(psql -v ON_ERROR_STOP=1 -At -c 'SELECT MAX(id) FROM job_attempts')"
successful="$(psql -v ON_ERROR_STOP=1 -At -c 'SELECT MAX(attempt) FROM job_successes')"
[ -n "$attempt" ] && [ "$attempt" = "$successful" ] || exit 49
psql -v ON_ERROR_STOP=1 -At -c "INSERT INTO app_starts(attempt) VALUES($attempt)"
trap 'exit 0' TERM
while :; do sleep 1; done`;

/** Literal dollars are doubled only at the Compose authored boundary, then decoded once by the importer. */
export function completedJobFixtureSources(opts: {
  readonly name: string;
  readonly image: string;
  readonly marker: string;
}) {
  if (!(NAME.test(opts.name) && IMAGE.test(opts.image))) {
    refused();
  }
  const environment = {
    PGHOST: "db",
    PGUSER: "postgres",
    PGDATABASE: "fixture",
  };
  const client = (program: string) => ({
    image: opts.image,
    pull_policy: "never",
    entrypoint: [],
    command: ["/bin/sh", "-c", program.replaceAll("$", "$$")],
    environment,
    // Shadow the image-declared VOLUME; all storage is the exact admitted named volume.
    volumes: ["data:/var/lib/postgresql/data:ro"],
    stop_grace_period: "3s",
  });
  return {
    config: {
      name: opts.name,
      worktree: { auto_branch: false, inherit_local: false },
    },
    compose: {
      name: opts.name,
      services: {
        db: {
          image: opts.image,
          pull_policy: "never",
          environment: {
            POSTGRES_DB: "fixture",
            POSTGRES_HOST_AUTH_METHOD: "trust",
          },
          volumes: ["data:/var/lib/postgresql/data"],
          healthcheck: {
            test: [
              "CMD",
              "psql",
              "-h",
              "127.0.0.1",
              "-U",
              "postgres",
              "-d",
              "fixture",
              "-At",
              "-c",
              "SELECT 1",
            ],
            interval: "1s",
            timeout: "1s",
            retries: 30,
          },
          stop_grace_period: "3s",
        },
        seed: {
          ...client(completedJobFixtureProgram(opts.marker)),
          labels: { "hack.service.one-shot": "true" },
          depends_on: { db: { condition: "service_healthy" } },
        },
        app: {
          ...client(COMPLETED_JOB_APP_PROGRAM),
          depends_on: { seed: { condition: "service_completed_successfully" } },
        },
      },
      volumes: { data: { name: `${opts.name}_data` } },
    },
  };
}
