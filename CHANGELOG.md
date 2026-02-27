## 1.16.0 (2026-02-27)

* feat(remote): auto-bootstrap node workspaces and harden daemon startup ([f66334b](https://github.com/hack-dance/hack/commit/f66334b))

## <small>1.15.3 (2026-02-27)</small>

* fix(sync): install mutagen agents and stabilize node keychain access ([f856beb](https://github.com/hack-dance/hack/commit/f856beb))

## <small>1.15.2 (2026-02-27)</small>

* fix(dispatch): use keychain token for interactive workspace bootstrap ([49c5b91](https://github.com/hack-dance/hack/commit/49c5b91))

## <small>1.15.1 (2026-02-27)</small>

* fix(ci): retry release asset uploads on transient network failures ([9a9eada](https://github.com/hack-dance/hack/commit/9a9eada))

## 1.15.0 (2026-02-27)

* feat(node): auto-bootstrap ssh during pair and add ssh setup command ([f3c6698](https://github.com/hack-dance/hack/commit/f3c6698))

## 1.14.0 (2026-02-26)

* feat(remote): auto-manage mutagen for remote sync ([26624fd](https://github.com/hack-dance/hack/commit/26624fd))

## <small>1.13.3 (2026-02-26)</small>

* fix(macos): replace setup terminal modal with terminal drawer (#16) ([7116db7](https://github.com/hack-dance/hack/commit/7116db7)), closes [#16](https://github.com/hack-dance/hack/issues/16) [#15](https://github.com/hack-dance/hack/issues/15)

## <small>1.13.2 (2026-02-26)</small>

* Merge pull request #1 from rhymiz/codex/fix-up-missing-hack-stack ([081f358](https://github.com/hack-dance/hack/commit/081f358)), closes [#1](https://github.com/hack-dance/hack/issues/1)
* Merge pull request #14 from rhymiz/main ([7e2d37f](https://github.com/hack-dance/hack/commit/7e2d37f)), closes [#14](https://github.com/hack-dance/hack/issues/14)
* fix(project): suppress missing .hack stack trace for hack up ([ced1f59](https://github.com/hack-dance/hack/commit/ced1f59))

## <small>1.13.1 (2026-02-26)</small>

* fix(release): include workspace manifests in node-runtime image build ([2745c6b](https://github.com/hack-dance/hack/commit/2745c6b))

## 1.13.0 (2026-02-26)

* fix(ci): ignore known historical gitleaks fingerprint ([7032af9](https://github.com/hack-dance/hack/commit/7032af9))
* fix(ci): isolate workspace bootstrap tests from module-mock bleed ([accd2dc](https://github.com/hack-dance/hack/commit/accd2dc))
* fix(ci): run cli tests with deterministic concurrency ([5817ac8](https://github.com/hack-dance/hack/commit/5817ac8))
* fix(ci): stabilize secret scan and env backend assertion ([0b8dc8f](https://github.com/hack-dance/hack/commit/0b8dc8f))
* test(ci): force-add .hack fixtures in workspace bootstrap tests ([3fd4464](https://github.com/hack-dance/hack/commit/3fd4464))
* test(ci): harden bootstrap fixture git add against global excludes ([1e93f35](https://github.com/hack-dance/hack/commit/1e93f35))
* test(ci): include legacy .dev scaffold in bootstrap fixture repo ([4f9df2b](https://github.com/hack-dance/hack/commit/4f9df2b))
* test(ci): include workspace ensure payload on bootstrap status mismatch ([bc63a61](https://github.com/hack-dance/hack/commit/bc63a61))
* test(ci): pin workspace bootstrap target root under temp home ([106528b](https://github.com/hack-dance/hack/commit/106528b))
* test(ci): restore module mocks after mocked test suites ([f9b3aa9](https://github.com/hack-dance/hack/commit/f9b3aa9))
* test(ci): use .dev bootstrap fixture for runner git compatibility ([f8e3a63](https://github.com/hack-dance/hack/commit/f8e3a63))
* Add OAuth account chooser UI ([54c9f08](https://github.com/hack-dance/hack/commit/54c9f08))
* Add remote node config management ([4f892cd](https://github.com/hack-dance/hack/commit/4f892cd))
* Allow selecting and dragging each 1 ([84a624b](https://github.com/hack-dance/hack/commit/84a624b))
* Check active git credentials ([1bd5fef](https://github.com/hack-dance/hack/commit/1bd5fef))
* Decide open source strategy ([cee45c5](https://github.com/hack-dance/hack/commit/cee45c5))
* Fix bootstrap clone failure ([616aed8](https://github.com/hack-dance/hack/commit/616aed8))
* Fix git credential probe failure ([0e4c384](https://github.com/hack-dance/hack/commit/0e4c384))
* Fix node drag jitter issue ([7fe40b2](https://github.com/hack-dance/hack/commit/7fe40b2))
* Fix remote SSH pairing issue ([fc522e9](https://github.com/hack-dance/hack/commit/fc522e9))
* Make sidebar scrollable and tidy ([793ffed](https://github.com/hack-dance/hack/commit/793ffed))
* Merge pull request #11 from hack-dance/plan-remote-node-agent-work ([114aac3](https://github.com/hack-dance/hack/commit/114aac3)), closes [#11](https://github.com/hack-dance/hack/issues/11)
* Redesign settings modal layout ([ec5f090](https://github.com/hack-dance/hack/commit/ec5f090))
* Restructure CLI monorepo setup ([14f9809](https://github.com/hack-dance/hack/commit/14f9809))
* Simplify account UI and auth ([d4e3aed](https://github.com/hack-dance/hack/commit/d4e3aed))
* Simplify node pairing setup ([5323058](https://github.com/hack-dance/hack/commit/5323058))
* merge(main): resolve PR conflicts with latest main ([c2f47ed](https://github.com/hack-dance/hack/commit/c2f47ed))
* feat(control-plane): stabilize remote bootstrap auth and oauth flow persistence ([f6490e1](https://github.com/hack-dance/hack/commit/f6490e1))

## <small>1.12.1 (2026-02-24)</small>

* fix: trigger patch release ([d0b2d42](https://github.com/hack-dance/hack/commit/d0b2d42))
* Debug hack projects mux detection ([67720dc](https://github.com/hack-dance/hack/commit/67720dc))
* Investigate hack projects mux issue ([6a862b0](https://github.com/hack-dance/hack/commit/6a862b0))
* Investigate hack projects mux lookup ([b579038](https://github.com/hack-dance/hack/commit/b579038))
* Merge branch 'main' into dependabot/npm_and_yarn/examples/next-app/next-16.1.5 ([9fe8b94](https://github.com/hack-dance/hack/commit/9fe8b94))
* Merge branch 'main' into hack-projects-mux-issue ([c4cd388](https://github.com/hack-dance/hack/commit/c4cd388))
* Merge pull request #12 from hack-dance/hack-projects-mux-issue ([b34e802](https://github.com/hack-dance/hack/commit/b34e802)), closes [#12](https://github.com/hack-dance/hack/issues/12)
* Merge pull request #6 from hack-dance/dependabot/npm_and_yarn/examples/next-app/next-16.1.5 ([b671a64](https://github.com/hack-dance/hack/commit/b671a64)), closes [#6](https://github.com/hack-dance/hack/issues/6)
* Merge pull request #7 from hack-dance/dependabot/npm_and_yarn/modelcontextprotocol/sdk-1.26.0 ([ab4d64c](https://github.com/hack-dance/hack/commit/ab4d64c)), closes [#7](https://github.com/hack-dance/hack/issues/7)
* chore(release): trigger release ([e3bb438](https://github.com/hack-dance/hack/commit/e3bb438))
* build(deps): bump @modelcontextprotocol/sdk from 1.25.3 to 1.26.0 ([ef1278c](https://github.com/hack-dance/hack/commit/ef1278c))
* build(deps): bump next from 16.1.1 to 16.1.5 in /examples/next-app ([ea1460d](https://github.com/hack-dance/hack/commit/ea1460d))

## 1.12.0 (2026-02-20)

* feat(cli): auto-sync agent integrations on project commands ([a83a121](https://github.com/hack-dance/hack/commit/a83a121))
* docs(agents): clarify hostname routing and oauth alias guidance ([c89f26f](https://github.com/hack-dance/hack/commit/c89f26f))

## 1.11.0 (2026-02-20)

* feat(setup): add sync command for agent integrations ([5c1279a](https://github.com/hack-dance/hack/commit/5c1279a))
* chore(release): trigger rerun after ghostty bridge fix ([b3e120f](https://github.com/hack-dance/hack/commit/b3e120f))

## <small>1.10.2 (2026-02-19)</small>

* fix(macos): handle ghostty scrollViewport return type changes ([b78f73d](https://github.com/hack-dance/hack/commit/b78f73d))

## <small>1.10.1 (2026-02-19)</small>

* Fix gateway 502 for livenation ([a1bb858](https://github.com/hack-dance/hack/commit/a1bb858))
* Improve dashboard header and groups ([1e58826](https://github.com/hack-dance/hack/commit/1e58826))
* Merge branch 'main' into squircle ([f06f84c](https://github.com/hack-dance/hack/commit/f06f84c))
* Merge pull request #10 from hack-dance/squircle ([4539e92](https://github.com/hack-dance/hack/commit/4539e92)), closes [#10](https://github.com/hack-dance/hack/issues/10)
* fix(runtime): improve local ingress self-healing ([d305e2d](https://github.com/hack-dance/hack/commit/d305e2d))
* fix(tests): stabilize shell mocks across bun test suite ([402ebe2](https://github.com/hack-dance/hack/commit/402ebe2))

## 1.10.0 (2026-02-16)

* feat(lifecycle): support persistent up.before hooks ([f38e024](https://github.com/hack-dance/hack/commit/f38e024))
* feat(tui): add interactive attach hints for lifecycle services ([90b2de4](https://github.com/hack-dance/hack/commit/90b2de4))

## <small>1.9.1 (2026-02-14)</small>

* fix(lifecycle): preserve PATH and cwd behavior for hooks ([05e2a2d](https://github.com/hack-dance/hack/commit/05e2a2d))

## 1.9.0 (2026-02-13)

* feat(macos): add update-available header badge and background checks ([88bfc01](https://github.com/hack-dance/hack/commit/88bfc01))

## 1.8.0 (2026-02-13)

* feat(macos): add update controls and version info in settings ([ab5de6f](https://github.com/hack-dance/hack/commit/ab5de6f))

## <small>1.7.1 (2026-02-13)</small>

* fix(ci): clone ghostty vendor in macOS release workflow ([7c414d5](https://github.com/hack-dance/hack/commit/7c414d5))

## 1.7.0 (2026-02-13)

* Add startup script logging support ([97cddad](https://github.com/hack-dance/hack/commit/97cddad))
* feat(lifecycle): add startup scripts and runtime log visibility ([a28e4e9](https://github.com/hack-dance/hack/commit/a28e4e9))
* feat(lifecycle): surface startup flows and enforce config schema ([3dab4a9](https://github.com/hack-dance/hack/commit/3dab4a9))

## <small>1.6.2 (2026-02-13)</small>

* Fix mac app layout and logs ([7670b8c](https://github.com/hack-dance/hack/commit/7670b8c))
* Investigate Zig download failure ([3198da1](https://github.com/hack-dance/hack/commit/3198da1))
* fix(macos): fix dashboard overlays and settings terminal actions ([b77f3f4](https://github.com/hack-dance/hack/commit/b77f3f4))

## <small>1.6.1 (2026-02-13)</small>

* Audit large repo changes ([a2d2788](https://github.com/hack-dance/hack/commit/a2d2788))
* Find Xcode simulator skill ([60d9ef9](https://github.com/hack-dance/hack/commit/60d9ef9))
* Find Xcode simulator skill ([8bc37b2](https://github.com/hack-dance/hack/commit/8bc37b2))
* Fix project pill layout and tabs ([750682c](https://github.com/hack-dance/hack/commit/750682c))
* Fix review-agent findings ([8cad0ee](https://github.com/hack-dance/hack/commit/8cad0ee))
* Fix ticket card layout and startup ([9b16700](https://github.com/hack-dance/hack/commit/9b16700))
* Fix ticket card layout and startup ([ffb1958](https://github.com/hack-dance/hack/commit/ffb1958))
* Merge main into review-session-management-workflow ([17636d9](https://github.com/hack-dance/hack/commit/17636d9))
* Merge pull request #8 from hack-dance/review-session-management-workflow ([6760c72](https://github.com/hack-dance/hack/commit/6760c72)), closes [#8](https://github.com/hack-dance/hack/issues/8)
* Merge pull request #9 from hack-dance/app-updates ([c30a589](https://github.com/hack-dance/hack/commit/c30a589)), closes [#9](https://github.com/hack-dance/hack/issues/9)
* Merge remote-tracking branch 'origin/app-updates' into app-updates ([031a226](https://github.com/hack-dance/hack/commit/031a226))
* Restore global terminal panel ([d7bf346](https://github.com/hack-dance/hack/commit/d7bf346))
* Update CLI docs and commands ([faeb629](https://github.com/hack-dance/hack/commit/faeb629))
* fix: address PR review findings and stabilize builds ([07c21ea](https://github.com/hack-dance/hack/commit/07c21ea))
* fix: resolve rebase integration regressions ([e1c5cce](https://github.com/hack-dance/hack/commit/e1c5cce))
* fix(macos): resolve dashboard model mismatch build break ([f229ffa](https://github.com/hack-dance/hack/commit/f229ffa))
* fix(macos): stabilize status strip identity and labels ([8d2ab8c](https://github.com/hack-dance/hack/commit/8d2ab8c))
* test: cover runtime meta failures ([c2b56f6](https://github.com/hack-dance/hack/commit/c2b56f6))
* test: satisfy ProjectMeta type ([5ae817a](https://github.com/hack-dance/hack/commit/5ae817a))
* chore(macos): add SwiftUI previews + force setup flag ([56d4386](https://github.com/hack-dance/hack/commit/56d4386))

## 1.6.0 (2026-02-06)

* feat(macos): add first-run setup guidance + stabilize XcodeGen ([d624bd1](https://github.com/hack-dance/hack/commit/d624bd1))

## <small>1.5.9 (2026-02-06)</small>

* fix(macos): codesign bundled CLI with JIT entitlements ([5e6326f](https://github.com/hack-dance/hack/commit/5e6326f))

## <small>1.5.8 (2026-02-06)</small>

* fix(tickets): allow passthrough flags on hack tickets ([e7a3562](https://github.com/hack-dance/hack/commit/e7a3562))
* chore(dev): make pre-commit formatter safe ([2d89ebd](https://github.com/hack-dance/hack/commit/2d89ebd))

## <small>1.5.5 (2026-02-06)</small>

* fix(macos): copy BundledCLI into app bundle ([d0353f9](https://github.com/hack-dance/hack/commit/d0353f9))

## <small>1.5.4 (2026-02-06)</small>

* fix(ci): bundle CLI before xcodegen ([ef1f0a0](https://github.com/hack-dance/hack/commit/ef1f0a0))

## <small>1.5.3 (2026-02-06)</small>

* fix(ci): parse Sparkle signature output ([14b45b6](https://github.com/hack-dance/hack/commit/14b45b6))

## <small>1.5.2 (2026-02-06)</small>

* fix(ci): parse codesign identity reliably ([83f6c8e](https://github.com/hack-dance/hack/commit/83f6c8e))

## <small>1.5.1 (2026-02-06)</small>

* fix(ci): avoid ambiguous codesign identity ([a7e750d](https://github.com/hack-dance/hack/commit/a7e750d))

## 1.5.0 (2026-02-06)

* feat(update): add CLI + macOS updaters ([39f7334](https://github.com/hack-dance/hack/commit/39f7334))

## 1.4.0 (2026-02-05)

* chore(changelog): reset 1.4.x entries ([f45a0b7](https://github.com/hack-dance/hack/commit/f45a0b7))
* chore(ci): automate release pipeline from main and tags ([0fa5fc5](https://github.com/hack-dance/hack/commit/0fa5fc5))
* chore(ci): fix reusable workflow permissions and tag checkout ([655c09a](https://github.com/hack-dance/hack/commit/655c09a))
* chore(release): 1.4.0 ([28808d0](https://github.com/hack-dance/hack/commit/28808d0))
* chore(release): 1.4.1 ([274fd9f](https://github.com/hack-dance/hack/commit/274fd9f))
* chore(release): 1.4.2 ([ad5b992](https://github.com/hack-dance/hack/commit/ad5b992))
* chore(release): 1.4.3 ([0a5ad23](https://github.com/hack-dance/hack/commit/0a5ad23))
* fix(ci): pass development team to xcodebuild archive ([0c4bf2c](https://github.com/hack-dance/hack/commit/0c4bf2c))
* fix(ci): use current Xcode for macOS release build ([e13ee97](https://github.com/hack-dance/hack/commit/e13ee97))
* fix(ci): use release PAT for semantic-release pushes ([b35b87b](https://github.com/hack-dance/hack/commit/b35b87b))
* fix(daemon): restore missing status type imports ([eeea27c](https://github.com/hack-dance/hack/commit/eeea27c))
* fix(macos): stop xcodegen from overwriting Info.plist version ([d43a46b](https://github.com/hack-dance/hack/commit/d43a46b))
* fix(release): add CLI entitlements + refresh ingress subnet ([a0788f9](https://github.com/hack-dance/hack/commit/a0788f9))
* fix(release): correct installer repo + app version ([9aa0556](https://github.com/hack-dance/hack/commit/9aa0556))
* Add session panes command and default to active pane ([19925d0](https://github.com/hack-dance/hack/commit/19925d0))
* app updates ([fe3097e](https://github.com/hack-dance/hack/commit/fe3097e))
* feat: auto-start Docker backend and auto-enable tickets on setup ([7802df1](https://github.com/hack-dance/hack/commit/7802df1))
* feat(session): add capture/tail streaming output ([6814a5c](https://github.com/hack-dance/hack/commit/6814a5c))
* refactor(extensions): centralize enable prompts ([6c5118f](https://github.com/hack-dance/hack/commit/6c5118f))

## 1.3.0 (2026-01-22)

* Clarify local-dev orchestration features in README ([bb4a030](https://github.com/hack-dance/hack/commit/bb4a030))
* fix tests ([4b92b19](https://github.com/hack-dance/hack/commit/4b92b19))
* Merge pull request #4 from hack-dance/roodboi-patch-1 ([99cf59c](https://github.com/hack-dance/hack/commit/99cf59c)), closes [#4](https://github.com/hack-dance/hack/issues/4)
* Merge pull request #5 from hack-dance/sessions ([a2e303c](https://github.com/hack-dance/hack/commit/a2e303c)), closes [#5](https://github.com/hack-dance/hack/issues/5)
* readme ([ab889ba](https://github.com/hack-dance/hack/commit/ab889ba))
* test: skip session tests when tmux unavailable ([451a3a3](https://github.com/hack-dance/hack/commit/451a3a3))
* chore: disable automatic release workflow ([7ff1d2b](https://github.com/hack-dance/hack/commit/7ff1d2b))
* chore: exclude examples and vendor from biome linting ([50b2630](https://github.com/hack-dance/hack/commit/50b2630))
* chore: fix biome warnings and simplify config ([4abe532](https://github.com/hack-dance/hack/commit/4abe532))
* chore: fix lint errors and update docs for DNS changes ([91c5c45](https://github.com/hack-dance/hack/commit/91c5c45))
* fix: resolve TypeScript type errors ([db980f5](https://github.com/hack-dance/hack/commit/db980f5))
* fix: sign CLI binary with hardened runtime for notarization ([fcdbea2](https://github.com/hack-dance/hack/commit/fcdbea2))
* fix: sign DMG install script and include hack-install.sh in local builds ([0e3e51e](https://github.com/hack-dance/hack/commit/0e3e51e))
* fix: use container IP for DNS resolution, bypass OrbStack port forwarding ([3a8d5df](https://github.com/hack-dance/hack/commit/3a8d5df))
* docs: add macOS DMG installation option to README ([dba7750](https://github.com/hack-dance/hack/commit/dba7750))
* docs: add sessions documentation ([fbebe49](https://github.com/hack-dance/hack/commit/fbebe49))
* feat: add hack ssh command and improve session picker ([2c070eb](https://github.com/hack-dance/hack/commit/2c070eb))
* feat: add session API endpoints to hackd ([a645d8e](https://github.com/hack-dance/hack/commit/a645d8e))

## 1.2.0 (2026-01-21)

* adding control plane baseline and initial extensions ([6be8d20](https://github.com/hack-dance/hack/commit/6be8d20))
* build and release ([9e04011](https://github.com/hack-dance/hack/commit/9e04011))
* deps ([82fe249](https://github.com/hack-dance/hack/commit/82fe249))
* docker network routing + docs and gateway updates ([1677d42](https://github.com/hack-dance/hack/commit/1677d42))
* docs and tests ([fd96b18](https://github.com/hack-dance/hack/commit/fd96b18))
* docs and tests ([29619ae](https://github.com/hack-dance/hack/commit/29619ae))
* fix ticket tracking and auto fixing ([8f69f71](https://github.com/hack-dance/hack/commit/8f69f71))
* ignore internal ([6e9da24](https://github.com/hack-dance/hack/commit/6e9da24))
* initial tui ([ffec865](https://github.com/hack-dance/hack/commit/ffec865))
* Merge pull request #2 from hack-dance/extension-system ([d39c0b5](https://github.com/hack-dance/hack/commit/d39c0b5)), closes [#2](https://github.com/hack-dance/hack/issues/2)
* notes ([fb49a67](https://github.com/hack-dance/hack/commit/fb49a67))
* resources and usage ([eafa98e](https://github.com/hack-dance/hack/commit/eafa98e))
* run ([9ac84cb](https://github.com/hack-dance/hack/commit/9ac84cb))
* tickets ([02b0d29](https://github.com/hack-dance/hack/commit/02b0d29))
* tickets and ci ([672cf6c](https://github.com/hack-dance/hack/commit/672cf6c))
* types ([01feefe](https://github.com/hack-dance/hack/commit/01feefe))
* types ([5503f0e](https://github.com/hack-dance/hack/commit/5503f0e))
* chore: gitignore build artifacts and auto-ignore .hack/.internal ([1b0b3fa](https://github.com/hack-dance/hack/commit/1b0b3fa))
* chore(macos): add helper scripts and docs ([8ed6a3f](https://github.com/hack-dance/hack/commit/8ed6a3f))
* feat: add hackd daemon with unix socket API, CLI commands, caching, and docs ([1d92ee2](https://github.com/hack-dance/hack/commit/1d92ee2))
* feat(daemon): add runtime health and reset detection ([80fcb4b](https://github.com/hack-dance/hack/commit/80fcb4b))
* feat(macos): add desktop app scaffold and mvp ([4b733e6](https://github.com/hack-dance/hack/commit/4b733e6))
* feat(macos): add hackd overview ([6c5ba01](https://github.com/hack-dance/hack/commit/6c5ba01))
* feat(tickets): sync tickets to hidden ref and repair legacy setup ([56c988b](https://github.com/hack-dance/hack/commit/56c988b))
* fix(macos): resolve hack cli path ([6e4b6ef](https://github.com/hack-dance/hack/commit/6e4b6ef))
* docs(macos): clarify project ownership ([a76d40f](https://github.com/hack-dance/hack/commit/a76d40f))
* ci: update macos runners ([33b0f48](https://github.com/hack-dance/hack/commit/33b0f48))

## 1.1.0 (2026-01-02)

* feat: add agent init launchers and patterns guide + exp[and agent init ux and docs + fix global ip ([0e19463](https://github.com/hack-dance/hack-cli/commit/0e19463))
* bd sync: 2026-01-02 13:04:06 ([37c5477](https://github.com/hack-dance/hack-cli/commit/37c5477))

## <small>1.0.1 (2026-01-02)</small>

* fix(install): add default asset dir path and dont ask on install ([666dd97](https://github.com/hack-dance/hack-cli/commit/666dd97))

## 1.0.0 (2026-01-01)

* fix: initial release ([1373350](https://github.com/hack-dance/hack-cli/commit/1373350))
* ci and tests and build and release ([be03cd0](https://github.com/hack-dance/hack-cli/commit/be03cd0))
* initial ([2882977](https://github.com/hack-dance/hack-cli/commit/2882977))
* Initial commit ([c6fc5de](https://github.com/hack-dance/hack-cli/commit/c6fc5de))
* latest ([d97a634](https://github.com/hack-dance/hack-cli/commit/d97a634))

# Changelog
