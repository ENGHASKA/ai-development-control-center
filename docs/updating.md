# Updating

Download and verify the new source release, read its notes and extract it to a separate directory. Back up project/state data privately. Finish or explicitly pause running tasks first; the upgrade command refuses running jobs.

Run `adcc upgrade /absolute/path/to/extracted/release`. The new installer copies source to a fresh version directory, installs frozen dependencies, builds before stopping existing services, switches current, regenerates managed units, and checks health. On an installation exception for an existing install, it restores prior config/current and restarts old units. Keep the previous version until you inspect the result. This rollback does not undo database schema/data changes; beta schema changes must be reviewed and backups retained.

Credentials are preserved; old browser cookies may need a new login after password-hash regeneration. Provider credential stores are never overwritten. The prerelease CI tests upgrading the same source as a lifecycle rehearsal; that is not evidence of future cross-version schema compatibility.

Uninstall removes managed user units and wrapper, but retains workspace, credentials, release directories, backups and optional privileged HTTPS. Review those separately before deletion. It never deletes projects or edits unrelated services.
