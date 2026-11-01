# Security model

This beta supports a trusted single administrator. It can execute code as that UID. Browser terminals, repository hooks and explicit test commands have normal account permissions. File-root checks, advisory leases and resource limits are not a hostile-code sandbox. Workspace-write also permits ordinary same-UID reads outside the tree. Use a dedicated account and never onboard untrusted repositories or users.

All application listeners bind IPv4 loopback. Public access requires reviewed Caddy trusted HTTPS plus independent Basic Authentication and application login; automatic TLS renewal is Caddy's responsibility. Forwarding headers are normalized, request size capped and security headers set. The application uses signed HttpOnly/SameSite cookies, host/origin checks, login throttling and session epoch revocation. Caddy's stock build adds no edge rate-limit plugin; MFA is not included.

The installer creates private files outside source control. Worker child environments drop inherited cloud keys, SSH agent sockets and application secrets. Common output credential patterns are redacted, but arbitrary secrets cannot be reliably detected; never ask an agent to read them. Same-UID processes can still access that UID's files. Provider credential stores are never exported by this project.

Supply chain: retained upstream source/licenses, exact lockfile integrity, explicit CLI/tool versions, checksum-verified Node and scanner downloads, SHA-pinned CI actions, read-only workflow permissions, no paid provider keys on pull requests. npm install/build can execute approved upstream build scripts; review lockfile changes. Claude SDK and provider CLIs are separate proprietary/service dependencies and are not bundled in our source archive.

No release is published when critical vulnerabilities or real committed secret exposures remain unresolved. Report suspected vulnerabilities through SECURITY.md. Secret scanning is evidence, not proof of absence. Rotate any credential actually exposed before release.

## v3 access controls

Member accounts are denied administrative routes by default and receive only session-scoped rights. Revocation ends streams; PIN unlocks are versioned and expire. These controls do not provide OS-user separation. All members must remain trusted with the underlying server-account risk.

Full Access is an administrator opt-in, disabled by default, with explicit confirmation and audit. It removes the agent sandbox. Release tests must not use it to bypass sandbox failures. Managed installs set private, installation-specific ACC_POLICY_FILE and ACC_ROUTING_FILE paths; an unrelated installation's policy is not inherited.
