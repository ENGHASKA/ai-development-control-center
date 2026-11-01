# Getting started

Install on a disposable or dedicated Ubuntu 24.04 x86_64 VPS using the reviewed, checksummed source release. Use a normal sudo-capable account. The installer checks at least 4 GiB RAM and 4 GiB free disk; 8–12 GiB RAM and 20 GiB free disk are recommended for real two-agent development.

Start with private SSH-forwarded access. Log into the dashboard using your locally generated password, connect each provider with its official CLI, then onboard one trusted repository. Submit a small task with a meaningful test command. Inspect its logs and worktree before approving it. Do not start with an unattended production deployment.

The runtime command is `~/.local/bin/adcc`. Add that directory to PATH if required. `adcc doctor` reports service/CLI presence; it does not prove provider authentication or account quota. See [first-run setup](first-run.md).
