# Third-party notices

Our orchestration, installation and distribution code is MIT-licensed. It is not the original author of the upstream dashboard or its UI primitives.

| Component | Source / version | License / distribution |
| --- | --- | --- |
| agent-ui / agent-u | https://github.com/pragnyanramtha/agent-ui at 9b528f52ce2529f5239ec2b2ad8129be785f233e | MIT, © 2026 claude-ui contributors; source under dashboard/, original license retained |
| Beautiful UI adaptations | Upstream agent-ui LICENSE-beautiful-ui | MIT, © 2026 Shane Levine |
| Nerd Font Symbols | dashboard/public/fonts/ | MIT, © 2014 Ryan L McIntyre; full notice beside font and under licenses/ |
| npm packages | dashboard/pnpm-lock.yaml and generated dependency inventory | Each package retains its own license. Downloaded during installation; node_modules and compiled bundles are not release assets. |
| Claude Agent SDK | @anthropic-ai/claude-agent-sdk 0.3.289 | Anthropic terms; not MIT and not bundled in source release. Installed separately as a runtime dependency; review its license before installing. |
| Claude Code and OpenAI Codex CLIs | Detected locally or explicit version installation | Separate provider licenses, authentication, service terms and billing. CLI binaries and credentials are not bundled. |
| Node.js and pnpm | Installer-pinned releases | Separate upstream licenses; downloaded on the user's machine, not sublicensed as our code. |

The vendored source includes local policy/security patches and portable background-task UI extensions. Package lock integrity is retained. No claim of independent maintainer identity certification or legal certification is made. No third-party screenshots or branding assets were added. The accompanying notices satisfy the MIT inclusion condition; no additional NOTICE file is required by the source components reviewed here.
