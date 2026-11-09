## Stenod

*"Stenod has been closed down intentionally because the project failed to do what it was meant to do. It will not be completed further, and this repository is kept for reference only."*

### What Stenod was meant to do

Stenod was a local daemon for AI-assisted coding sessions. It was meant to record file changes, terminal activity, and, where a tool allowed it, the reasoning behind an AI agent's changes. It would then compile that record into a handoff manifest that a developer could paste into any AI tool to resume work after an interruption, such as a rate limit, a provider outage, or a switch between tools. The design aimed to run independently of any AI tool, so the record would survive even when the AI was unavailable.

The planned second version added structured capture from coding agents such as Claude Code, Codex, Kiro, Google Antigravity, and Cursor. It would merge their reasoning into one graph and track each decision as settled, rejected, or open.

The package was published to npm as `steno-daemon`, and the command was `stenod`.

### What the testing found

Testing was done on Windows. A full-stack bookmark manager was built over 20 prompts while Stenod ran in the background. The `attach` command and the network capture tier were not tested, because they only work on Unix and Mac systems. The following findings show where Stenod did not meet its intended goals:

- Handoff manifests gave a new agent only bare filenames for file changes, with no summary of what had changed. A cold resume from the manifest carried no usable context about the project's most important file.
- Repeated saves to the same file never replaced earlier versions. One file accumulated 10 identical active records in a single session.
- The settled, rejected, and open scoreboard never produced entries from real code changes or from unresolved questions. The only content that appeared came from constraints added by hand with `stenod anchor`.
- The tool integrations for Claude Code, Codex, Kiro, Antigravity, and Cursor were never built. The commands `stenod integrate` and `stenod detach` do not exist in the CLI, although the documentation described them as available.
- The delta handoff `--new` was not built, and `--full` was missing as a flag.
- `stenod reject --since` removed every record in the time window, including the current version of a file that was still needed.
- `stenod status` counted rejected records, so its count did not match what the next handoff would contain.
- On Windows, the daemon stopped during a session without any warning, and its error log was empty. Capture stopped silently until someone noticed by hand.
- `stenod start` reported success without checking that the daemon had actually started.
- Dependency-change capture, the AI tie-breaker, and stale rule-file detection were documented but never implemented.
- The compiled package contained internal development comments, such as phase numbers and design references.
- The documentation described unbuilt features as if they were working.

### What worked

- Filesystem capture recorded file changes reliably throughout the test session.
- Secret files such as `.env` were excluded from capture, along with `node_modules` and files listed in `.gitignore`.
- `stenod init`, `stenod start`, `stenod stop`, and `stenod status` ran cleanly, apart from the issues listed above.
- Constraints added with `stenod anchor` appeared in the handoff with their full text.
- The automated tests for the first version were thorough, including real integration tests for the daemon lifecycle and the queueing logic.

### License

MIT © Nikhil Virdi. See [LICENSE](./LICENSE).
