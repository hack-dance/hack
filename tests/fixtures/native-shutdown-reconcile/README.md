# Shutdown after service removal

Copy `compose.yaml` into an isolated Hack project using an owned native development
home. Run the current-branch CLI with that home's runtime. Keep the Compose path
unchanged throughout the test.

1. Start foreground `hack up`, wait for both services, then press Ctrl-C.
2. Confirm `stopped-data-retained` and absence of both container IDs with native
   graph inspection; retain the run ID and named-volume identity.
3. Replace the fixture's Compose content with `compose-app-only.yaml`, keeping
   the same filename. Start `hack up` again. Confirm the same run and data volume,
   a fresh app container, and no api container.
4. Press Ctrl-C. Require success, `stopped-data-retained`, and absence of every
   old and current container ID. Confirm `shutdown.json` contains only the current
   app generation and the old observations remain in `shutdown-history.json`.
5. Start and stop the app again to verify the home no longer reserves capacity.

Repeat from an app-only project by adding api, stopping, removing api, starting,
and stopping. For a legacy wedged home, use the inspect/recover shutdown-rebase
and interrupted-cleanup commands in `docs/guides/native-candidate.md`. Never
simulate that defect by editing a live native home's journals.

The portable Rust projection and shutdown tests cover service removal and evidence
admission. The ignored owned-VM shutdown test also covers unchanged compute
recreation. Neither is proof that this foreground fixture passed on a real VM.
