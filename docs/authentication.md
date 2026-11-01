# Authentication

The application generates a unique high-entropy password and cookie signing secret under the private configuration directory. The password hash uses scrypt. Parent directories are mode 0700 and private files are mode 0600. Passwords are never printed by the installer. Use the local viewing command it provides, not a public dashboard log.

Application cookies are HttpOnly, SameSite=Strict and valid for 30 days; trusted HTTPS sets Secure. Logout clears the browser cookie; Sign out everywhere changes the server epoch to revoke prior sessions. Password/secret changes revoke sessions too. Login throttling, host checks and same-origin checks protect the application. No public signup exists.

Optional public ingress requires a second independent Basic Authentication password and trusted TLS. The edge password is separate from the application and each provider. MFA/passkeys are not included. Use a private authenticated gateway if you add one; do not weaken either configured layer.

Claude: `claude auth login` and `claude auth status`. Codex: `codex login` and `codex login status`. Use the detected installation-local binary path if absent from shell PATH. Never read/copy provider token files. Account expiry/quota failures block further jobs for that owner until inspected and explicitly unblocked.
