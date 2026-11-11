# Brain Trail

A pane beside the chat in the Claude Code desktop app. It shows what the session puts in front of the model, so you can see why Claude answers the way it does and when its context starts to work against you.

Made by Unkillable Companies. MIT license.

## Install

In a terminal, one line (Claude Code 2.1.275 or later):

```bash
claude plugin install brain-trail-v2 --marketplace go-silex/brain-trail
```

Answer `y` to add the marketplace, then Enter for your user scope. Open a new session in the desktop app: the pane opens by itself, whatever the folder (a code project, an Obsidian vault, a client folder). After closing it, type `/brain-trail-v2`.

Without a terminal, in the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `go-silex/brain-trail`, then Add plugin.

Update: `claude plugin update brain-trail-v2`.

## The tabs

- **Map**: the session's folder as one disc (one circle per folder, one dot per file). Every file that entered the context lights up in its colour: blue read, amber written, violet seen in a result (a search, a listing, a connector, a sub-agent's report), teal seen through a link of a note Claude read. Claude's path from file to file is drawn as arcs, dashed red where two notes have no link, and the outside services it calls (MCP) appear with their logo. The legend under the map counts each colour; a press lists the files. Follow Claude, replay the session step by step, zoom with the wheel or the buttons. A 3D button turns the map into a brain that spins in the pane; « Full screen » opens a WebGL version in the browser.
- **Which folder**: the session's own. Inside an Obsidian vault (a folder with `.obsidian` above it), the whole vault. In the home folder, its first three levels only.
- **Goal**: the current request, Claude's plan, and the history per request in plain words.
- **Context**: how full the context window is, with the advice that goes with it (keep going, compact, or start a new session), the plan use (5 h and week) and the session cost. Details: what is loaded before the first message and the tool results that take the most room.
- **Files**: figures (loaded at start, read, written, seen in a search, read by a sub-agent, missing links). Click a figure to list its files. Then the files as a tree of their folders.
- **Coach**: tips about how the session is going, in business words. « Apply » fills the prompt box.

The pane never writes in your files (only in its own folder `~/.claude/brain-trail-v2`). English and French.

## How it measures

- The gauge is the engine's own figure, the one the status line shows. Right after a compaction it shows the `/context` estimate, marked ≈.
- The breakdown at start is the one `/context` prints, estimated locally (no API call).
- The weight of a tool result is estimated from its length (about 3.6 characters per token).

## Tests

```bash
claude plugin test <path to this folder>
```
