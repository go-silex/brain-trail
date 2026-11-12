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

## Oh My Pi dashboard boundaries

- The dashboard listens on `127.0.0.1` on a random port, under a per-process token URL. It requires the exact Host and, for POST requests, Origin; request bodies are bounded. It does not enable CORS and sends `Referrer-Policy: no-referrer`. Treat the token URL as sensitive.
- Brain Trail stores settings, costs and captured tool-call data in `brain-trail/trail.sqlite` under the active agent profile, not in the host's authentication database. Captured inputs and results may contain session content; workspace paths and layouts are also cached in that directory. Clearing the trail resets the visible trail but does not erase the stored captures. The 3D view retains its original public CDN dependencies for Three.js and fonts.
- Coach reads the selected `AGENTS.md` or `CLAUDE.md` in the actual session working directory and runs a quiet turn with tools disabled. The patch is held by the server. Apply fills the OMP editor only; it does not send a prompt or write the file.
- On Linux, protected reads use an opened regular-file handle, check its post-open identity and confinement through `/proc/self/fd`, and read a bounded amount. Protected reads are explicitly unsupported on non-Linux systems. Historical paths do not automatically grant authority: an outside preview and every external-app launch require fresh confirmation in the actual OMP TUI; outside preview is refused headlessly.
- A 3D-to-dashboard handoff may carry a generation and file path; the dashboard immediately removes these one-shot parameters. It opens only an exact indexed path once facts and the matching layout are ready for the current generation, through the same protected file-opening flow. Stale generations are refused. The URL cannot override the app or outside-path flag and grants no file authority.
- After confirmation, handing a path to an external application uses ordinary pathname reopen semantics. This is not an atomic handoff or a sandbox guarantee.

## Non-security issues

Use the repository's public issue tracker for ordinary bugs and feature requests that do not expose sensitive information. See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and contribution expectations.
