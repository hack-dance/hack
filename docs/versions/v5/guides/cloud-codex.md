# OpenAI Codex cloud

> **Not run yet, and not expected to work without a test.** As read on
> 2026-11-18, the [current cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)
> documentation does not say whether a Docker daemon is available. The
> [legacy environment](https://learn.chatgpt.com/docs/environments/cloud-environment)
> has no documented Docker daemon, removes secrets before the agent phase, and
> blocks internet access during it by default.

Hack's Compose runtime needs a Docker Engine the task can reach. Until a run
shows one in a current Codex cloud task, treat this environment as unsupported
for `hack up`. Hack's env commands still work there; see
[Managed environments](../../guides/codex-managed-environments.md).

## To test it

- Create a current cloud environment on a test repository.
- Add `HACK_ENV_SECRET_KEY` as an **environment variable**. A network secret only
  gives programs a placeholder.
- Turn on full internet access.
- Ask a task to run:

```sh
docker info && docker compose version
```

If both succeed, continue with
[Any Linux machine with Docker](cloud-linux-docker.md#steps) and record the
result here. If `hack up` refuses, its message names what is missing.
