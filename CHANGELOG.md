## <small>3.3.5 (2026-07-09)</small>

* fix(lifecycle): recover owned mux sessions ([c1da123](https://github.com/hack-dance/hack/commit/c1da123))

## <small>3.3.4 (2026-07-09)</small>

* Merge pull request #62 from hack-dance/codex/homebrew-bin-link-repair ([30841be](https://github.com/hack-dance/hack/commit/30841be)), closes [#62](https://github.com/hack-dance/hack/issues/62)
* fix(release): install Homebrew executable path ([3c6e0d9](https://github.com/hack-dance/hack/commit/3c6e0d9))

## <small>3.3.3 (2026-07-09)</small>

* Merge pull request #61 from hack-dance/codex/event-agent-runtime-repair ([f1de71e](https://github.com/hack-dance/hack/commit/f1de71e)), closes [#61](https://github.com/hack-dance/hack/issues/61)
* fix(cli): preserve usage code for lifecycle json ([f50f408](https://github.com/hack-dance/hack/commit/f50f408))
* fix(runtime): clean descendant lifecycle groups ([57f2358](https://github.com/hack-dance/hack/commit/57f2358))
* fix(runtime): isolate detached worktrees and recover orphan groups ([80a8dd2](https://github.com/hack-dance/hack/commit/80a8dd2))
* fix(runtime): persist wrapped command process group ([2f4a4be](https://github.com/hack-dance/hack/commit/2f4a4be))
* fix(runtime): retain session proof for lifecycle cleanup ([f87e5cf](https://github.com/hack-dance/hack/commit/f87e5cf))
* docs(cli): explain detached worktree targeting ([966b863](https://github.com/hack-dance/hack/commit/966b863))

## <small>3.3.2 (2026-07-08)</small>

* Merge pull request #60 from hack-dance/fix/field-findings-round3 ([69f6caa](https://github.com/hack-dance/hack/commit/69f6caa)), closes [#60](https://github.com/hack-dance/hack/issues/60)
* docs: tickets/ in every durable ignore-block listing ([103575a](https://github.com/hack-dance/hack/commit/103575a))
* fix: gate tickets git cache on extension enablement, cover it in ignores ([fc56b74](https://github.com/hack-dance/hack/commit/fc56b74))
* fix: support non-interactive hack global trust and hack doctor --fix ([78e068b](https://github.com/hack-dance/hack/commit/78e068b))
* fix(daemon): address PR review — strict orphan match, stale-path repair, docs sync ([61ac7f6](https://github.com/hack-dance/hack/commit/61ac7f6))
* fix(daemon): repair virtual plist paths, sweep orphans, launchd-exclusive start ([c3958bb](https://github.com/hack-dance/hack/commit/c3958bb))
* fix(doctor): host TLS repair runs under --no-interactive ([71c3601](https://github.com/hack-dance/hack/commit/71c3601))
* fix(global): install prepares host trust env independent of keychain step ([a0bcde4](https://github.com/hack-dance/hack/commit/a0bcde4))
* style(daemon): hoist regexes to module scope for the repo lint profile ([90d1514](https://github.com/hack-dance/hack/commit/90d1514))

## <small>3.3.1 (2026-07-08)</small>

* Merge pull request #59 from hack-dance/fix/review-comments-round2 ([e941ca3](https://github.com/hack-dance/hack/commit/e941ca3)), closes [#59](https://github.com/hack-dance/hack/issues/59)
* fix: address post-merge review findings across PRs 54 and 58 ([11f5788](https://github.com/hack-dance/hack/commit/11f5788))

## 3.3.0 (2026-07-08)

* Merge branch 'docs/partial-adoption' into feat/init-discovery-validation ([064db0e](https://github.com/hack-dance/hack/commit/064db0e))
* Merge pull request #58 from hack-dance/feat/init-discovery-validation ([9dd469f](https://github.com/hack-dance/hack/commit/9dd469f)), closes [#58](https://github.com/hack-dance/hack/issues/58)
* feat(init): add post-discovery validation pass for hack init ([6b50b76](https://github.com/hack-dance/hack/commit/6b50b76))
* feat(init): surface the hack global install requirement in init output ([739a581](https://github.com/hack-dance/hack/commit/739a581))
* docs: document partial adoption (backing-services-only) as a valid hack setup ([871a247](https://github.com/hack-dance/hack/commit/871a247))

## 3.2.0 (2026-07-08)

* Merge branch 'main' into fix/container-trust-bundle ([8338b58](https://github.com/hack-dance/hack/commit/8338b58))
* Merge pull request #56 from hack-dance/fix/container-trust-bundle ([9cb82c1](https://github.com/hack-dance/hack/commit/9cb82c1)), closes [#56](https://github.com/hack-dance/hack/issues/56)
* Merge pull request #57 from hack-dance/fix/global-trust-platform-order ([e3c6da0](https://github.com/hack-dance/hack/commit/e3c6da0)), closes [#57](https://github.com/hack-dance/hack/issues/57)
* fix(tls): check isMac before isLinux in globalTrust; pin platform in mac suite ([4d35428](https://github.com/hack-dance/hack/commit/4d35428))
* fix(tls): containers get combined public+local trust, never a stripped bundle ([651f234](https://github.com/hack-dance/hack/commit/651f234))
* fix(tls): generate the combined trust bundle on Linux hosts ([e339920](https://github.com/hack-dance/hack/commit/e339920))
* test(tls): neutral fixture paths for the privacy check ([c4be004](https://github.com/hack-dance/hack/commit/c4be004))
* feat(agents): onboarding lessons from first field hack init --with run ([2190dd8](https://github.com/hack-dance/hack/commit/2190dd8))

## <small>3.1.1 (2026-07-07)</small>

* Merge pull request #55 from hack-dance/fix/release-intel-macos-build ([e5f7646](https://github.com/hack-dance/hack/commit/e5f7646)), closes [#55](https://github.com/hack-dance/hack/issues/55)
* fix(ci): restore Intel macOS build in the release matrix ([52bcb28](https://github.com/hack-dance/hack/commit/52bcb28))

## 3.1.0 (2026-07-07)

* Merge pull request #52 from hack-dance/blacksmith-migration-6707f0f ([6774244](https://github.com/hack-dance/hack/commit/6774244)), closes [#52](https://github.com/hack-dance/hack/issues/52)
* Merge pull request #54 from hack-dance/feat/worktree-ax-overhaul ([1fc0715](https://github.com/hack-dance/hack/commit/1fc0715)), closes [#54](https://github.com/hack-dance/hack/issues/54)
* Migrate workflows to Blacksmith ([fa30afb](https://github.com/hack-dance/hack/commit/fa30afb))
* Rewrite README for the v3 local-first product ([7da1cc2](https://github.com/hack-dance/hack/commit/7da1cc2))
* fix: spawn resolves runtime PATH; doctor --fix root-ignores the secret key ([fd7eb27](https://github.com/hack-dance/hack/commit/fd7eb27))
* fix(cli): usage errors emit the JSON envelope under --json ([7da751e](https://github.com/hack-dance/hack/commit/7da751e))
* fix(cli): usage-error JSON envelope emits without logger output ([ed08dc0](https://github.com/hack-dance/hack/commit/ed08dc0))
* docs: carry the positioning line into the docs index ([99a4b96](https://github.com/hack-dance/hack/commit/99a4b96))
* docs: extend overhaul plan (run/exec defaulting, onboarding surfaces, docs phase) ([edf7de9](https://github.com/hack-dance/hack/commit/edf7de9))
* docs: full accuracy pass against the v3 surface ([93ae8c0](https://github.com/hack-dance/hack/commit/93ae8c0))
* docs: non-negotiable docs-currency rule across instruction surfaces ([e9e013e](https://github.com/hack-dance/hack/commit/e9e013e))
* docs: plan for worktree DX + agent experience overhaul ([d32e743](https://github.com/hack-dance/hack/commit/d32e743))
* docs(cli): generated command reference with drift enforcement ([4709d89](https://github.com/hack-dance/hack/commit/4709d89))
* docs(env): deprecation marker on legacy v2 env migrator ([aa1d305](https://github.com/hack-dance/hack/commit/aa1d305))
* docs(guides): refresh managed-environments guide for the v3 surface ([47ca25a](https://github.com/hack-dance/hack/commit/47ca25a))
* docs(readme): differentiate the environment, not the port ([3c3f502](https://github.com/hack-dance/hack/commit/3c3f502))
* docs(readme): lead with the whole-environment claim ([d82ae58](https://github.com/hack-dance/hack/commit/d82ae58))
* docs(readme): rewrite around the core value proposition ([a83c0fb](https://github.com/hack-dance/hack/commit/a83c0fb))
* docs(readme): sharpen differentiation and add the portability story ([99e08fd](https://github.com/hack-dance/hack/commit/99e08fd))
* feat(agents): agent-assisted onboarding across CLI, skills, and MCP ([644f818](https://github.com/hack-dance/hack/commit/644f818))
* feat(agents): single instruction source with drift detection ([3660c27](https://github.com/hack-dance/hack/commit/3660c27))
* feat(cli): machine-first surface — JSON envelope, non-interactive, gating ([346b2c8](https://github.com/hack-dance/hack/commit/346b2c8))
* feat(core): add HACK_HOME override for the global hack directory ([58a023c](https://github.com/hack-dance/hack/commit/58a023c))
* feat(project): committed .hack/.gitignore + doctor untracking for generated files ([b575b78](https://github.com/hack-dance/hack/commit/b575b78))
* feat(worktree): first-class linked-worktree development ([abc695d](https://github.com/hack-dance/hack/commit/abc695d))
* chore: refresh agent docs and de-register tickets for this repo ([9c150b6](https://github.com/hack-dance/hack/commit/9c150b6))
* chore: tickets opt-in by default, registry prune, CI + perf cleanup ([1dd2b2f](https://github.com/hack-dance/hack/commit/1dd2b2f))
* test: make suite order-independent via scoped module mocks ([b36a312](https://github.com/hack-dance/hack/commit/b36a312))
* test(e2e): real CLI harness with turborepo fixture + worktree scenarios ([83f3e17](https://github.com/hack-dance/hack/commit/83f3e17))

## 3.0.0 (2026-04-23)

* feat!: simplify hack to a local-first core ([ced8d07](https://github.com/hack-dance/hack/commit/ced8d07))
* Merge pull request #51 from hack-dance/simplify-hack-platform ([c527203](https://github.com/hack-dance/hack/commit/c527203)), closes [#51](https://github.com/hack-dance/hack/issues/51)
* fix: address ci and lifecycle review feedback ([11f39e5](https://github.com/hack-dance/hack/commit/11f39e5))
* fix: address dispatch and tickets review feedback ([bbe8f69](https://github.com/hack-dance/hack/commit/bbe8f69))
* fix: close env and tickets review regressions ([0fd6dc1](https://github.com/hack-dance/hack/commit/0fd6dc1))
* fix: harden lifecycle cleanup and restore CI ([d767231](https://github.com/hack-dance/hack/commit/d767231))
* fix: read shared env keys from primary worktrees ([709b582](https://github.com/hack-dance/hack/commit/709b582))
* fix: restore lifecycle and env compatibility cleanup ([08c12ad](https://github.com/hack-dance/hack/commit/08c12ad))
* fix: serialize tickets worktree access ([97a1151](https://github.com/hack-dance/hack/commit/97a1151))
* fix: suppress inactive gateway token doctor noise ([147adb6](https://github.com/hack-dance/hack/commit/147adb6))
* fix(env): preserve legacy local overlays without git ([e52af68](https://github.com/hack-dance/hack/commit/e52af68))
* fix(env): tolerate missing git and preserve ssh wrappers ([5ad7259](https://github.com/hack-dance/hack/commit/5ad7259))
* fix(lifecycle): avoid external singleton port probes ([748a072](https://github.com/hack-dance/hack/commit/748a072))
* fix(runtime): close remaining review regressions ([6d2e9d8](https://github.com/hack-dance/hack/commit/6d2e9d8))
* fix(runtime): harden env ignores and singleton probes ([291cca1](https://github.com/hack-dance/hack/commit/291cca1))
* docs(agent): refresh local-first setup guidance ([87d2041](https://github.com/hack-dance/hack/commit/87d2041))
* docs(lifecycle): explain singleton adoption semantics ([196bd90](https://github.com/hack-dance/hack/commit/196bd90))
* feat: publish portable runtime images ([d8a718e](https://github.com/hack-dance/hack/commit/d8a718e))
* feat(lifecycle): support singleton host process adoption ([95bd545](https://github.com/hack-dance/hack/commit/95bd545))
* test: smoke portable managed containers ([172b975](https://github.com/hack-dance/hack/commit/172b975))
* chore: merge main into simplify-hack-platform ([b310f6d](https://github.com/hack-dance/hack/commit/b310f6d))


### BREAKING CHANGE

* Hack now ships as a local-first runtime. Built-in web dashboard, auth-broker, GitHub, Linear, and account/org/team control-plane flows are removed from the supported product surface; workflows should migrate to native git/gh and the local CLI/macOS companion.

## <small>2.5.1 (2026-04-10)</small>

* fix(env): reuse worktree keys and registry identity ([12e5838](https://github.com/hack-dance/hack/commit/12e5838))
* fix(registry): recover stale same-repo worktree paths ([ec766b2](https://github.com/hack-dance/hack/commit/ec766b2))
* fix(test): isolate mock-module files in ci ([e04c919](https://github.com/hack-dance/hack/commit/e04c919))
* fix(test): narrow registry outcome assertions ([c5f49b8](https://github.com/hack-dance/hack/commit/c5f49b8))
* Merge branch 'main' into fix/worktree-linked-env-inheritance ([a1143fa](https://github.com/hack-dance/hack/commit/a1143fa))
* Merge branch 'main' into fix/worktree-linked-env-inheritance ([0f1aba8](https://github.com/hack-dance/hack/commit/0f1aba8))
* Merge pull request #48 from hack-dance/fix/worktree-linked-env-inheritance ([f8a8091](https://github.com/hack-dance/hack/commit/f8a8091)), closes [#48](https://github.com/hack-dance/hack/issues/48)

## 2.5.0 (2026-04-07)

* test: add env matrix coverage and PR verification guardrails ([6d63ef1](https://github.com/hack-dance/hack/commit/6d63ef1))
* test(global): mock macOS trust roots in CI fixtures ([3550a2e](https://github.com/hack-dance/hack/commit/3550a2e))
* Merge branch 'main' into fix/host-runtime-ca-trust ([e4feec9](https://github.com/hack-dance/hack/commit/e4feec9))
* Merge branch 'main' into skill-progression-map ([b2e87c6](https://github.com/hack-dance/hack/commit/b2e87c6))
* Merge pull request #43 from hack-dance/fix/host-runtime-ca-trust ([be98476](https://github.com/hack-dance/hack/commit/be98476)), closes [#43](https://github.com/hack-dance/hack/issues/43)
* Merge pull request #44 from hack-dance/skill-progression-map ([031991c](https://github.com/hack-dance/hack/commit/031991c)), closes [#44](https://github.com/hack-dance/hack/issues/44)
* Merge pull request #45 from hack-dance/fix/host-runtime-ca-trust ([1e966f5](https://github.com/hack-dance/hack/commit/1e966f5)), closes [#45](https://github.com/hack-dance/hack/issues/45)
* Merge pull request #46 from hack-dance/fix/dns-helper-hardening ([e3fca8a](https://github.com/hack-dance/hack/commit/e3fca8a)), closes [#46](https://github.com/hack-dance/hack/issues/46)
* Merge pull request #47 from hack-dance/fix/dns-helper-preflight-order ([8850b5c](https://github.com/hack-dance/hack/commit/8850b5c)), closes [#47](https://github.com/hack-dance/hack/issues/47)
* fix(env): clarify host command env inspection ([3c10f3b](https://github.com/hack-dance/hack/commit/3c10f3b))
* fix(global): allow missing libexec during preflight ([dc2e15a](https://github.com/hack-dance/hack/commit/dc2e15a))
* fix(global): harden dns recovery helper authorization ([fa4bb7e](https://github.com/hack-dance/hack/commit/fa4bb7e))
* fix(global): invalidate sudo cache before verifying dns auth ([9eeca18](https://github.com/hack-dance/hack/commit/9eeca18))
* fix(global): limit host bundle to macos roots ([bd2c074](https://github.com/hack-dance/hack/commit/bd2c074))
* fix(global): preserve brew fallback around dns helper ([7e5044b](https://github.com/hack-dance/hack/commit/7e5044b))
* fix(global): refresh dns recovery sudoers rule ([6cfe755](https://github.com/hack-dance/hack/commit/6cfe755))
* fix(global): retry brew when dns helper is stale ([f63067f](https://github.com/hack-dance/hack/commit/f63067f))
* fix(global): retry brew when helper stop fails ([2c6fa83](https://github.com/hack-dance/hack/commit/2c6fa83))
* fix(global): skip host tls env when trust is declined ([7cbd139](https://github.com/hack-dance/hack/commit/7cbd139))
* fix(global): use a root-owned dns recovery helper ([d9abbb5](https://github.com/hack-dance/hack/commit/d9abbb5))
* fix(global): validate dns helper path before install ([ade0909](https://github.com/hack-dance/hack/commit/ade0909))
* fix(runtime): cover compose-target host trust fallback ([a8044ef](https://github.com/hack-dance/hack/commit/a8044ef))
* fix(runtime): preserve explicit host TLS env ([3f1c928](https://github.com/hack-dance/hack/commit/3f1c928))
* fix(runtime): tighten host trust env typing ([2ac7b51](https://github.com/hack-dance/hack/commit/2ac7b51))
* fix(runtime): trust local hack CA for host workflows ([bdab2bd](https://github.com/hack-dance/hack/commit/bdab2bd))
* feat(doctor): repair host tls trust drift ([7da28f5](https://github.com/hack-dance/hack/commit/7da28f5))
* feat(env): add shell mode for host env commands ([7337d59](https://github.com/hack-dance/hack/commit/7337d59))

## 2.4.0 (2026-04-02)

* Merge branch 'main' into feat/global-install-recovery-setup ([f854e22](https://github.com/hack-dance/hack/commit/f854e22))
* Merge pull request #42 from hack-dance/feat/global-install-recovery-setup ([5496339](https://github.com/hack-dance/hack/commit/5496339)), closes [#42](https://github.com/hack-dance/hack/issues/42)
* fix(auth): align broker auth pages and local config ([32af3cb](https://github.com/hack-dance/hack/commit/32af3cb))
* fix(auth): restore broker CI and sign-out cookie parity ([1a31813](https://github.com/hack-dance/hack/commit/1a31813))
* fix(cli): exclude app test aggregators from package typecheck ([619a8e9](https://github.com/hack-dance/hack/commit/619a8e9))
* fix(global): resolve authorize user from os account ([8cb6580](https://github.com/hack-dance/hack/commit/8cb6580))
* fix(update): use neutral homebrew path fixtures ([fa192b2](https://github.com/hack-dance/hack/commit/fa192b2))
* feat: refresh web app and streamline install workflows ([939c2b2](https://github.com/hack-dance/hack/commit/939c2b2))
* feat(web): expand account shell and broker auth flows ([87c1ebe](https://github.com/hack-dance/hack/commit/87c1ebe))
* chore: remove tracked linear project artifacts ([6115502](https://github.com/hack-dance/hack/commit/6115502))

## 2.3.0 (2026-04-02)

* Merge pull request #41 from hack-dance/feat/global-install-recovery-setup ([9eea06d](https://github.com/hack-dance/hack/commit/9eea06d)), closes [#41](https://github.com/hack-dance/hack/issues/41)
* fix(env): skip secret backend for empty legacy contracts ([67da0a6](https://github.com/hack-dance/hack/commit/67da0a6))
* fix(global): preserve sudo fallback when stdout is redirected ([7038b5f](https://github.com/hack-dance/hack/commit/7038b5f))
* feat(global): automate macOS recovery setup during install ([2da43bb](https://github.com/hack-dance/hack/commit/2da43bb))

## <small>2.2.1 (2026-04-01)</small>

* Merge pull request #40 from hack-dance/dimitri/fix-lifecycle-non-login-shell ([8a21daf](https://github.com/hack-dance/hack/commit/8a21daf)), closes [#40](https://github.com/hack-dance/hack/issues/40)
* fix(cli): avoid login shells for lifecycle commands ([2963d46](https://github.com/hack-dance/hack/commit/2963d46))

## 2.2.0 (2026-04-01)

* Merge branch 'main' into dimitri/exec-command-surface ([e2eb7f6](https://github.com/hack-dance/hack/commit/e2eb7f6))
* Merge branch 'main' into dimitri/exec-command-surface ([a068e7e](https://github.com/hack-dance/hack/commit/a068e7e))
* Merge branch 'main' into dimitri/fix-lifecycle-and-tickets-speed ([0ce84f7](https://github.com/hack-dance/hack/commit/0ce84f7))
* Merge branch 'main' into dimitri/fix-lifecycle-and-tickets-speed ([7a21672](https://github.com/hack-dance/hack/commit/7a21672))
* Merge pull request #38 from hack-dance/dimitri/exec-command-surface ([56c2e9e](https://github.com/hack-dance/hack/commit/56c2e9e)), closes [#38](https://github.com/hack-dance/hack/issues/38)
* Merge pull request #39 from hack-dance/dimitri/fix-lifecycle-and-tickets-speed ([2ad76b4](https://github.com/hack-dance/hack/commit/2ad76b4)), closes [#39](https://github.com/hack-dance/hack/issues/39)
* fix(cli): harden lifecycle cleanup and isolate exec tests ([18904e0](https://github.com/hack-dance/hack/commit/18904e0))
* fix(cli): harden lifecycle cleanup and local tickets reads ([a70f1a2](https://github.com/hack-dance/hack/commit/a70f1a2))
* fix(cli): stop lifecycle tunnel leaks and speed tickets reads ([378f7ad](https://github.com/hack-dance/hack/commit/378f7ad))
* fix(cli): tighten lifecycle shutdown and ticket refresh ([74bd742](https://github.com/hack-dance/hack/commit/74bd742))
* fix(runtime): harden exec session checks ([9ee1d8d](https://github.com/hack-dance/hack/commit/9ee1d8d))
* fix(tickets): fail fresh clone reads on remote fetch errors ([e1f728b](https://github.com/hack-dance/hack/commit/e1f728b))
* fix(tickets): preserve projection freshness on reads ([645e370](https://github.com/hack-dance/hack/commit/645e370))
* test(runtime): isolate exec command logger behavior ([382a84c](https://github.com/hack-dance/hack/commit/382a84c))
* test(tickets): cover unreachable remote checkout recovery ([40fd6f2](https://github.com/hack-dance/hack/commit/40fd6f2))
* feat(runtime): add exec command for live service containers ([e6a3a9e](https://github.com/hack-dance/hack/commit/e6a3a9e))

## 2.1.0 (2026-04-01)

* Merge pull request #37 from hack-dance/dimitri/host-command-surface ([6fc4558](https://github.com/hack-dance/hack/commit/6fc4558)), closes [#37](https://github.com/hack-dance/hack/issues/37)
* feat(host): add host command namespace for env-injected execution ([c9bb856](https://github.com/hack-dance/hack/commit/c9bb856))

## <small>2.0.3 (2026-03-31)</small>

* Merge pull request #36 from hack-dance/dimitri/fix-runtime-effective-env-match ([9068559](https://github.com/hack-dance/hack/commit/9068559)), closes [#36](https://github.com/hack-dance/hack/issues/36)
* fix(runtime): match run env against effective overlay ([f45ae5e](https://github.com/hack-dance/hack/commit/f45ae5e))

## <small>2.0.2 (2026-03-31)</small>

* Merge pull request #35 from hack-dance/dimitri/fix-runtime-null-env-mismatch ([96a2818](https://github.com/hack-dance/hack/commit/96a2818)), closes [#35](https://github.com/hack-dance/hack/issues/35)
* fix(runtime): treat null env as run mismatch ([3a0dd44](https://github.com/hack-dance/hack/commit/3a0dd44))

## <small>2.0.1 (2026-03-31)</small>

* Merge branch 'main' into dimitri/web-local-dev-rough-edges ([a1419b2](https://github.com/hack-dance/hack/commit/a1419b2)), closes [dimitri/web-local-dev-rou#edges](https://github.com/dimitri/web-local-dev-rou/issues/edges)
* Merge pull request #34 from hack-dance/dimitri/web-local-dev-rough-edges ([fe6c409](https://github.com/hack-dance/hack/commit/fe6c409)), closes [#34](https://github.com/hack-dance/hack/issues/34) [hack-dance/dimitri/web-local-dev-rou#edges](https://github.com/hack-dance/dimitri/web-local-dev-rou/issues/edges)
* fix(ci): stabilize secret scan and host env docs ([581ea34](https://github.com/hack-dance/hack/commit/581ea34))
* fix(env): add host-local command resolution ([d54a6ed](https://github.com/hack-dance/hack/commit/d54a6ed))
* fix(env): normalize encrypted backend key paths ([b65ee8e](https://github.com/hack-dance/hack/commit/b65ee8e))
* fix(env): preserve service overrides for host target ([6aae113](https://github.com/hack-dance/hack/commit/6aae113))
* fix(runtime): avoid run dependency collisions ([6d1fe09](https://github.com/hack-dance/hack/commit/6d1fe09))
* fix(runtime): gate run no-deps on live state ([94c9785](https://github.com/hack-dance/hack/commit/94c9785))
* fix(runtime): narrow run env selection type ([cc5d833](https://github.com/hack-dance/hack/commit/cc5d833))
* fix(web): allow routed local dev origins ([82e706f](https://github.com/hack-dance/hack/commit/82e706f))
* fix(web): stabilize local dev runtime ([28fe25b](https://github.com/hack-dance/hack/commit/28fe25b))

## 2.0.0 (2026-03-27)

* fix(build): stabilize macOS release signing ([32dcea0](https://github.com/hack-dance/hack/commit/32dcea0))
* fix(ci): stabilize env migration branch checks ([498d793](https://github.com/hack-dance/hack/commit/498d793))
* fix(doctor): group checks and hide noisy follow-up ([e6f6ace](https://github.com/hack-dance/hack/commit/e6f6ace))
* fix(doctor): make env migration prompts explicit ([b000438](https://github.com/hack-dance/hack/commit/b000438))
* fix(doctor): repair compose env refs in modern projects ([1954903](https://github.com/hack-dance/hack/commit/1954903))
* fix(doctor): repair legacy env cleanup and tickets retry ([1685328](https://github.com/hack-dance/hack/commit/1685328))
* fix(env): clean legacy config during migration ([eac34d6](https://github.com/hack-dance/hack/commit/eac34d6))
* fix(env): keep app and project metadata compatible ([7d6fe17](https://github.com/hack-dance/hack/commit/7d6fe17))
* fix(env): keep init templates and session scope strict ([aee89ba](https://github.com/hack-dance/hack/commit/aee89ba))
* fix(env): store canonical env configs under .hack ([f4ff398](https://github.com/hack-dance/hack/commit/f4ff398))
* fix(env): support CI key fallback and mask modern secrets ([85e88f8](https://github.com/hack-dance/hack/commit/85e88f8))
* fix(env): tighten scope validation for modern overlays ([27dd7c1](https://github.com/hack-dance/hack/commit/27dd7c1))
* fix(runtime): degrade gracefully when docker is unavailable ([ad0d2f9](https://github.com/hack-dance/hack/commit/ad0d2f9))
* fix(session): preserve scoped env injection semantics ([64e46e1](https://github.com/hack-dance/hack/commit/64e46e1))
* fix(test): account for runtime-unavailable offline status ([0a0e5ab](https://github.com/hack-dance/hack/commit/0a0e5ab))
* fix(test): isolate offline optionality matrix ([c93ae8a](https://github.com/hack-dance/hack/commit/c93ae8a))
* fix(test): isolate session env suite from Bun mock bleed ([f7c9a2d](https://github.com/hack-dance/hack/commit/f7c9a2d))
* fix(tickets): force fresh remote checkout during repair ([a58cff4](https://github.com/hack-dance/hack/commit/a58cff4))
* fix(tickets): isolate hidden ref fetches from remote refmap ([dd649b7](https://github.com/hack-dance/hack/commit/dd649b7))
* fix(tickets): repair against refreshed hidden refs ([c1c2498](https://github.com/hack-dance/hack/commit/c1c2498))
* fix(tickets): retry non-fast-forward repair pushes ([2c6b5dc](https://github.com/hack-dance/hack/commit/2c6b5dc))
* feat(env)!: adopt project env config overlays ([a986dfd](https://github.com/hack-dance/hack/commit/a986dfd))
* feat(env)!: adopt yaml env overlays and injected session flows ([d933634](https://github.com/hack-dance/hack/commit/d933634))
* Merge branch 'main' into feat/pulumi-style-env-config ([066c4cb](https://github.com/hack-dance/hack/commit/066c4cb))
* Merge pull request #33 from hack-dance/feat/pulumi-style-env-config ([b064522](https://github.com/hack-dance/hack/commit/b064522)), closes [#33](https://github.com/hack-dance/hack/issues/33)
* feat(env): redesign portability around Pulumi-style config ([02228a2](https://github.com/hack-dance/hack/commit/02228a2))
* feat(env): refine interactive config and key bootstrapping ([bd99f6e](https://github.com/hack-dance/hack/commit/bd99f6e))


### BREAKING CHANGE

* project env configuration now uses hack.env.default.yaml and optional hack.env.<overlay>.yaml files as the canonical format. .hack/hack.env.json, backend-first secret flows, and .hack/.env as the default runtime source are legacy compatibility paths. Migrate older repos with hack doctor --migrate-env-config and use hack env add/materialize/exec/shell for the new workflow.

## <small>1.23.1 (2026-03-26)</small>

* fix(build): include app workspaces in node runtime image ([f6bbaba](https://github.com/hack-dance/hack/commit/f6bbaba))

## 1.23.0 (2026-03-26)

* fix: harden tests against HOME and socket env bleed ([b44def9](https://github.com/hack-dance/hack/commit/b44def9))
* fix: tighten TypeScript types and test config helpers ([241a578](https://github.com/hack-dance/hack/commit/241a578))
* fix(admin): surface broker ownership in default-local repos ([463939b](https://github.com/hack-dance/hack/commit/463939b))
* fix(auth-broker): hydrate management-token email verification ([e88b63d](https://github.com/hack-dance/hack/commit/e88b63d))
* fix(auth): fail closed for unattended provider tokens ([c6dda1c](https://github.com/hack-dance/hack/commit/c6dda1c))
* fix(auth): honor wildcard trusted origins in broker handoff ([31ff498](https://github.com/hack-dance/hack/commit/31ff498))
* fix(auth): normalize accepted invite revoke targets ([5deab4b](https://github.com/hack-dance/hack/commit/5deab4b))
* fix(auth): surface durable org team store mode ([1c2e90e](https://github.com/hack-dance/hack/commit/1c2e90e))
* fix(daemon): reject raw traversal before routing ([a2350a8](https://github.com/hack-dance/hack/commit/a2350a8))
* fix(daemon): validate every proxied request target ([375f3e7](https://github.com/hack-dance/hack/commit/375f3e7))
* fix(env): fail closed on malformed env contracts ([c3caba7](https://github.com/hack-dance/hack/commit/c3caba7))
* fix(env): fail closed on secret storage mismatches ([f2300c1](https://github.com/hack-dance/hack/commit/f2300c1))
* fix(env): honor overlay precedence and warn on secret shadowing ([2e493bb](https://github.com/hack-dance/hack/commit/2e493bb))
* fix(env): reject semantically invalid env contracts ([71bcbba](https://github.com/hack-dance/hack/commit/71bcbba))
* fix(gateway): fail closed on malformed runtime targets ([ac475f3](https://github.com/hack-dance/hack/commit/ac475f3))
* fix(github): fail status for unready profiles ([20c6e33](https://github.com/hack-dance/hack/commit/20c6e33))
* fix(linear): anchor closeout evidence to closeout artifact ([97560dd](https://github.com/hack-dance/hack/commit/97560dd))
* fix(linear): fail closed before broker seed reads local secrets ([bedc827](https://github.com/hack-dance/hack/commit/bedc827))
* fix(linear): keep autosync reruns from churning local state ([27f1b5e](https://github.com/hack-dance/hack/commit/27f1b5e))
* fix(linear): prefer non-keychain auth sources ([ea1b1f5](https://github.com/hack-dance/hack/commit/ea1b1f5))
* fix(linear): reject legacy artifact roots ([8c8d352](https://github.com/hack-dance/hack/commit/8c8d352))
* fix(project): preserve selected env on restart ([d09d1aa](https://github.com/hack-dance/hack/commit/d09d1aa))
* fix(test): isolate daemon sessions in ci ([0cae284](https://github.com/hack-dance/hack/commit/0cae284))
* fix(test): isolate restart regression from suite state ([2f2e952](https://github.com/hack-dance/hack/commit/2f2e952))
* fix(test): satisfy restart regression typecheck ([8fc2895](https://github.com/hack-dance/hack/commit/8fc2895))
* fix(test): stabilize cli release checks ([29801ef](https://github.com/hack-dance/hack/commit/29801ef))
* fix(validation): harden auth-broker env isolation ([b8cdfeb](https://github.com/hack-dance/hack/commit/b8cdfeb))
* fix(validation): sanitize admin artifact evidence ([43645b6](https://github.com/hack-dance/hack/commit/43645b6))
* fix(validation): sanitize daemon socket mission artifacts ([65a42e8](https://github.com/hack-dance/hack/commit/65a42e8))
* fix(validation): sanitize mission artifact paths ([8471e31](https://github.com/hack-dance/hack/commit/8471e31))
* fix(web): align integration loaders with browser scope ([045fa1a](https://github.com/hack-dance/hack/commit/045fa1a))
* fix(web): keep scaffold validation reproducible ([eeb981b](https://github.com/hack-dance/hack/commit/eeb981b))
* fix(web): prefer broker auth metadata for auth entrypoints ([3dba6a0](https://github.com/hack-dance/hack/commit/3dba6a0))
* fix(web): preserve env variable status parity ([2183dfa](https://github.com/hack-dance/hack/commit/2183dfa))
* fix(web): prevent account shell hydration mismatch ([f319956](https://github.com/hack-dance/hack/commit/f319956))
* fix(web): remap env-only linear repair guidance ([eadbcb2](https://github.com/hack-dance/hack/commit/eadbcb2))
* fix(web): restore auth redirect return continuity ([addb63c](https://github.com/hack-dance/hack/commit/addb63c))
* fix(web): stabilize account cold bootstrap hydration ([8d55039](https://github.com/hack-dance/hack/commit/8d55039))
* Document the browser control plane in the README ([b5ed265](https://github.com/hack-dance/hack/commit/b5ed265))
* qMerge branch 'main' of github.com:hack-dance/hack ([f1b387e](https://github.com/hack-dance/hack/commit/f1b387e))
* skills ([262fc59](https://github.com/hack-dance/hack/commit/262fc59))
* test(admin): cover pending org invite revoke success ([2d97dbb](https://github.com/hack-dance/hack/commit/2d97dbb))
* test(auth-broker): add deterministic root fallback regression ([d8c60ac](https://github.com/hack-dance/hack/commit/d8c60ac))
* test(auth-broker): add durable project scope regressions ([11fc91e](https://github.com/hack-dance/hack/commit/11fc91e))
* test(auth-broker): use pglite for durable project parity ([e6a8f46](https://github.com/hack-dance/hack/commit/e6a8f46))
* test(control-plane): extend offline optionality matrix ([6b44795](https://github.com/hack-dance/hack/commit/6b44795))
* test(control-plane): prove local-first env workflows stay optional ([3cffa2a](https://github.com/hack-dance/hack/commit/3cffa2a))
* test(validation): add admin control plane user testing ([8f11134](https://github.com/hack-dance/hack/commit/8f11134))
* test(validation): record auth web foundation scrutiny ([9aa361b](https://github.com/hack-dance/hack/commit/9aa361b))
* test(validation): record auth web foundation user testing ([ce55377](https://github.com/hack-dance/hack/commit/ce55377))
* test(validation): record env-hardening closeout scrutiny rerun ([a9cc11b](https://github.com/hack-dance/hack/commit/a9cc11b))
* test(validation): record env-hardening closeout user testing ([f83453f](https://github.com/hack-dance/hack/commit/f83453f))
* test(validation): record env-hardening scrutiny findings ([56e3e70](https://github.com/hack-dance/hack/commit/56e3e70))
* test(validation): record env-hardening scrutiny rerun ([e95bbb2](https://github.com/hack-dance/hack/commit/e95bbb2))
* test(validation): record misc env scrutiny findings ([780bb40](https://github.com/hack-dance/hack/commit/780bb40))
* test(validation): record misc env scrutiny rerun ([3602bf9](https://github.com/hack-dance/hack/commit/3602bf9))
* test(validation): record misc env user testing ([e6862f2](https://github.com/hack-dance/hack/commit/e6862f2))
* test(validation): record misc integration scrutiny findings ([ba3dcc9](https://github.com/hack-dance/hack/commit/ba3dcc9))
* test(validation): record misc integration scrutiny rerun ([cc0d1c0](https://github.com/hack-dance/hack/commit/cc0d1c0))
* test(validation): record misc integration user testing ([ffe5708](https://github.com/hack-dance/hack/commit/ffe5708))
* test(validation): record misc web scrutiny findings ([122eb0b](https://github.com/hack-dance/hack/commit/122eb0b))
* test(validation): record misc web scrutiny rerun ([8ca29df](https://github.com/hack-dance/hack/commit/8ca29df))
* test(validation): record misc web scrutiny round 3 ([5bdcdb5](https://github.com/hack-dance/hack/commit/5bdcdb5))
* test(validation): record misc web scrutiny round 4 ([1c4e53b](https://github.com/hack-dance/hack/commit/1c4e53b))
* test(validation): record misc web user testing ([846b605](https://github.com/hack-dance/hack/commit/846b605))
* test(validation): rerun admin control plane scrutiny ([6fcdd72](https://github.com/hack-dance/hack/commit/6fcdd72))
* test(validation): rerun auth web foundation scrutiny ([c1c5860](https://github.com/hack-dance/hack/commit/c1c5860))
* test(validation): rerun auth web foundation user testing ([3b9e47b](https://github.com/hack-dance/hack/commit/3b9e47b))
* test(validation): synthesize admin control plane scrutiny ([e81ddb5](https://github.com/hack-dance/hack/commit/e81ddb5))
* test(web): align control-plane shell nav expectations ([bca62c2](https://github.com/hack-dance/hack/commit/bca62c2))
* test(web): cover populated account linear audit semantics ([e0f843c](https://github.com/hack-dance/hack/commit/e0f843c))
* test(web): prove account route suspense fallback ([bbccb98](https://github.com/hack-dance/hack/commit/bbccb98))
* chore(mission): clarify durable verification rules ([7588c29](https://github.com/hack-dance/hack/commit/7588c29))
* chore(mission): harden Next runtime verification guidance ([0a0320f](https://github.com/hack-dance/hack/commit/0a0320f))
* chore(mission): harden targeted bun test guidance ([849b75e](https://github.com/hack-dance/hack/commit/849b75e))
* chore(mission): refine env-closeout validation rules ([31d28c7](https://github.com/hack-dance/hack/commit/31d28c7))
* chore(mission): strengthen auth entrypoint review guidance ([0f1bf1c](https://github.com/hack-dance/hack/commit/0f1bf1c))
* chore(mission): tighten admin parity verification guidance ([375d7e6](https://github.com/hack-dance/hack/commit/375d7e6))
* chore(mission): tighten env-hardening validation guidance ([ff8b52a](https://github.com/hack-dance/hack/commit/ff8b52a))
* chore(mission): tighten integration validation guidance ([714c746](https://github.com/hack-dance/hack/commit/714c746))
* chore(mission): tighten mixed-scope web worker guidance ([465fbb6](https://github.com/hack-dance/hack/commit/465fbb6))
* chore(validation): add scrutiny synthesis for linear runtime foundations ([696c752](https://github.com/hack-dance/hack/commit/696c752))
* chore(validation): add user testing synthesis for linear runtime foundations ([18f23b9](https://github.com/hack-dance/hack/commit/18f23b9))
* chore(validation): pass integration-management scrutiny ([3b2f539](https://github.com/hack-dance/hack/commit/3b2f539))
* chore(validation): pass integration-management user testing ([5c4cef6](https://github.com/hack-dance/hack/commit/5c4cef6))
* chore(validation): pass misc-admin-followups-1 scrutiny ([760b032](https://github.com/hack-dance/hack/commit/760b032))
* chore(validation): pass misc-admin-followups-1 user testing ([cbad517](https://github.com/hack-dance/hack/commit/cbad517))
* chore(validation): record integration-management scrutiny ([3384635](https://github.com/hack-dance/hack/commit/3384635))
* chore(validation): sanitize env-hardening daemon evidence ([7fcf346](https://github.com/hack-dance/hack/commit/7fcf346))
* feat(admin): add durable project registration control plane ([cfb63f0](https://github.com/hack-dance/hack/commit/cfb63f0))
* feat(admin): align integration shared scope parity ([1fa5150](https://github.com/hack-dance/hack/commit/1fa5150))
* feat(admin): enforce shared project scope consistency ([5e77804](https://github.com/hack-dance/hack/commit/5e77804))
* feat(auth): move browser auth entrypoints into apps web ([e604a66](https://github.com/hack-dance/hack/commit/e604a66))
* feat(auth): persist default org and team admin state ([b7138f3](https://github.com/hack-dance/hack/commit/b7138f3))
* feat(auth): share Better Auth contract and trusted origins ([1a3a2f5](https://github.com/hack-dance/hack/commit/1a3a2f5))
* feat(env): surface machine-readable trust custody status ([fc7b103](https://github.com/hack-dance/hack/commit/fc7b103))
* feat(linear): capture live audit parity artifacts ([5e6c94f](https://github.com/hack-dance/hack/commit/5e6c94f))
* feat(linear): persist repo audit state in status surfaces ([865fc54](https://github.com/hack-dance/hack/commit/865fc54))
* feat(linear): seed web control plane mission artifacts ([c0cbd2c](https://github.com/hack-dance/hack/commit/c0cbd2c))
* feat(linear): surface mission closeout audit ([fbe575b](https://github.com/hack-dance/hack/commit/fbe575b))
* feat(runtime): wire hack-managed web and broker routes ([4f56eff](https://github.com/hack-dance/hack/commit/4f56eff))
* feat(web): add accessible control plane shell ([aa018e3](https://github.com/hack-dance/hack/commit/aa018e3))
* feat(web): add account shell context parity ([3ef4de2](https://github.com/hack-dance/hack/commit/3ef4de2))
* feat(web): add org admin invite lifecycle ([8386034](https://github.com/hack-dance/hack/commit/8386034))
* feat(web): add team-scoped account management ([437a085](https://github.com/hack-dance/hack/commit/437a085))
* feat(web): scaffold the apps workspace ([a628551](https://github.com/hack-dance/hack/commit/a628551))
* feat(web): surface GitHub readiness and repair guidance ([91e5e74](https://github.com/hack-dance/hack/commit/91e5e74))
* feat(web): surface Linear repair and binding state ([da97d4e](https://github.com/hack-dance/hack/commit/da97d4e))

## 1.22.0 (2026-03-24)

* feat(env): add env overlays and doctor migration checks ([844d431](https://github.com/hack-dance/hack/commit/844d431))
* feat(env): bundle plain env values in backend ([d7b87dd](https://github.com/hack-dance/hack/commit/d7b87dd))

## <small>1.21.3 (2026-03-24)</small>

* fix(env): support multiline values and project-relative secret paths ([78d0860](https://github.com/hack-dance/hack/commit/78d0860))
* Merge branch 'main' into codex/define-env-key-rotation-and-recovery-flows-16o779 ([1dee32d](https://github.com/hack-dance/hack/commit/1dee32d))
* Merge branch 'main' into codex/define-env-key-rotation-and-recovery-flows-16o779 ([edf8091](https://github.com/hack-dance/hack/commit/edf8091))
* Merge branch 'main' into codex/define-env-key-rotation-and-recovery-flows-16o779 ([401ef6a](https://github.com/hack-dance/hack/commit/401ef6a))
* Merge pull request #29 from hack-dance/codex/define-env-key-rotation-and-recovery-flows-16o779 ([408f664](https://github.com/hack-dance/hack/commit/408f664)), closes [#29](https://github.com/hack-dance/hack/issues/29)
* docs: clarify portable env recovery flows ([5bb98db](https://github.com/hack-dance/hack/commit/5bb98db))

## Next

* feat(env): add `--env=<name>` overlays on top of the base `.hack/hack.env.json` contract and `.hack/.env` compatibility file
* feat(env): allow project defaults via `defaultEnvConfig` / `default_env_config`
* feat(doctor): warn when repos are still on legacy local-only plaintext env mode instead of the bundled portable backend flow

## <small>1.21.2 (2026-03-24)</small>

* Merge branch 'main' into codex/linear-mention-hack-462-preserve-.env-compatibility-whil-6icfe6 ([7e821e4](https://github.com/hack-dance/hack/commit/7e821e4))
* Merge pull request #30 from hack-dance/codex/linear-mention-hack-462-preserve-.env-compatibility-whi ([028313c](https://github.com/hack-dance/hack/commit/028313c)), closes [#30](https://github.com/hack-dance/hack/issues/30)
* fix(env): keep source column in list output ([ba310d9](https://github.com/hack-dance/hack/commit/ba310d9))

## <small>1.21.1 (2026-03-24)</small>

* Merge branch 'main' into codex/fix-authorization-bypass-for-team-management ([3c4eee5](https://github.com/hack-dance/hack/commit/3c4eee5))
* Merge pull request #25 from hack-dance/codex/fix-authorization-bypass-for-team-management ([4e0a5fd](https://github.com/hack-dance/hack/commit/4e0a5fd)), closes [#25](https://github.com/hack-dance/hack/issues/25)
* fix(auth): restore team-scoped authorization ([5622392](https://github.com/hack-dance/hack/commit/5622392))

## 1.21.0 (2026-03-24)

* feat(release): publish codex slim installer ([b0451e0](https://github.com/hack-dance/hack/commit/b0451e0))

## 1.20.0 (2026-03-24)

* feat(codex): add slim install path for managed containers ([38f6b78](https://github.com/hack-dance/hack/commit/38f6b78))
* improve linear routing status output ([64574f1](https://github.com/hack-dance/hack/commit/64574f1))
* Merge branch 'main' into codex/linear-mention-hack-444-improve-status,-error,-and-help-ou ([7c08dd5](https://github.com/hack-dance/hack/commit/7c08dd5))
* Merge pull request #26 from hack-dance/codex/linear-mention-hack-444-improve-status,-error,-and-help ([b88c8b7](https://github.com/hack-dance/hack/commit/b88c8b7)), closes [#26](https://github.com/hack-dance/hack/issues/26)
* docs(agents): require conventional commits for release flow ([4a929c3](https://github.com/hack-dance/hack/commit/4a929c3))

## <small>1.19.1 (2026-03-23)</small>

* Merge pull request #24 from hack-dance/fix/macos-ghostty-vt-latest ([2546af4](https://github.com/hack-dance/hack/commit/2546af4)), closes [#24](https://github.com/hack-dance/hack/issues/24)
* fix(macos): support latest ghostty vt stream api ([8c13dc0](https://github.com/hack-dance/hack/commit/8c13dc0))

## 1.19.0 (2026-03-23)

* Fix daemon status CI regressions ([cf8236c](https://github.com/hack-dance/hack/commit/cf8236c))
* Merge pull request #23 from hack-dance/symphony/HACK-434-program-runtime-sessions-and-remote-beta-ha ([572ab26](https://github.com/hack-dance/hack/commit/572ab26)), closes [#23](https://github.com/hack-dance/hack/issues/23)
* feat: harden runtime session and remote beta flows ([f2140de](https://github.com/hack-dance/hack/commit/f2140de))

## 1.18.0 (2026-03-23)

* Add markdown-backed ticket documents design ([16c49fc](https://github.com/hack-dance/hack/commit/16c49fc))
* Add TypeScript path aliases ([a64d91f](https://github.com/hack-dance/hack/commit/a64d91f))
* Align desktop Linear sync guidance ([9fe8848](https://github.com/hack-dance/hack/commit/9fe8848))
* Change hack ticket ids to random IDs ([25aebd7](https://github.com/hack-dance/hack/commit/25aebd7))
* Define normalized Linear sync semantics ([159c4fe](https://github.com/hack-dance/hack/commit/159c4fe))
* Fix Linear project conflict fallback ([3259730](https://github.com/hack-dance/hack/commit/3259730))
* Fix Linear sync client project paging type ([3009855](https://github.com/hack-dance/hack/commit/3009855))
* Fix release prepare typecheck regressions ([89baa94](https://github.com/hack-dance/hack/commit/89baa94))
* HACK-428: checkpoint merge prep ([17d01f4](https://github.com/hack-dance/hack/commit/17d01f4))
* HACK-428: checkpoint merge prep ([f67c628](https://github.com/hack-dance/hack/commit/f67c628))
* HACK-429: checkpoint merge prep ([47e5d8f](https://github.com/hack-dance/hack/commit/47e5d8f))
* HACK-429: fix tickets checkout fallback wiring ([ddaaca5](https://github.com/hack-dance/hack/commit/ddaaca5))
* HACK-441: checkpoint merge prep ([4349751](https://github.com/hack-dance/hack/commit/4349751))
* HACK-448: checkpoint merge prep ([3f30fd2](https://github.com/hack-dance/hack/commit/3f30fd2))
* HACK-448: checkpoint merge prep ([3bb11fb](https://github.com/hack-dance/hack/commit/3bb11fb))
* HACK-449: checkpoint merge prep ([ebd9e39](https://github.com/hack-dance/hack/commit/ebd9e39))
* HACK-454: checkpoint merge prep ([a428423](https://github.com/hack-dance/hack/commit/a428423))
* HACK-459: checkpoint merge prep ([66fbf02](https://github.com/hack-dance/hack/commit/66fbf02))
* HACK-464: checkpoint merge prep ([4400bb9](https://github.com/hack-dance/hack/commit/4400bb9))
* HACK-468: checkpoint merge prep ([2a16e27](https://github.com/hack-dance/hack/commit/2a16e27))
* HACK-468: checkpoint merge prep ([51c5295](https://github.com/hack-dance/hack/commit/51c5295))
* HACK-468: checkpoint merge prep ([fc35b08](https://github.com/hack-dance/hack/commit/fc35b08))
* Merge branch 'hack-449-normalized-ticket-model' into symphony/HACK-546-integration-hack-428-20-more ([2080f15](https://github.com/hack-dance/hack/commit/2080f15))
* Merge branch 'symphony/HACK-428-program-core-offer-and-information-architecture' into symphony/HACK- ([df0901f](https://github.com/hack-dance/hack/commit/df0901f))
* Merge branch 'symphony/HACK-429-program-cli-ux-and-guided-setup' into symphony/HACK-546-integration- ([59f383d](https://github.com/hack-dance/hack/commit/59f383d))
* Merge branch 'symphony/HACK-430-program-github-capability-expansion' into symphony/HACK-546-integrat ([179527b](https://github.com/hack-dance/hack/commit/179527b))
* Merge branch 'symphony/HACK-437-rewrite-the-root-readme-around-the-three-core-ha' into symphony/HACK ([7298035](https://github.com/hack-dance/hack/commit/7298035))
* Merge branch 'symphony/HACK-438-split-docs-navigation-into-core-beta-and-extensi' into symphony/HACK ([70c1121](https://github.com/hack-dance/hack/commit/70c1121))
* Merge branch 'symphony/HACK-440-add-a-plain-language-integrations-overview-for-g' into symphony/HACK ([d4db2ac](https://github.com/hack-dance/hack/commit/d4db2ac))
* Merge branch 'symphony/HACK-441-define-the-prerequisite-detection-matrix-for-doc' into symphony/HACK ([a6bf131](https://github.com/hack-dance/hack/commit/a6bf131))
* Merge branch 'symphony/HACK-445-reposition-github-setup-and-docs-around-capabili' into symphony/HACK ([fe1ac27](https://github.com/hack-dance/hack/commit/fe1ac27))
* Merge branch 'symphony/HACK-448-define-the-first-class-github-workflow-set-revie' into symphony/HACK ([9132f98](https://github.com/hack-dance/hack/commit/9132f98))
* Merge branch 'symphony/HACK-450-design-the-sqlite-projection-and-append-only-jou' into symphony/HACK ([85f9174](https://github.com/hack-dance/hack/commit/85f9174))
* Merge branch 'symphony/HACK-451-preserve-git-portability-and-hidden-ref-sync-wit' into symphony/HACK ([e6ec536](https://github.com/hack-dance/hack/commit/e6ec536))
* Merge branch 'symphony/HACK-452-define-idempotent-external-sync-and-conflict-han' into symphony/HACK ([f63145d](https://github.com/hack-dance/hack/commit/f63145d))
* Merge branch 'symphony/HACK-453-design-markdown-backed-ticket-documents-and-spec' into symphony/HACK ([f208194](https://github.com/hack-dance/hack/commit/f208194))
* Merge branch 'symphony/HACK-454-redesign-hack-linear-setup-bind-and-status-aroun' into symphony/HACK ([e6a320f](https://github.com/hack-dance/hack/commit/e6a320f))
* Merge branch 'symphony/HACK-455-add-hack-managed-support-for-linear-project-docu' into symphony/HACK ([12d764f](https://github.com/hack-dance/hack/commit/12d764f))
* Merge branch 'symphony/HACK-465-improve-crash-capture-restart-guidance-and-proxy' into symphony/HACK ([e64da7d](https://github.com/hack-dance/hack/commit/e64da7d))
* Merge branch 'symphony/HACK-466-clarify-session-semantics-and-add-tmux-default-o' into symphony/HACK ([e7499a7](https://github.com/hack-dance/hack/commit/e7499a7))
* Merge branch 'symphony/HACK-468-define-team-and-organization-command-semantics-a' into symphony/HACK ([f5dbfc0](https://github.com/hack-dance/hack/commit/f5dbfc0))
* Merge branch 'symphony/HACK-472-research-existing-runtimes-and-adjacent-systems' into symphony/HACK- ([a2e5988](https://github.com/hack-dance/hack/commit/a2e5988))
* Merge branch 'symphony/HACK-473-write-hack-specific-runtime-requirements-for-age' into symphony/HACK ([ad6d1c0](https://github.com/hack-dance/hack/commit/ad6d1c0))
* Merge env artifact schema work from HACK-459 into integration branch ([f0e4875](https://github.com/hack-dance/hack/commit/f0e4875))
* Merge pull request #21 from hack-dance/symphony/HACK-546-integration-hack-428-20-more ([ef8f863](https://github.com/hack-dance/hack/commit/ef8f863)), closes [#21](https://github.com/hack-dance/hack/issues/21)
* Merge pull request #22 from hack-dance/fix/release-prepare-typecheck ([ce56e4c](https://github.com/hack-dance/hack/commit/ce56e4c)), closes [#22](https://github.com/hack-dance/hack/issues/22)
* Merge ticket normalization core work into integration branch ([c9bf522](https://github.com/hack-dance/hack/commit/c9bf522))
* Paginate Linear project lookup ([b914068](https://github.com/hack-dance/hack/commit/b914068))
* Repair daemon runtime reset handling and tests ([1fc5757](https://github.com/hack-dance/hack/commit/1fc5757))
* Resolve env portability branch merge conflicts in HACK-546 branch ([ba1f179](https://github.com/hack-dance/hack/commit/ba1f179))
* Resolve HACK-546 runtime reset merge state ([94d8218](https://github.com/hack-dance/hack/commit/94d8218))
* Resolve merge conflicts in HACK-546 integration branch ([0c59745](https://github.com/hack-dance/hack/commit/0c59745))
* test: cover linear milestone artifact commands ([0a58f39](https://github.com/hack-dance/hack/commit/0a58f39))
* test: cover local prerequisite handling exclusions ([8eebcf3](https://github.com/hack-dance/hack/commit/8eebcf3))
* test: relax env backend command timeout ([57c4e8c](https://github.com/hack-dance/hack/commit/57c4e8c))
* test: stabilize merge branch verification ([55ae8a1](https://github.com/hack-dance/hack/commit/55ae8a1))
* test: widen env backend integration timeouts ([3477a23](https://github.com/hack-dance/hack/commit/3477a23))
* test(env): avoid env backend timeout flakes ([79ef745](https://github.com/hack-dance/hack/commit/79ef745))
* test(global): add explicit command test timeouts ([2b20d89](https://github.com/hack-dance/hack/commit/2b20d89))
* test(tickets): expose checkout helper paths under __testOnly ([389740c](https://github.com/hack-dance/hack/commit/389740c))
* test(tickets): harden normalized model invariants ([eef1343](https://github.com/hack-dance/hack/commit/eef1343))
* integrate: preserve HACK-434 runtime hardening assets ([05d90bd](https://github.com/hack-dance/hack/commit/05d90bd))
* merge: integrate HACK-456 sync semantics docs ([d68d4e9](https://github.com/hack-dance/hack/commit/d68d4e9))
* merge: integrate HACK-505 random ticket id work ([de1f70a](https://github.com/hack-dance/hack/commit/de1f70a))
* chore: remove unrelated merge-prep artifacts ([66b9fa5](https://github.com/hack-dance/hack/commit/66b9fa5))
* chore(env): tighten managed artifact schema contract ([10430e3](https://github.com/hack-dance/hack/commit/10430e3))
* chore(symphony): checkpoint HACK-430 before integration ([749fbad](https://github.com/hack-dance/hack/commit/749fbad))
* chore(symphony): checkpoint HACK-436 before integration ([64e7af6](https://github.com/hack-dance/hack/commit/64e7af6))
* chore(symphony): checkpoint HACK-465 before integration ([4ec26f0](https://github.com/hack-dance/hack/commit/4ec26f0))
* chore(symphony): checkpoint HACK-465 before integration ([67004c4](https://github.com/hack-dance/hack/commit/67004c4))
* chore(symphony): finalize HACK-546 merge branch workspace updates ([6330a0f](https://github.com/hack-dance/hack/commit/6330a0f))
* fix: clarify env trust model boundaries ([8f39413](https://github.com/hack-dance/hack/commit/8f39413))
* fix: close linear project artifact edge cases ([ea08c7f](https://github.com/hack-dance/hack/commit/ea08c7f))
* fix: close prerequisite matrix coverage gaps ([16c1930](https://github.com/hack-dance/hack/commit/16c1930))
* fix: explain env storage without contract ([e22be09](https://github.com/hack-dance/hack/commit/e22be09))
* fix: harden linear project artifact reconciliation ([cd3fdf9](https://github.com/hack-dance/hack/commit/cd3fdf9))
* fix: harden recovery guidance inference ([1018d15](https://github.com/hack-dance/hack/commit/1018d15))
* fix: hide unsupported linear archive verbs ([4d8af4c](https://github.com/hack-dance/hack/commit/4d8af4c))
* fix: honor explicit linear artifact project routing ([453fdb7](https://github.com/hack-dance/hack/commit/453fdb7))
* fix: keep root help aligned with docs ia ([2613f35](https://github.com/hack-dance/hack/commit/2613f35))
* fix: keep root help aligned with docs ia ([7384d8e](https://github.com/hack-dance/hack/commit/7384d8e))
* fix: normalize linear prerequisite aliases ([f523440](https://github.com/hack-dance/hack/commit/f523440))
* fix: restore crash recovery inference ([c3b7847](https://github.com/hack-dance/hack/commit/c3b7847))
* fix: tighten linear artifact conflict handling ([4ddc130](https://github.com/hack-dance/hack/commit/4ddc130))
* fix: unify recovery workflow formatting ([ef8b180](https://github.com/hack-dance/hack/commit/ef8b180))
* fix(auth): allow org admins to administer teams ([c25ae2d](https://github.com/hack-dance/hack/commit/c25ae2d))
* fix(auth): allow org admins to administer teams ([59c5c01](https://github.com/hack-dance/hack/commit/59c5c01))
* fix(auth): widen org plugin session status typing ([64dd8b2](https://github.com/hack-dance/hack/commit/64dd8b2))
* fix(auth): widen org plugin session status typing ([0042167](https://github.com/hack-dance/hack/commit/0042167))
* fix(session): honor mux fallback for workspace flows ([271c144](https://github.com/hack-dance/hack/commit/271c144))
* fix(session): preserve workspace backend for isolated siblings ([e1ad2e8](https://github.com/hack-dance/hack/commit/e1ad2e8))
* fix(ssh): respect mux backend for workspace attach ([2f4239f](https://github.com/hack-dance/hack/commit/2f4239f))
* fix(tickets): finalize normalization conflict semantics ([bdced94](https://github.com/hack-dance/hack/commit/bdced94))
* fix(tickets): retry prepared event pushes safely ([e06fbd4](https://github.com/hack-dance/hack/commit/e06fbd4))
* feat: add explicit project ownership inspection ([4ded32e](https://github.com/hack-dance/hack/commit/4ded32e))
* feat: add linear project artifact client support ([c72c436](https://github.com/hack-dance/hack/commit/c72c436))
* feat: add linear project artifact command parsers ([f840359](https://github.com/hack-dance/hack/commit/f840359))
* feat: add linear project artifact file model ([8ffc5df](https://github.com/hack-dance/hack/commit/8ffc5df))
* feat: add linear project artifact workflows ([63b832a](https://github.com/hack-dance/hack/commit/63b832a))
* feat: document env portability trust model ([8f873de](https://github.com/hack-dance/hack/commit/8f873de))
* feat: harden project ownership inspection ([0b5078c](https://github.com/hack-dance/hack/commit/0b5078c))
* feat: improve runtime crash recovery guidance ([c0f6a67](https://github.com/hack-dance/hack/commit/c0f6a67))
* feat(auth): define org and team membership semantics ([0f8bc6d](https://github.com/hack-dance/hack/commit/0f8bc6d))
* feat(auth): define org and team membership semantics ([6fa9c28](https://github.com/hack-dance/hack/commit/6fa9c28))
* feat(env): define portable managed env artifact schema ([eaab6df](https://github.com/hack-dance/hack/commit/eaab6df))
* feat(session): clarify workspace semantics and tmux onboarding ([cc8a606](https://github.com/hack-dance/hack/commit/cc8a606))
* feat(tickets): add document-backed ticket content ([d166be1](https://github.com/hack-dance/hack/commit/d166be1))
* feat(tickets): define normalized ticket entity model ([de42cea](https://github.com/hack-dance/hack/commit/de42cea))
* feat(tickets): finalize normalization core flow ([957c2ad](https://github.com/hack-dance/hack/commit/957c2ad))
* feat(tickets): make sync writes idempotent ([517031d](https://github.com/hack-dance/hack/commit/517031d))
* feat(tickets): normalize provenance helpers ([77e2c91](https://github.com/hack-dance/hack/commit/77e2c91))
* feat(tickets): normalize ticket replay metadata ([b192f04](https://github.com/hack-dance/hack/commit/b192f04))
* feat(tickets): persist sqlite projection cache ([57c479e](https://github.com/hack-dance/hack/commit/57c479e))
* feat(tickets): use random ticket ids ([1b1c083](https://github.com/hack-dance/hack/commit/1b1c083))
* docs: add adjacent capabilities to cli reference ([20d22bc](https://github.com/hack-dance/hack/commit/20d22bc))
* docs: add agent-native runtime requirements ([263d756](https://github.com/hack-dance/hack/commit/263d756))
* docs: add docs ia proposal and guide labels ([4cbf226](https://github.com/hack-dance/hack/commit/4cbf226))
* docs: add integrations overview ([1a0d9a2](https://github.com/hack-dance/hack/commit/1a0d9a2))
* docs: add linear project artifact design ([565f1b2](https://github.com/hack-dance/hack/commit/565f1b2))
* docs: add tickets normalization core plan ([1f984b2](https://github.com/hack-dance/hack/commit/1f984b2))
* docs: align github cli summaries with workflow story ([2110ab9](https://github.com/hack-dance/hack/commit/2110ab9))
* docs: align integration summaries with cli help ([9cc075c](https://github.com/hack-dance/hack/commit/9cc075c))
* docs: align linear artifact design with shipped verbs ([9650f17](https://github.com/hack-dance/hack/commit/9650f17))
* docs: clarify core offer and docs ia ([4c7f463](https://github.com/hack-dance/hack/commit/4c7f463))
* docs: clarify core offer and docs ia ([daa5ed3](https://github.com/hack-dance/hack/commit/daa5ed3))
* docs: clarify github integration capability story ([c54be5e](https://github.com/hack-dance/hack/commit/c54be5e))
* docs: clarify linear project artifact targeting ([3c512b9](https://github.com/hack-dance/hack/commit/3c512b9))
* docs: clarify shared admin guidance ([9282a3c](https://github.com/hack-dance/hack/commit/9282a3c))
* docs: cross-link planned linear project artifacts ([23f2dd8](https://github.com/hack-dance/hack/commit/23f2dd8))
* docs: define first-class github workflows ([49ce93c](https://github.com/hack-dance/hack/commit/49ce93c))
* docs: define first-class github workflows ([f8192a5](https://github.com/hack-dance/hack/commit/f8192a5))
* docs: define prerequisite detection matrix ([362e256](https://github.com/hack-dance/hack/commit/362e256))
* docs: define teams and organizations admin program ([fcad814](https://github.com/hack-dance/hack/commit/fcad814))
* docs: expand linear project artifact help ([78cc3ea](https://github.com/hack-dance/hack/commit/78cc3ea))
* docs: format github workflow docs ([0bbe84e](https://github.com/hack-dance/hack/commit/0bbe84e))
* docs: format github workflow docs ([75b33bc](https://github.com/hack-dance/hack/commit/75b33bc))
* docs: format github workflow scope docs ([d9f6973](https://github.com/hack-dance/hack/commit/d9f6973))
* docs: format github workflow scope docs ([954e8b2](https://github.com/hack-dance/hack/commit/954e8b2))
* docs: label beta guide entry points ([7ad4ffd](https://github.com/hack-dance/hack/commit/7ad4ffd))
* docs: narrow github workflow scope diff ([4f1251d](https://github.com/hack-dance/hack/commit/4f1251d))
* docs: reposition github setup around workflows ([4511a33](https://github.com/hack-dance/hack/commit/4511a33))
* docs: restore markdown table formatting ([9b09408](https://github.com/hack-dance/hack/commit/9b09408))
* docs: restore markdown table formatting ([7f8cb4d](https://github.com/hack-dance/hack/commit/7f8cb4d))
* docs: split docs into core beta and reference paths ([efd104b](https://github.com/hack-dance/hack/commit/efd104b))
* docs: strengthen runtime requirements review criteria ([165edc7](https://github.com/hack-dance/hack/commit/165edc7))
* docs: surface admin trust boundaries ([ac10f03](https://github.com/hack-dance/hack/commit/ac10f03))
* docs: surface linear project artifact workflows ([cafe775](https://github.com/hack-dance/hack/commit/cafe775))
* docs: survey agent-native runtime baselines ([4347418](https://github.com/hack-dance/hack/commit/4347418))
* docs(env): clarify managed artifact invariants ([73203cd](https://github.com/hack-dance/hack/commit/73203cd))
* docs(linear): align help with project routing UX ([cf74c61](https://github.com/hack-dance/hack/commit/cf74c61))
* docs(readme): center root docs on core promises ([a0daeec](https://github.com/hack-dance/hack/commit/a0daeec))
* docs(readme): fix linear sync example ([ed3737a](https://github.com/hack-dance/hack/commit/ed3737a))
* docs(session): align gateway workspace wording ([421c4ea](https://github.com/hack-dance/hack/commit/421c4ea))
* docs(tickets): add normalized sync implementation plan ([7f5581a](https://github.com/hack-dance/hack/commit/7f5581a))
* docs(tickets): add portability implementation plan ([3e98540](https://github.com/hack-dance/hack/commit/3e98540))
* docs(tickets): clarify portable journal paths ([53d764e](https://github.com/hack-dance/hack/commit/53d764e))
* docs(tickets): clarify projection rebuild triggers ([b35ac6f](https://github.com/hack-dance/hack/commit/b35ac6f))
* docs(tickets): close projection design review gaps ([2cdd096](https://github.com/hack-dance/hack/commit/2cdd096))
* docs(tickets): define git portability contract ([92af187](https://github.com/hack-dance/hack/commit/92af187))
* docs(tickets): define normalized sync idempotency ([5fe5859](https://github.com/hack-dance/hack/commit/5fe5859))
* docs(tickets): design sqlite projection and journal ([7b316b7](https://github.com/hack-dance/hack/commit/7b316b7))
* docs(tickets): document sqlite projection cache ([e6c8cb8](https://github.com/hack-dance/hack/commit/e6c8cb8))
* docs(tickets): finalize projection doc cleanup ([18ee39f](https://github.com/hack-dance/hack/commit/18ee39f))
* docs(tickets): format projection docs ([a0f4e4a](https://github.com/hack-dance/hack/commit/a0f4e4a))
* docs(tickets): harden projection replay design ([7c8b476](https://github.com/hack-dance/hack/commit/7c8b476))
* docs(tickets): plan sqlite projection implementation ([c8e6d92](https://github.com/hack-dance/hack/commit/c8e6d92))
* docs(tickets): record journal projection architecture ([8ae5759](https://github.com/hack-dance/hack/commit/8ae5759))
* docs(tickets): resolve projection design review ([474f1dd](https://github.com/hack-dance/hack/commit/474f1dd))
* docs(tickets): tighten sqlite projection handoff docs ([86870d6](https://github.com/hack-dance/hack/commit/86870d6))
* refactor: simplify linear artifact target selection ([8fd8107](https://github.com/hack-dance/hack/commit/8fd8107))

## <small>1.17.1 (2026-03-09)</small>

* fix: trigger release after merged linear integration ([c8991f9](https://github.com/hack-dance/hack/commit/c8991f9))
* fix(tests): avoid keychain dependency in linear alias test ([43654c2](https://github.com/hack-dance/hack/commit/43654c2))
* fix(tests): harden tickets and linear alias CI behavior ([4ef36e5](https://github.com/hack-dance/hack/commit/4ef36e5))
* fix(tests): parse linear alias json payload robustly ([6f4f9fb](https://github.com/hack-dance/hack/commit/6f4f9fb))
* fix(tests): use config-only linear alias coverage ([42ca8b1](https://github.com/hack-dance/hack/commit/42ca8b1))
* Fix Linear integration setup and docs (#18) ([3a46a21](https://github.com/hack-dance/hack/commit/3a46a21)), closes [#18](https://github.com/hack-dance/hack/issues/18)

## 1.17.0 (2026-02-28)

* fix(tests): replace private-ip route fixture ([1373858](https://github.com/hack-dance/hack/commit/1373858))
* feat(remote): add route bridge status/repair commands and docs ([e53edfd](https://github.com/hack-dance/hack/commit/e53edfd))

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
