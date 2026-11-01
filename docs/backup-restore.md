# Backup and restore

Run `adcc backup /secure/location/backup.tar.gz`. It takes a consistent SQLite snapshot and archives projects, worktrees, attempt logs, reports and task/checkpoint/handoff files. It excludes application configuration and provider credential stores. Project repositories themselves may contain private data; keep archives mode 0600 and encrypt off-host copies. Backups are not public release artifacts.

The SQLite snapshot is consistent, but live project files can change while the tar stream is built. Pause tasks for a coherent project backup. There is no automatic scheduled/off-host backup in this distribution; arrange one under your own retention/encryption policy.

`adcc restore archive.tar.gz --to /empty/staging/path` uses Python data-filter extraction and checks SQLite integrity. It refuses a nonempty destination and never overwrites live state. Archive path/symlink escapes are rejected by the extraction filter. Restored worktrees and task specs contain absolute original paths; inspect them and restore to the original workspace location under a reviewed maintenance procedure before activation. Do not blindly point live services at staging.

Credentials must be reprovisioned separately using supported provider login and private application setup. Host-reboot and off-host disaster recovery are not certified by a successful local staging restore.
