# Usage by service

`hack usage --json --by-service` reports one project's CPU and memory use per
service. It is meant for the desktop app and for scripts.

```sh
hack usage --json --by-service --path <project root>
hack usage --json --by-service --project <name>
```

With neither `--path` nor `--project`, the project is found from the current
directory. `--by-service` requires `--json` and does not combine with
`--details`, `--include-global`, `--no-host` or `--watch`.

## Output

The standard envelope, one JSON document:

```json
{
  "ok": true,
  "data": {
    "schema": "hack.usage.by-service.v1",
    "project": "shop",
    "backend": "compose",
    "services": [
      {
        "composeProject": "shop",
        "service": "api",
        "containers": 1,
        "cpuPercent": 3.2,
        "memUsedBytes": 104857600,
        "memLimitBytes": 2147483648
      }
    ]
  }
}
```

- `project`: the project's Compose project name.
- `services`: one row per running service of the project and of each of its
  branch instances, sorted by `composeProject`, then `service`. A branch
  instance's `composeProject` is `<project>--<branch>`.
- `containers`: running containers of that service (replicas). The numbers are
  sums over them, from one `docker stats` sample.
- `cpuPercent`, `memUsedBytes`, `memLimitBytes`: `null` when Docker reported
  no usable value.
- A project with nothing running has `services: []`. That is not an error.

Version 1 may add fields; it does not remove or rename them.

## Errors

`{ "ok": false, "error": { "code", "message" } }` with exit 1:

- `E_DOCKER_UNAVAILABLE`: Docker is not installed or not responding, or
  `docker stats` failed.
- `E_PROJECT_NOT_FOUND`: no Hack project at the path.
- `E_USAGE`: an invalid option combination.

## Limits

Only containers that Compose labels are measured (`backend: "compose"`).
Native runtime projects are not measured yet. Host processes started with
`hack run` on the host are not included; plain `hack usage --json` reports
them.
