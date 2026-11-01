# Contributing

Please read SECURITY.md and AGENTS.md first. Open an issue to discuss substantial changes. Use one branch/worktree per agent; never share a working tree between active agents. Keep changes small and include actual acceptance evidence.

Ubuntu 24.04 x86_64, Python 3.12 and Node 24 LTS are the development baseline. Run `python3 -m unittest discover -s tests -v`. In dashboard/, run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test --maxWorkers=2`, `pnpm build`, and `pnpm audit --prod`. Treat offline fixtures as fixtures; real provider checks require explicit operator authorization and must never run on untrusted pull requests.

Preserve third-party license notices. Do not add provider credentials, environment files, private logs, task databases, or deployment-specific server details. Source archives are built only from tracked files. Installer, authentication, public ingress and task recovery changes need security review and an installation test in a disposable Ubuntu environment. Submissions are provided under this project's MIT license; do not submit code you lack permission to license.
