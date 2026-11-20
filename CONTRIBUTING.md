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

After changing browser or MCP App sources, run `bun run build:browser` and commit `hosts/browser/dist/app.js`, `app.css`, `index.html`, `mcp-app.html` and `mcp-app-manifest.json`; `bun run check:browser-build` rebuilds both entries and compares all five files. The browser and App use the same shell and renderer; the browser retains external local scripts and styles, while the App HTML contains its assets. The manifest's `uiBuildId` fingerprints the unfinalized App shell and bundle; `assetDigest` is SHA-256 of final HTML bytes and identifies the immutable `ui://brain-trail/dashboard/<assetDigest>.html` resource. After changing relay sources, use Go 1.27.3 and run `bun run build:relay`, then commit `hosts/relay/bin/brain-trail-relay-{linux,darwin,windows}-{amd64,arm64}[.exe]`; `bun run check:relay-build` cross-builds and compares the six binaries. Browser Three.js 0.160.0, its used addons and their license are bundled locally. The relay distribution includes the x/sys license.

The relay build also copies the exact license texts for the pinned Go MCP SDK and linked JSON schema, URI template and Segmentio modules from the Go module cache into `hosts/relay/bin/`; commit those `LICENSE-*` files alongside the binaries. The freshness check compares their bytes and MCPB packages include them together with the existing Go and x/sys licenses. Revisit the notice list when the linked dependency graph changes.

After generating fresh browser assets and relay binaries, `bun run build:mcpb` creates six deterministic target-specific archives under `.artifacts/mcpb/`, named `brain-trail-<version>-<os>-<arch>.mcpb`. Each contains the matching binary, App HTML and manifest; packaging does not build or validate those inputs. Run the existing freshness and archive checks before release and validate the resulting bundles separately with the official MCPB tool. The MCPB format describes platform but not architecture: distribute the matching architecture explicitly. Binary targets are Linux, macOS and Windows on amd64/arm64; this is a build target list, not evidence of installation, sandbox or runtime support on those platforms. MCPB documentation describes Claude Desktop installation on macOS and Windows; Linux installation behavior requires separate validation.

For manual Desktop stdio registration of the separate paired Chat App, use the `brain-trail` key, the matching absolute executable path and arguments `mcp` and the absolute directory containing the App assets. An MCPB host may generate a different server name. Do not register a duplicate server in the native plugin. The App views an explicitly paired native session and does not automatically capture Chat. Neither this registration nor the relay is required to open the native Desktop pane. Host tool forwarding, pairing and actual platform behavior remain separate acceptance checks.

Install the optional local Lefthook checks with `bun run prepare`. The guarded installer never changes `core.hooksPath`. Git worktrees share their canonical hooks directory; existing hooks are accepted only when their exact bytes match this project's installation receipt. Unowned or modified hooks are left untouched.

Runtime source changes require a newer plugin version and a matching marketplace entry. With an OMP manifest, the root package version must match them. Changes to root `omp`, `files`, `exports`, `dependencies`, `optionalDependencies`, `peerDependencies` or `engines` count as runtime changes; scripts and dev dependencies alone do not. The baseline is `VIEW_BASE`, then `RELEASE_BASE`, then `origin/main`. CI supplies the event's baseline; an all-zero default-branch baseline is refused rather than compared to the candidate itself. For Brain Trail release-tag pushes, CI uses the commit SHA of the previous `brain-trail/v[0-9]*` tag on first-parent ancestry starting at `HEAD^1`, excluding tags on the candidate commit; it fails if no such predecessor exists.

The quality workflow validates and tests an archived source copy without `.git` or `node_modules`. Its production relay matrix runs Go tests and an archived-package SDK fixture across six hosted OS/architecture targets and Claude CLI 2.1.321/2.1.322. The production proof must exercise the no-runtime distribution path and real cross-account isolation on hosted Linux, macOS and Windows. Windows archive extraction uses `SystemRoot`'s `System32/tar.exe` and retains failure diagnostics; the cross-account process proof uses native PID, exact-image and liveness checks rather than WMI, and service cleanup waits for that process to exit. Require a fresh matrix for the candidate rather than inferring success from a rebuild. The fixture is not real Desktop native-policy proof.

On Windows the same SDK session exercises the shipped `hooks/workspace.ts` inventory: exact ASCII/Unicode listing, exit-code propagation, a hostile `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/config environment with a positive control, and current-directory `git.cmd`/`cmd.exe` decoys. The relay socket runs under a non-ASCII LocalAppData within the 100-byte socket budget; this does not exercise a fully non-ASCII user profile. The proof adds only the runner's Git directory to its isolated PATH and refuses any PATH entry that provides Node or Bun.

Before merge or tag, execute the production matrix and exercise the final candidate in real Claude Desktop. Click **Open Brain Trail** and verify that the owned pane shows the dashboard without MCP Browser, a registered Chat MCP server or a relay for its live map. Verify live file activity, 2D/3D switching and gestures, replay, all tabs, legend drill-down, settings, fit on resize and in expanded mode, and scrolling in a long tab. While the 3D map remains open at its default zoom, make two read-only calls to the same external MCP service: the station and arc should appear on the first call and the station count should increment on the second. Exercise file preview and approved external opening through the relay. Open from the command with the band disabled or collapsed; confirm there is no model turn or clipboard write and that closing the pane leaves unrelated panes alone.

Independently press the widget’s globe, check that the dashboard opens in the system’s default browser and the handoff status appears below the buttons. Confirm no clipboard write. From `/brain-trail-v2` exercise **Copy link**, manually paste into a live Claude Browser tab and an external browser, and check one-use expiry and refresh. Exercise the browser’s 2D and WebGL 3D, its tabs and actions, context memory facts and fail-closed lifecycle; verify known outside-workspace previews and allowed external application opens work without an extra confirmation. Independently register the Chat MCP App and exercise pairing, detach and reset. Record actual results and limits: the production matrix and SDK tests do not establish Desktop behavior.

3D requires WebGL in the hosting browser. The unavailable-WebGL notice contains the failure and leaves the dashboard and explicit 2D view accessible; it is not evidence that 3D works in Claude's Browser. Exercise 3D in the real host separately. If unavailable, use 2D or a WebGL-capable browser and inspect the host's graphics acceleration settings where supported.

Launch tests use controlled child processes and exercise receipts and eventual exit handling; a controlled Linux PATH-opener test covers selection, execution and outcome, not full `openPath` end-to-end behavior or a desktop application opening a document. On Linux the default opener resolves `xdg-open` through PATH. The relay does not wait synchronously for it or promise a process-tree lifetime.

## View parity

`bun run check:views` compares the working source with the baseline through the pinned native runner and browser execution. Native dashboard rendering is exercised through its owned Desktop pane; preserve meaningful checks for capture, band and command entry, and the browser’s tabs, 2D/3D scenes, actions and states across themes and languages.

Browser 3D captures use the launcher available on each revision: the candidate widget’s globe, an older widget’s **Copy link**, or the historical baseline’s native pane. Playback uses each revision’s own shipped browser page or historical relay shell.

The receipt at `.artifacts/view-parity/receipt.json` identifies the baseline, candidate and fixture evidence. Review intentional differences against the migration; missing artifacts and capture, decode, network, console or browser execution failures are not visual approvals. Raster comparisons are diagnostic rather than proof of interaction or real Desktop rendering.

The browser visibility guard samples compositor pixels around a known read file in dark and light themes with the camera and clock stable, excluding DOM labels and tooltips; it checks canvas contrast rather than treating overlays as visible points.

The browser picking oracle exhausts integer CSS-client coordinates for its search; it does not establish continuous or subpixel visibility.

Do not treat an element-tree or raster comparison alone as proof of browser interactions or real Desktop rendering.

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

These checks do not capture Claude Desktop's own pixels on Linux. Real Desktop acceptance must visibly open the native pane and observe a session-driven map update, independently exercise Chat App pairing and browser handoff; an isolated web or MCP protocol proof is not Desktop evidence.

## Modules

| Files | Interface and responsibility |
| --- | --- |
| `types/model.ts`, `types/view.ts`, `types/browser.ts`, `types/apps.ts` | Host-free session, shared view, browser and App wire contracts, including native command scopes. |
| `hooks/views.ts`, `hooks/view-*.ts`, `hooks/view-controller.ts`, `hooks/workspace.ts` | Shared view data, transitions and workspace logic, without Claude, Bun or DOM globals. |
| `hooks/fold.ts`, `hooks/readout.ts`, `hooks/scene3d.ts` | Replay, context and file projections and shared scene geometry. |
| `hooks/acts.ts`, `hooks/files.ts`, `hooks/mcp.ts` | Current tool names, file detection and connector interpretation. Host-free does not mean host-neutral. |
| `hooks/register.tsx`, `hooks/app-binding.ts`, `hosts/native/` | Claude capture, lifecycle, native controls and verifier-bound binding; native command/file authority. |
| `hooks/map.ts`, `hosts/browser/`, `hosts/mcp-app/` | One page/controller and SVG 2D/WebGL 3D renderer; browser SSE/POST and App-only MCP adapters. |
| `hosts/omp/` | OMP capture, lifecycle, persistence and native command authority. |
| `hosts/relay/` | Packaged Go browser/private relay and stdio MCP server; approved grants, leases and requests; shared native client. |

The host owns replay and shared preview, zoomed and play state. Tabs and WebGL camera remain surface-local. Hosts retain separate durable stores.

Workspace discovery removes Git-reported repository-local environment variables before listing files in the workspace, so inherited `GIT_DIR` or `GIT_INDEX_FILE` cannot redirect that listing to another repository. Native and OMP use the same explicit inventory safety arguments: fsmonitor and pager off, hooks pointed at the platform null device, and the `ext` protocol disabled. On Windows, native inventory uses validated absolute `SystemRoot\System32\cmd.exe` with `/d /v:off`, a quote-free body of validated names and static arguments, and `NoDefaultCurrentDirectoryInExePath` for the child. After stripping local variables both hosts set `GIT_NO_LAZY_FETCH=1`, which suppresses lazy fetching only on Git 2.44 or newer. Ordinary global config, excludes, `safe.directory` and credentials remain available.

When Git inventory fails or returns no files, native workspace discovery falls back to filesystem enumeration. On Windows this uses the absolute `System32\WindowsPowerShell\v1.0\powershell.exe` under the validated `SystemRoot`; a missing or invalid root raises an inventory error before launching a shell.

ChatGPT is deferred; an OpenAI API integration is not a substitute for a ChatGPT host adapter.

`bun run test:omp` runs `scripts/omp-journey.ts` in an isolated agent directory against the genuine pinned OMP 18.18.9 SDK and extension lifecycle. It uses the SDK's mock model transport, not a mock host: the journey exercises real session and tool behavior without a model call. Keep SDK-specific event normalization in the adapter rather than assuming Claude tool names are universal.

The journey also pairs a separate packaged Go MCP process through the authenticated browser route, reads real native fixture state, and checks guarded replay, detach, stale generation and remount behavior. A genuine registered MCP opener is called through the scripted OMP model transport; after disconnecting that server, reload verifies adapter data stays out of Brain Trail capture while an unrelated connector remains visible. This proves the exercised local SDK and protocol paths, not Claude Desktop's App rendering or permission policy.

## Native contract and SDK

`types/index.d.ts` is the native plugin-state contract. The validator requires it to be self-contained: do not import or re-export `model.ts` there. `types/contracts.ts` checks exact equality between its persisted data types and the application model, including optional and readonly fields. Update both sides together; a divergence fails typechecking.

`.claude-plugin/sdk/` contains genuine declarations generated by Claude Code 2.1.322, with an intentionally empty MCP tool interface. These declarations are for development, not a replacement runtime. `bun run check:sdk` rejects a mismatch between the generated header and the CLI dependency.

Native hosts retain session state and file authority. **Open Brain Trail** opens the native dashboard without a model prompt, MCP Browser call or relay. **Pair with Chat** issues a short-lived envelope for pasting only inside an unpaired App. The widget’s globe explicitly dispatches the same private-file browser launch as OMP; **Copy link** in the command output retains the one-use address-bar flow. Starting a session or mounting controls must not open a browser, change the clipboard or send a model turn.

Native MCP completion must validate the versioned success envelope from `structuredContent`, or from exactly one JSON text block when structured content is absent. Claude Desktop can project the public envelope into that text block. Present malformed structured content must not fall back to text, and a plain success word is not a valid envelope. Decoding success does not grant authority: the current-session checks and the private relay's claimed-approval check remain required.

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
