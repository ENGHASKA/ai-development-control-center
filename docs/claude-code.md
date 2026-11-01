# Claude Code integration

The installer reuses a detected CLI or installs the pinned Claude Code package locally. Authenticate using `claude auth login`; check status through the supported command. Your provider terms, subscription and usage limits apply. The application also depends on the separately installed Anthropic Agent SDK for upstream interactive functionality; it is not included under our MIT license.

Persistent background jobs run Claude in supported print/stream-JSON mode with the installed tested CLI's restricted file tools: Read, Write, Edit, Glob and Grep. Strict empty MCP configuration excludes unrelated tools. Background Claude cannot run arbitrary shell commands; the trusted executor runs the explicit acceptance argv independently. This is intentional, and command-heavy tasks may need a different reviewed assignment.

Worktree leases prevent another managed agent from editing the same tree. Native interactive tmux sessions use a separate private tmux directory. Do not restart adcc-tmux during active interactive sessions. Background task units do not depend on tmux.

A detected but incompatible future CLI must be tested before unattended use. Do not remove restrictions or enable permission bypass to work around failures.
