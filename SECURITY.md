# Security policy

## Report a vulnerability privately

Email **[team@unkillablecompanies.com](mailto:team@unkillablecompanies.com)** to report a suspected security vulnerability in Brain Trail.

Do not disclose vulnerability details in a public issue or pull request. Keep the report private while we assess it and agree on remediation and disclosure.

Include, where available:

- The affected Brain Trail version or commit, Claude Code or Oh My Pi version, operating system and surface.
- The security impact and any required conditions or permissions.
- Minimal reproduction steps or a proof of concept using synthetic files and session data.
- Relevant logs or screenshots with sensitive information removed.

Do not send API keys, access tokens, private vault contents, unredacted session exports or customer data. Describe the exposure without reproducing real secrets.

## Scope

Reports may concern unexpected file access or modification, session or vault data exposure, generated browser content, dependencies, or the plugin's distribution process.

Test only on systems and data you own or are authorized to assess. Do not access another person's data or disrupt their sessions.

## Browser and file boundaries

- Both hosts use a packaged relay listening on `127.0.0.1` on a random port. The Desktop widget’s globe and OMP’s browser action ask the private host relay to open a generation-bound, one-use bootstrap file in the default application. The launcher accepts no user-supplied URL or command. Only one file bootstrap can be pending. The separate **Copy link** action in `/brain-trail-v2` issues a fresh generation-bound link and invalidates the prior pending link; paste it only into a browser address bar. Bootstraps expire after 120 seconds. Mounting controls or running the command neither opens a browser nor copies a link.
- Exchanging a bootstrap redirects to a browser session URL with a separate relay-lifetime token. Unlike a pending generation-bound launch link, that session URL is not revoked by a later generation, clear or resume; it remains valid while the relay lives, until host session shutdown closes it or the relay otherwise stops. Anyone with it can access the current session within the file and action boundaries below. Requests require the exact Host and POST requests the exact Origin; CORS is not enabled. Responses include `Referrer-Policy: no-referrer`.
- Host control uses a separate private Unix-domain socket on all supported platforms, authenticated with a host token; it is not exposed on the browser listener. Browser POST bodies are limited to 65,536 bytes, host requests to 4,194,304 bytes, host responses to 2 MiB and relay frames to 256 KiB. Oversized, stale, disconnected or otherwise invalid operations are refused rather than silently accepted.
- The host resolves known session paths and permits only the default application or an application in its discovered registry. Unknown paths and arbitrary application names are refused. Brain Trail does not add a confirmation for previews or external application opens. Possession of the authenticated browser session therefore permits these bounded actions, including previews of known paths outside the workspace; it is not proof of a human click.
- Access is tied to the recorded path, not the file seen earlier. Edits, replacement and symlink or hard-link changes can change what a later preview or open reads. Protected operations hold a regular-file descriptor and verify its identity from preparation through the effect; they do not pin historical contents. Canonical workspace confinement and bounded preview reads remain enforced, and the host rechecks the session generation before acting and after preview reads. These boundaries apply to Linux, macOS and Windows; unsupported filesystem guarantees result in refusal rather than an insecure fallback.
- An open action may execute the default application, shortcuts or scripts. External applications reopen the canonical pathname, so the handoff is neither atomic nor a sandbox guarantee. A selected application failure does not silently switch to another application.
- The private host launch endpoint returns a spawned or dispatched receipt, not proof an application or document opened. Each spawned child has one asynchronous reaper; a nonzero exit is reported to the current-generation host, not interpreted as proof of document state. Application failure is nonfatal to the relay unless its outcome cannot be delivered. There is no synchronous `xdg-open` wait, arbitrary delay, fallback application or process-tree lifetime promise.
- Relay cleanup on POSIX is best effort. On Windows or after an ungraceful kill, a private dead socket or expired bootstrap file can remain; there is no unsafe scavenger. Browser-port takeover after relay death remains a residual risk. The design does not defend against arbitrary malicious code running as the same OS account, administrator or root.
- Claude's durable store remains separate from OMP's active-profile `brain-trail/trail.sqlite`, which holds settings, costs and captured tool-call data. Captures may contain session content; workspace paths and layouts are cached too. Clearing the visible trail does not erase stored captures.
- OMP Coach reads the selected `AGENTS.md` or `CLAUDE.md` in the actual session working directory and runs a quiet turn with tools disabled. Apply fills the OMP editor; it does not send a prompt or write the file.

## MCP App boundaries

- The Desktop-registered MCP server is a separate local process. Chat views and controls one explicitly paired native Code/OMP session; it does not acquire global Chat history or native file authority by itself. The App and browser share the same renderer, but use distinct authenticated transports.
- Code binding requires native approval and a verifier held by the opener's MCP process. The public marker and local socket locator are not credentials; routing names are not executable or vendor attestation. A locator can nevertheless disclose account or profile-path metadata to the routed peer. This design assumes a trusted installed opener and host; it does not authenticate arbitrary same-account executables.
- Chat pairing is an explicit native or authenticated-browser action. Its single-use envelope expires after 120 seconds and is a credential: paste it only inside the intended App, never into conversation text or a URL. A paired App may perform the native session's allowed commands, previews and external application opens, including known outside-workspace paths. It cannot issue another pairing or invoke host-control endpoints.
- Claims and grants use separately authenticated routes on the protected local socket, never the public browser listener. Grants are bound to native owner, generation, relay lifetime and a mounted lease; each request has a live operation guard, rechecked before effects and private replies. Clear/session transitions revoke old authority. Exact-scope retirement notifications cancel native request handling and release only that operation's Coach reservation; old results cannot clear a newer run. Cancellation cannot undo an effect already started or data already delivered, and unresolved underlying work retains bounded admission capacity until it settles. Commands are never automatically replayed.
- App data and control credentials use MCP `_meta`, not model-visible tool content. This is not encryption or a promise that the host never retains metadata. Recognized adapter operations are excluded from Brain Trail capture before scanning or raw persistence. OMP uses genuine tool descriptors and persisted host result metadata rather than parsing ambiguous minted names; historical rows lacking both cannot be retroactively identified. Host-owned transcripts and pre-existing captures are not erased by these filters.
- Handled App refusals are delivered as `ok: false` inside private `_meta.brainTrail` with a successful outer MCP result; they remain refusals and never expose their code in public content. Missing or invalid private replies and outer protocol errors are not treated as authorization outcomes.

An inactive mount cannot command; an active bound-grant lease expires after 15 seconds without activity, with bounded inactive retention of 120 seconds. An unbound mounted pairing view has a 120-second inactivity lifetime without background polling. Missing or stale private bootstrap stays detached. Explicit **Reset view** creates a new unpaired view and cannot restore a grant from a public marker. Immutable resource digests and embedded UI build identity reject mismatched App assets.

## Non-security issues

Use the repository's public issue tracker for ordinary bugs and feature requests that do not expose sensitive information. See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and contribution expectations.
