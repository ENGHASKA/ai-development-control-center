# Configuration

`adcc config` prints installation metadata (paths, ports and detected binaries), not authentication material. Runtime configuration is generated under the private configuration directory. runtime.env contains worker settings; dashboard.env additionally contains the application password hash/signing secret. Do not commit either.

Source versions live under prefix/releases; prefix/current selects the active version. Workspace contains projects, worktrees, tasks, logs, reports and a private tmux directory. The installer uses the separate adcc-* unit namespace. It will not overwrite an unmanaged unit or command.

First-install options select prefix, workspace and base port; the app/PTY use base+1/base+2. Existing installations retain their original paths and ports during upgrade. systemd resource defaults cap the aggregate slice at 8 GiB/four CPU cores, task units at 2500 MiB/two cores/192 processes, with smaller service limits. Plan RAM for the OS and builds; these caps do not guarantee that no process can be OOM-killed.

Health reports warn on low disk; queue admissions pause below 1 GiB free disk or 512 MiB available RAM. Task logs cap streams near 5 MiB and age out after 14 days. Project files and native CLI histories are not disk-quota-managed. Monitor them separately. Do not run unlimited extra interactive agents outside the queue budget.

The installer sets ACC_ROOTS_FILE inside its own private configuration, ACC_UNIT_PREFIX=adcc-task@, and AGENT_U_WORKTREES inside its workspace. These avoid inheriting a different installation's folder approvals or unit namespace. Bubblewrap is mandatory for Auto Mode and is checked by installation and doctor; availability alone does not prove the host AppArmor profile permits execution.

V3 also sets ACC_POLICY_FILE and ACC_ROUTING_FILE in the installation's private config directory. Full Access defaults off. Access/account data and audit records stay under AGENT_U_HOME outside Git; provider credential directories are never copied into a release.
