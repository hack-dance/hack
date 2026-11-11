# Switch between environments

The commands and configuration on this page were audited against `v5.0.0-next.13`.
The execution notes below come from the newer recipe source revision; the examples
were not rerun with the pinned binary.

Use this to run the same project with different settings: development, QA, or
a production-like setup. Each environment is an env overlay file. You choose it
with `--env`.

The complete project is in
[`examples/recipes/environments`](https://github.com/hack-dance/hack/blob/4b400ea4d40acbff4ec00e37a3f288c67da55a03/examples/recipes/environments).

## Steps

1. Put the shared settings in the base file. Every overlay starts from these.

   <!-- include: examples/recipes/environments/.hack/hack.env.default.yaml -->
   ```yaml
   version: 1
   environment: default
   secretsprovider: project_key
   values:
     global:
       APP_ENV: development
       LOG_LEVEL: debug
       FEATURE_NEW_CHECKOUT: "true"
     app:
       PAYMENTS_API_URL: http://payments-mock:4000
   ```

2. Add one overlay file per environment, named `hack.env.<name>.yaml`. List
   only the values that differ.

   <!-- include: examples/recipes/environments/.hack/hack.env.qa.yaml -->
   ```yaml
   version: 1
   environment: qa
   secretsprovider: project_key
   values:
     global:
       APP_ENV: qa
     app:
       PAYMENTS_API_URL: https://payments.qa.example.com
   ```

   <!-- include: examples/recipes/environments/.hack/hack.env.prodlike.yaml -->
   ```yaml
   version: 1
   environment: prodlike
   secretsprovider: project_key
   values:
     global:
       APP_ENV: production
       LOG_LEVEL: warn
       FEATURE_NEW_CHECKOUT: "false"
     app:
       PAYMENTS_API_URL: https://payments.sandbox.example.com
   ```

3. The stand-in app prints what it received. Note `$$`: Compose turns it into
   `$`, so the container's shell expands the variable, not Compose. The project
   config needs nothing special for overlays.

   <!-- include: examples/recipes/environments/.hack/docker-compose.yml -->
   ```yaml
   name: environments
   services:
     app:
       # Stand-in for your app: prints the settings it received, then waits.
       image: alpine:3.22
       command:
         - sh
         - -c
         - echo "APP_ENV=$$APP_ENV LOG_LEVEL=$$LOG_LEVEL PAYMENTS_API_URL=$$PAYMENTS_API_URL"; exec sleep infinity
   ```

   <!-- include: examples/recipes/environments/.hack/hack.config.json -->
   ```json
   {
     "$schema": "https://schemas.hack.local/hack.config.schema.json",
     "name": "environments",
     "dev_host": "environments.hack.local"
   }
   ```

4. Check what a service will get, without starting anything:

   ```sh
   hack env list --env qa --service app
   hack env explain PAYMENTS_API_URL --env qa --service app   # where a value comes from
   ```

5. Start with an overlay. Containers, lifecycle hooks and lifecycle processes
   all get it.

   ```sh
   hack up -d --env qa
   ```

   `hack restart` and `hack down` reuse the overlay the stack was started with.
   `hack exec` does not: pass the same `--env`, or it refuses.

6. Run host commands with the same values. `--scope` adds one service's
   values; the command still runs on your machine.

   ```sh
   hack host exec --env qa -- printenv APP_ENV                        # qa
   hack host exec --env qa --scope app -- printenv PAYMENTS_API_URL   # https://payments.qa.example.com
   hack host exec --env qa --scope app -- npm run e2e
   ```

## Run two environments side by side

An overlay changes values, not the instance. To run QA and production-like at
the same time, give one of them its own branch instance:

```sh
hack up -d --env qa
hack up -d --env prodlike --branch prodlike
hack logs app --branch prodlike --no-follow
hack down --branch prodlike
```

## Machine-local overrides

To change a value only on your machine, write it to the local overlay file.
Hack's `.hack/.gitignore` keeps it out of git.

```sh
hack env add --env qa --local LOG_LEVEL trace     # writes .hack/hack.env.qa.local.yaml
hack restart                                      # running containers keep old values until then
```

Put secrets for an environment there too, with `--secret --value-stdin`. See
[Env and secrets](../../env.md#entering-secret-values).

## A default overlay

To make one overlay the default for everyone, set it in
`.hack/hack.config.json`:

```sh
hack config set env.defaultOverlay qa
```

Then `hack up` means `hack up --env qa`. Use `--env base` to get only the base
file.

## Notes

- An overlay name is only a label. A `prodlike` overlay still runs on your
  machine. It gives no access control and no isolation.
- Editing an env file does not change running containers. Run
  `hack restart`, or `hack env apply --service <name>` for one service.
- Overlay names are lowercase letters and digits joined by hyphens, such as
  `qa` or `qa-2`.

Related: [Env and secrets](../../env.md),
[Remote database](remote-database.md), [Common pitfalls](common-pitfalls.md).
