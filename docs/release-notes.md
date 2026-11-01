# Release notes — v3.0.0-beta.1

This is an initial **prerelease**, not a production-readiness certification.

Supported installation target: Ubuntu 24.04 LTS x86_64 with Python 3.12, Node 24 LTS and user systemd. Other systems are not verified. The release contains reviewed source, installer and SHA-256 checksums, not runtime credentials, provider binaries, node_modules, compiled server-action keys or original private operational history.

Historical private Ubuntu deployment evidence: actual Claude frontend work and Codex backend/unit-test work ran in isolated task worktrees, survived browser/dashboard/dispatcher disconnect/restart, passed independent tests and named review. A 66-second disconnect is not an overnight endurance test. These historical results do not replace fresh distribution-install tests or imply future CLI compatibility.

Current portable distribution validation is recorded in validation.md after the release candidate's actual CI/install/security gates complete. CI fixtures are explicitly not live-provider activity. No claim of verified host reboot continuation, physical SSH logout, public HTTPS provisioning on every hostname, untrusted multi-tenancy or off-host disaster recovery is made.

Known limitation: restricted Codex sandbox socket-pair send behavior can hang threaded Python TestClient. Full HTTP acceptance runs in the trusted executor; bounded direct unit tests run inside the agent. No global security or network restriction is disabled to conceal this issue.

Install from the versioned assets after checksum verification; upgrade only from a reviewed extracted release with no running jobs and a private backup. See updating.md and backup-restore.md. Release signatures/SLSA attestations are a roadmap item; SHA-256 consistency is not identity proof.

## v2 candidate integration

The v2 interface adds validated Auto Mode, approved project roots, deterministic routing, sandboxed plan tests, independent step worktrees and a separate integration branch. Persistent interactive sessions support real Claude/Codex conversation resumption, background follow-ups, explicit approvals/rejections and audit history. Runtime and plan tables migrate additively. Candidate integration imports final files as one sanitized squash; private development commits and local third-party skills are excluded.

Claude's handoff reports real provider resume/concurrency and Chromium/Firefox acceptance on isolated instances; those are inherited records, not new release validation claims. Fresh installation, security and CI results must be recorded separately in validation.md before publication. Physical SSH logout, host reboot, real quota exhaustion, WebKit system dependencies and physical phone testing remain unverified or blocked as reported.

## v3 candidate

Includes persistent provider TUIs, verified terminal input targeting, explicit access modes, trusted member accounts, revocable session grants/PINs, adapter capability discovery, scored routing, independent review and bounded repair. No new provider billing entitlement or untrusted multi-tenant isolation is implied. Full Access remains off by default and is not exercised by release CI.

Development handoff reports live-provider and adversarial HTTP acceptance. Those are inherited development results, not new tests by this release process. Release-local results belong in validation.md. SSH logout, host reboot, real quota exhaustion, physical devices and WebKit dependencies remain unvalidated or blocked as reported. A Codex model request can stall despite a surviving process.
