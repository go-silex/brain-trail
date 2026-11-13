# Contributing to Brain Trail

## Product reference

The UI and behavior of this public repository are the reference. Archived implementations can inform technical decisions; they are not a replacement product specification.

Keep technical refactors separate from intentional product changes. Preserve the views, interactions, file and connector classification, state keys and stored shape versions unless the change explicitly calls for modifying them.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue or pull request.

## Development checks

The Claude plugin is distributed as source with committed browser assets and six standalone Go relay binaries. Claude end users need no Node, Bun or Go installation or lifecycle build. Development tools are pinned in `package.json`; CI uses Bun 1.4.4, Node 22.22.0 and Go 1.27.3.

```bash
bun install --frozen-lockfile --ignore-scripts
bunx playwright install chromium
bun run verify
```

`verify` checks browser-bundle and relay-binary freshness, the pinned Claude SDK, source-distribution version, tooling regressions, native plugin validation and tests, the OMP SDK journey, correctness lint, incremental formatting, four TypeScript boundaries (shared core, Claude, OMP host and browser), and view parity. It includes `bun run test:workspace-git`, a real-Git workspace inventory safety test; the authored test is included in the package gate. Formatting covers new handwritten code, not Pierre's original renderers.

After changing browser sources, run `bun run build:browser` and commit `hosts/browser/dist/app.js` and `app.css`; `bun run check:browser-build` rebuilds and compares bytes. After changing relay sources, use Go 1.27.3 and run `bun run build:relay`, then commit `hosts/relay/bin/brain-trail-relay-{linux,darwin,windows}-{amd64,arm64}[.exe]`; `bun run check:relay-build` cross-builds and compares the six binaries. Browser Three.js 0.160.0, its used addons and their license are bundled locally. The relay distribution includes the x/sys license.

Install the optional local Lefthook checks with `bun run prepare`. The guarded installer never changes `core.hooksPath`. Git worktrees share their canonical hooks directory; existing hooks are accepted only when their exact bytes match this project's installation receipt. Unowned or modified hooks are left untouched.

Runtime source changes require a newer plugin version and a matching marketplace entry. With an OMP manifest, the root package version must match them. Changes to root `omp`, `files`, `exports`, `dependencies`, `optionalDependencies`, `peerDependencies` or `engines` count as runtime changes; scripts and dev dependencies alone do not. The baseline is `VIEW_BASE`, then `RELEASE_BASE`, then `origin/main`. CI supplies the event's baseline; an all-zero default-branch baseline is refused rather than compared to the candidate itself.

The quality workflow validates and tests an archived source copy without `.git` or `node_modules`. Its production relay matrix runs Go tests and an archived-package SDK fixture across six hosted OS/architecture targets and Claude CLI 2.1.321/2.1.322. The production proof must exercise the no-runtime distribution path and real cross-account isolation on hosted Linux, macOS and Windows. Windows archive extraction uses `SystemRoot`'s `System32/tar.exe` and retains failure diagnostics; require a fresh matrix for the candidate rather than inferring success from a rebuild. The fixture is not real Desktop native-policy proof.

Before merge or tag, execute the production matrix and exercise the final candidate in real Claude Desktop: graph fit, resize, 2D/3D, browser opening, common tabs and settings, shared selection/follow/replay, context memory facts, consent and fail-closed lifecycle. Leave a native consent prompt unanswered while an unrelated browser action succeeds. This actual Desktop interaction is a release gate, not an implementation prerequisite; the SDK runner cannot hold `ui.ask` for that concurrency proof. Record actual results and unresolved limitations; cross-compilation, SDK fixtures or source-only packaging do not establish Desktop behavior.

Launch tests use controlled child processes and exercise receipts and eventual exit handling; a controlled Linux PATH-opener test covers selection, execution and outcome, not full `openPath` end-to-end behavior or a desktop application opening a document. On Linux the default opener resolves `xdg-open` through PATH. The relay does not wait synchronously for it or promise a process-tree lifetime.

## View parity

`bun run check:views` compares the working source with the baseline through the pinned native runner. The manifest covers the six panes, the prompt band, desktop and terminal surfaces, dark and light themes, English and French, inline and browser 3D, and targeted loading, error, empty and transition states.

The receipt at `.artifacts/view-parity/receipt.json` identifies the baseline commit, frozen candidate-source hash and fixture matrix. It compares native trees and SVG source and viewport, and executes historical and candidate browser scenes with semantic and action checks. Raster pixel differences are diagnostic; capture, decode, network, console and missing-artifact failures remain fatal. SVG CSS animations are materialized at 1600 ms and SMIL is paused at 1.6 seconds: this compares one frame, not motion parity. Historical scene dependencies are supplied locally for the test; the candidate bundles its own.

Only opaque numeric press handles and verified temporary module locations are treated as nonvisual. SVG source bytes are the SVG proof. The raster is a diagnostic of the materialized frame, not a substitute for the source comparison.

The Claude Code 2.1.322 native runtime uses the OS timezone, not `TZ`. The
manifest observes that timezone for both isolated roots and fails before case
captures unless it is `Europe/Paris`, the reviewed proof corpus timezone.
CI configures its disposable runner; local checks do not change the OS timezone.
Rendered times remain part of the exact proof. Browser scenes use UTC.

To land intentional view changes, add `tests/fixtures/view-changes.json` with
the full baseline commit SHA, a non-empty reason, and per-case exact proof
fingerprints, for example:
`{"baseline":"<40-hex SHA>","reason":"...","cases":{"case-name":{"tree":"<64-hex SHA>","svg:1:source":"<64-hex SHA>"}}}`.
Only `tree`, `svg:<index>:source`, and `svg:<index>:viewport` are authorizable.
Review the failed receipt's `observedDifferences` alongside the raw and normalized
tree and SVG artifacts before copying each fingerprint into the declaration.
Fingerprints bind both baseline and candidate: the canonical tree pair, the SVG
source SHA-256 pair, or the complete viewport pair respectively. Unused or
mismatched approvals fail. Declarations apply only to their exact baseline;
browser execution failures and operational failures cannot be approved.

These checks do not capture Claude Desktop's own pixels on Linux. Claude Code 2.1.322's test runner also drops the pointer's `fine` field before the real Client handler receives it: resized cell-centre gestures are exercised, but sub-cell precision is not established by those tests.

## Modules

| Files | Interface and responsibility |
| --- | --- |
| `types/model.ts`, `types/view.ts`, `types/browser.ts` | Host-free session, shared view and browser protocol contracts. |
| `hooks/views.ts`, `hooks/view-*.ts`, `hooks/view-controller.ts`, `hooks/workspace.ts` | Shared tab views, transitions and workspace logic, without Claude, Bun or DOM globals. |
| `hooks/fold.ts`, `hooks/readout.ts`, `hooks/pointer.ts`, `hooks/scene3d.ts` | Replay, context and file projections, pointer geometry and shared scene geometry. |
| `hooks/acts.ts`, `hooks/files.ts`, `hooks/mcp.ts` | Current tool names, file detection and connector interpretation. Host-free does not mean host-neutral. |
| `hooks/register.tsx`, `hosts/native/` | Claude SDK calls, host-owned state, lifecycle, storage and native adapter. |
| `hooks/map.ts`, `hooks/spin.ts`, `hosts/browser/` | Shared map shell and SVG renderer, plus the browser UI and WebGL renderer. The pane's SVG budget is 131,072 characters. |
| `hosts/omp/`, `hosts/relay/` | OMP capture, lifecycle and persistence; Go relay, file authority and SDK-safe client shared by hosts. |

The host owns replay and shared preview, zoomed and play state. Tabs and WebGL camera remain surface-local. Hosts retain separate durable stores.

Workspace discovery removes Git-reported repository-local environment variables before listing files in the workspace, so inherited `GIT_DIR` or `GIT_INDEX_FILE` cannot redirect that listing to another repository. Native `env`/PowerShell and OMP use the same explicit inventory safety arguments: fsmonitor and pager off, hooks pointed at the platform null device, and the `ext` protocol disabled. After stripping local variables they set `GIT_NO_LAZY_FETCH=1`, which suppresses lazy fetching only on Git 2.44 or newer. Ordinary global config, excludes, `safe.directory` and credentials remain available. If discovery cannot use Git, it falls back to filesystem enumeration.

ChatGPT is deferred; an OpenAI API integration is not a substitute for a ChatGPT host adapter.

`bun run test:omp` runs `scripts/omp-journey.ts` in an isolated agent directory against the genuine pinned OMP 18.18.9 SDK and extension lifecycle. It uses the SDK's mock model transport, not a mock host: the journey exercises real session and tool behavior without a model call. Keep SDK-specific event normalization in the adapter rather than assuming Claude tool names are universal.

## Native contract and SDK

`types/index.d.ts` is the native plugin-state contract. The validator requires it to be self-contained: do not import or re-export `model.ts` there. `types/contracts.ts` checks exact equality between its persisted data types and the application model, including optional and readonly fields. Update both sides together; a divergence fails typechecking.

`.claude-plugin/sdk/` contains genuine declarations generated by Claude Code 2.1.322, with an intentionally empty MCP tool interface. These declarations are for development, not a replacement runtime. `bun run check:sdk` rejects a mismatch between the generated header and the CLI dependency.

`ClientSurface.post` keeps only the latest undelivered message in a frame. Map
drags carry a safe-integer press identity so a new press starts from the latest
drawn frame even if its predecessor's `dragend` was replaced. A hover, click,
or leave concludes a drag; native Hit suppresses leave during pointer capture
and emits it on an outside release. The browser emitter follows the same contract.

For an SDK upgrade:

1. Generate fresh declarations with the newly pinned CLI in a disposable plugin containing an empty hook module.
2. Launch it with `--plugin-dir` pointing at that plugin, `--setting-sources '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'`, and let the engine write `.claude-plugin/types/` before sending any prompt.
3. Copy those declarations to `.claude-plugin/sdk/`, keeping the MCP interface empty. Do not copy declarations from a personal session with private connectors.
4. Update the exact CLI dependency and lockfile in the same change, then run `bun run verify`.

## Evidence for a pull request

- Explain the user-visible behavior affected and whether the change is technical or intentionally changes the product.
- Record the checks actually run. For a behavior change or a regression, cover the affected behavior through the interface a caller uses; avoid assertions about source strings or implementation structure.
- For a view or shared-rendering change, compare before and after using the same data, viewport and animation time. Identify the baseline revision, views, states, surfaces, themes and languages exercised.
- Distinguish native SDK element-tree and interaction tests from actual rendered-surface evidence. A passing test suite or one identical SVG does not establish that every view and state is visually unchanged.
- Use synthetic session and vault data. Do not include private notes, session exports, connector metadata, credentials or personal absolute paths in reports, fixtures or screenshots.
