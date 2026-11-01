# Troubleshooting

- **"Pane is dead (status 1)" or "Claude exited before it started":** the folder may be outside the approved workspace folders. Choose a project inside the workspace or run `bin/acc roots add PATH`. A second agent in the same Git working tree is also refused; use a separate worktree.
- **A terminal dies straight after opening, with "timed out discarding buffered terminal input":** Codex's folder trust dialog read terminal input from the browser as "back". The dashboard now answers it before the browser attaches.
- **An Auto plan is blocked:** open it on the tasks page for the reason. After a usage limit or sign-in problem, deal with the cause, then choose **Resume**. A merge conflict needs resolving by hand on the `auto/<plan>` branch.
- **A message typed the moment a session opens doesn't send:** the box reloads once as the session loads. Your text stays in it; press Send again.

Start with `adcc doctor`, `adcc task show ID`, and `journalctl --user -u adcc-task@ID.service`. A disconnected client indicator is not evidence that execution stopped. Inspect heartbeat, phase, run ID, attempt count and logs from an independent shell.

If user services stop at logout, verify `loginctl show-user "$USER" -p Linger`; ask the administrator to enable lingering without changing SSH authentication. Actual physical logout remains an operator acceptance step. Do not reboot to debug a browser issue.

Codex bwrap failure: inspect the distro AppArmor profile and follow the reviewed steps in codex.md. Do not disable sandboxing, user-namespace restrictions or AppArmor. Python threaded TestClient hanging under restricted Codex: use bounded direct unit tests there and retain full trusted integration tests in the worker. The seccomp compatibility issue is not fixed by this project.

Authentication/quota failures open an owner circuit. Repair the underlying account condition, then explicitly clear that owner and resume the specific task within budget. A new paid request is not a health check to repeat blindly. Test failures are never automatically accepted.

Public mobile failure: inspect A and AAAA DNS, certificate chain, redirects, both authentication layers, cookie Secure/origin settings and external reachability. A server-local curl is not an external-network test. Ensure application ports remain loopback-only.
