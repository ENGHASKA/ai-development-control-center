# First-run setup

1. Read the installer health output and run `adcc doctor`.
2. Open the private forwarding URL printed by the installer. View your dashboard password locally using the printed command. Never paste it into an issue or terminal session recorded by the dashboard.
3. Run the detected Claude/Codex CLI authentication flows in your own shell. `adcc config` records exact CLI paths when installed locally.
4. Configure Git identity inside each repository before an agent/executor attempts a commit.
5. Submit a small acceptance task and inspect its branch, tests and review state.
6. Only then prepare public HTTPS if desired. Test both logins and terminal reconnection from another network.

The application password and cookie secret are random per installation and retained across upgrades. An upgrade can invalidate old cookies because the password hash is regenerated with a new salt; sign in again. Provider billing and authentication remain independent.
