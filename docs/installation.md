# Installation

Download install.sh, the versioned source archive and SHA256SUMS from the beta release. Verify checksums and inspect the installer before executing `bash install.sh --install-system-deps`. The shell entrypoint also verifies the local archive before extracting it with Python's data filter. No remote script is piped to a shell.

`--install-system-deps` installs maintained Ubuntu packages and enables the existing account's user manager lingering using sudo. Node 24 is reused when available; otherwise the installer downloads pinned Node 24.22.2 and checks it against Node's official SHA256SUMS. pnpm 11.17.0 and missing provider CLIs are installed locally at explicit versions. Dashboard dependencies use the committed frozen lockfile. The SDK/CLIs are downloaded under their own license terms, not bundled in our archive.

Options: `--prefix /path/to/application`, `--workspace /separate/path/to/state`, `--port 3430`, `--skip-agents`, `--configure-only`. The last option deliberately does not build/start/test services and is not a successful installation acceptance. The installer refuses a nonempty unmanaged prefix and occupied application ports on first installation. It never edits firewall or SSH settings.

If installation fails before completion, inspect the reported error and private staged files. A marked partial prefix can be retried. Existing installations use the upgrade transaction; running jobs prevent upgrades. Privileged sandbox profile setup and public HTTPS are separate reviewed actions. See [Codex](codex.md) and [public HTTPS](public-https.md).
