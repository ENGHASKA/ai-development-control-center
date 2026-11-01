# Security policy

This beta is an administrative application capable of executing code. Only trusted single-operator installations are supported. Do not give untrusted users access or treat the browser terminal as a container boundary.

Report vulnerabilities privately using GitHub's **Report a vulnerability** feature on this repository when enabled. Do not put credentials, sensitive logs or working exploit targets in public issues. If that private channel is unavailable, open a minimal public issue requesting a private contact, without exploit details. No response-time or bounty promise is made.

Only the latest beta is maintained. Review [the security model](docs/security.md), keep the operating system patched, and monitor dependencies. Known limitations, including Python sandbox wakeups and unverified host-reboot continuation, are public in the release notes. Never disable AppArmor or use permission-bypass flags to clear a failing test.
