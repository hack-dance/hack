# hack-cli

This repo is dogfooding the tickets extension.

- Enablement: `.hack/hack.config.json`
- Usage:
  - `hack x tickets setup`
  - `hack x tickets create --title "..." --body-stdin`
  - `hack x tickets list`
  - `hack x tickets show T-00001`
  - `hack x tickets status T-00001 in_progress`
  - `hack x tickets sync`

No services are required for this repo; `docker-compose.yml` is intentionally empty.
