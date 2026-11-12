# Contributing to Brain Trail

## Product reference

The UI and behavior of this public repository are the reference. Archived implementations can inform technical decisions; they are not a replacement product specification.

Keep technical refactors separate from intentional product changes. Preserve the views, interactions, file and connector classification, state keys and stored shape versions unless the change explicitly calls for modifying them.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue or pull request.

## Development checks

The Claude plugin is distributed as source. The OMP package includes committed browser assets; users do not need to build them. Development tools are pinned in `package.json`; the quality workflow uses Bun 1.4.4 and Node 22.22.0.

```bash
bun install --frozen-lockfile --ignore-scripts
bunx playwright install chromium
bun run verify
```

`verify` checks browser-bundle freshness, the pinned Claude SDK, source-distribution version, tooling regressions, native plugin validation and tests, the OMP SDK journey, correctness lint, incremental formatting, four TypeScript boundaries (shared core, Claude, OMP host and browser), and view parity. Formatting covers new handwritten code, not Pierre's original renderers.

After changing OMP browser sources, run `bun run build:omp` and commit the resulting assets in `hosts/omp/browser/dist/`. `bun run check:omp-build` rebuilds to temporary output and compares bytes against the committed bundle.

Install the optional local Lefthook checks with `bun run prepare`. The guarded installer never changes `core.hooksPath`. Git worktrees share their canonical hooks directory; existing hooks are accepted only when their exact bytes match this project's installation receipt. Unowned or modified hooks are left untouched.

Runtime source changes require a newer plugin version and a matching marketplace entry. With an OMP manifest, the root package version must match them. Changes to root `omp`, `files`, `exports`, `dependencies`, `optionalDependencies`, `peerDependencies` or `engines` count as runtime changes; scripts and dev dependencies alone do not. The baseline is `VIEW_BASE`, then `RELEASE_BASE`, then `origin/main`. CI supplies the event's baseline; an all-zero default-branch baseline is refused rather than compared to the candidate itself.

The quality workflow also validates and tests a complete source copy without `.git` or `node_modules`, exercising the marketplace's root source rather than a separate development entry point.

## View parity

`bun run check:views` compares the working source with the baseline through the pinned native runner. The manifest covers the six panes, the prompt band, desktop and terminal surfaces, dark and light themes, English and French, inline and browser 3D, and targeted loading, error, empty and transition states.

The receipt at `.artifacts/view-parity/receipt.json` identifies the baseline commit, frozen candidate-source hash, fixture matrix, and native-tree, SVG-source, browser `index.html`, and `data.js` byte comparisons. Raster pixel mismatches are retained and diagnostic; they do not fail that proof. Capture, decode, network, and missing-artifact errors still fail it. For SVGs, CSS animations are materialized at 1600 ms with `commitStyles()` and cancelled; SMIL is paused at 1.6 seconds. This compares one frame, not motion parity. The browser scene uses real WebGL, its production page, and held-key navigation. It loads Three and fonts from their existing public CDNs; this is not an offline check.

Only opaque numeric press handles and verified temporary module locations are treated as nonvisual. SVG source bytes are the SVG proof. The raster is a diagnostic of the materialized frame, not a substitute for the source comparison.

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
browser HTML/data differences and operational failures cannot be approved.

These checks do not capture Claude Desktop's own pixels on Linux. Claude Code 2.1.322's test runner also drops the pointer's `fine` field before the real Client handler receives it: resized cell-centre gestures are exercised, but sub-cell precision is not established by those tests.

## Modules

| Files | Interface and responsibility |
| --- | --- |
| `types/model.ts`, `types/view.ts` | Host-free session data and the shared view contract. |
| `hooks/views.ts`, `hooks/view-*.ts`, `hooks/view-controller.ts`, `hooks/workspace.ts` | Shared tab views, transitions and workspace logic, without Claude, Bun or DOM globals. |
| `hooks/fold.ts`, `hooks/readout.ts`, `hooks/pointer.ts` | Replay, context and file projections, and pointer geometry without host calls. |
| `hooks/acts.ts`, `hooks/files.ts`, `hooks/mcp.ts` | Current tool names, file detection and connector interpretation. Host-free does not mean host-neutral. |
| `hooks/register.tsx` | Claude SDK calls, state, lifecycle, queues, timers, storage and native view adapter. |
| `hooks/map.ts`, `hooks/spin.ts`, `hooks/brain3d.ts` | SVG and browser rendering. The pane's SVG budget is 131,072 characters. |
| `hosts/omp/` | Genuine OMP capture and lifecycle adapter, local server, file authority, persistence and browser renderer. |

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
