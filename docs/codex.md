# OpenAI Codex integration

Codex uses its supported CLI login independently from Claude. Background execution uses `exec --json` through the managed launcher with workspace-write sandboxing and approval_policy=never. That policy denies elevation requests; it is not an automatic permission approval. The worktree lease and dedicated task cgroup remain active through independent tests.

On Ubuntu 24.04, AppArmor can block Bubblewrap user namespaces even when the CLI is authenticated. Install Ubuntu's bubblewrap/apparmor-profiles packages. A root administrator must review `/usr/share/apparmor/extra-profiles/bwrap-userns-restrict`, install that distro profile into `/etc/apparmor.d/` if absent, and load it with apparmor_parser. Do not overwrite an existing custom profile or disable AppArmor/sysctl restrictions. Then test `codex sandbox` and a real supervised task; direct CLI success alone is insufficient.

Example reviewed administrator procedure (inspect existing policy first):

```bash
sudo apt-get install --no-install-recommends bubblewrap apparmor-profiles
sudo test ! -e /etc/apparmor.d/bwrap-userns-restrict
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

Stop if the test shows an existing profile; inspect it rather than continuing blindly. No setuid helper, global namespace relaxation, or network bypass is required. The private deployment verified capability-free AppArmor-stacked child execution and denied writes outside its worktree.

Known compatibility issue: restricted socket-pair send calls can hang Python threaded TestClient/asyncio wakeups. Keep bounded direct unit tests inside Codex and full integration tests in the explicit trusted worker argv. Do not advertise that compatibility issue as fixed. Git metadata writes remain restricted; explicit-path checkpoint commits are made by the trusted executor after tests.
