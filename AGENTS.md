# Contributor instructions

This is administrative infrastructure. Never add credentials, task state or private deployment data. Keep all servers loopback-bound; HTTPS and authentication are required before public ingress. Preserve upstream attribution under dashboard/ and licenses/. Run Python tests and dashboard typecheck/test/build after relevant changes. Do not run live providers in CI or grant permission bypasses. Treat installer and lifecycle mutations as security-sensitive.
