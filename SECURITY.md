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

- Both hosts use a packaged relay. The browser listens on `127.0.0.1` on a random port under a session-token URL. A private, one-use, expiring bootstrap opens it. Only one bootstrap may be pending: another request returns busy before opening or overwriting it; consumption, expiry or an error releases the matching slot. Keep the URL and bootstrap private. Requests require the exact Host and POST requests the exact Origin; CORS is not enabled. Responses include `Referrer-Policy: no-referrer`.
- Host control uses a separate private Unix-domain socket on all supported platforms, authenticated with a host token; it is not exposed on the browser listener. Browser POST bodies are limited to 65,536 bytes, host requests to 4,194,304 bytes, host responses to 2 MiB and relay frames to 256 KiB. Oversized, stale, disconnected or otherwise invalid operations are refused rather than silently accepted.
- The browser is untrusted and cannot grant itself file or application authority or request an arbitrary public open. The host resolves known session references and permits only the default application or an application in its discovered registry. An outside-workspace preview and every external application open require fresh host confirmation; dismissal, headless confirmation and stale generations are refused.
- Protected file operations use held regular-file handles, canonical confinement and identity checks. Preview reads are bounded; the host rechecks the session generation after consent and before acting. These boundaries apply to Linux, macOS and Windows; unsupported filesystem guarantees result in refusal rather than an insecure fallback.
- After consent, the default application, shortcuts or scripts may execute. External applications reopen the canonical pathname, so the handoff is neither atomic nor a sandbox guarantee. A selected application failure does not silently switch to another application.
- The private host launch endpoint returns a spawned or dispatched receipt, not proof an application or document opened. Each spawned child has one asynchronous reaper; a nonzero exit is reported to the current-generation host, not interpreted as proof of document state. Application failure is nonfatal to the relay unless its outcome cannot be delivered. There is no synchronous `xdg-open` wait, arbitrary delay, fallback application or process-tree lifetime promise.
- Relay cleanup on POSIX is best effort. On Windows or after an ungraceful kill, a private dead socket or expired bootstrap file can remain; there is no unsafe scavenger. Browser-port takeover after relay death remains a residual risk. The design does not defend against arbitrary malicious code running as the same OS account, administrator or root.
- Claude's durable store remains separate from OMP's active-profile `brain-trail/trail.sqlite`, which holds settings, costs and captured tool-call data. Captures may contain session content; workspace paths and layouts are cached too. Clearing the visible trail does not erase stored captures.
- OMP Coach reads the selected `AGENTS.md` or `CLAUDE.md` in the actual session working directory and runs a quiet turn with tools disabled. Apply fills the OMP editor; it does not send a prompt or write the file.

## Non-security issues

Use the repository's public issue tracker for ordinary bugs and feature requests that do not expose sensitive information. See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and contribution expectations.
