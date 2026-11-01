# Access modes, team accounts and session PINs

## Access modes

There are separate kinds of approval, and each mode only changes the first.

| Kind | Comes from | Changed by |
|---|---|---|
| Tool approvals | The agent's CLI | The access mode |
| Agent sandbox | Codex's sandbox | The access mode |
| Workspace boundary | The dashboard | `acc roots`, at a shell |
| Merge gate | The dashboard | Nothing; a person always merges |

| Mode | Claude Code | Codex |
|---|---|---|
| Read only | `--permission-mode plan` | `-a never -s read-only` |
| Ask before acting | `--permission-mode manual` | `-a on-request -s read-only` |
| Accept edits | `--permission-mode acceptEdits` | `-a on-request -s workspace-write` |
| Full access | `--permission-mode bypassPermissions` | `-a never -s danger-full-access` |

Each mode names its flags so the session does what the label says. Claude's own default is not used: it follows the account's configuration, which can be `auto`, and then nothing is asked at all. There is no separate "provider default" mode for the same reason: it couldn't say what the agent may do.

Claude's and Codex's approval prompts appear as a card in the conversation, read from the agent's real dialog, with Approve once, Reject and Open terminal. An answer is refused if a different request has taken its place, and each is recorded in the audit log. Anything else on the dialog, such as "always allow", stays in the terminal. Someone with View access can see the card but not answer it.

**Why Accept edits still shows Allow prompts:** it covers file edits only. Claude Code still asks before running commands. That prompt comes from the CLI, not from the dashboard.

Full access is off until an administrator turns it on under Team and sharing, acknowledging the risk, or runs `acc policy full-access on` at a shell. Both are the same setting, and the website's change goes in the audit log. While it's off an administrator sees how to turn it on. Team members never see it: the server refuses it for them whatever a client sends, and a PIN or Interact grant only lets them watch a session running under it. Each selection asks for confirmation. A running agent keeps the flags it started with, so changing mode shows Restart session, and the composer shows the mode from the process's real flags. It means no prompts and no agent sandbox, as this server's user. It doesn't mean root, and a session can still only start in an approved folder. Once running, though, the agent can reach anything this user can, including outside that folder: testing confirmed it.

## Conversations outlive the browser

Claude and Codex conversations run in their own interface in a kept terminal, owned by the terminal service rather than the dashboard. Closing a browser or restarting the dashboard doesn't touch a running turn, and returning opens the same conversation. A message sent while the agent is busy is queued until the turn finishes.

If a terminal has closed, sending a message resumes the same saved conversation. It never starts a new one, and a message that couldn't be delivered stays in the conversation to retry.

## Team accounts

The original password is the admin. Add members under **Team and sharing**. Members sign in with a name and password, and can use conversations they own or are given. Everything else is refused by default: terminals, files, Git, tasks, plans, settings changes and account management. With no members, nothing changes.

Sessions from before accounts existed belong to the admin and stay private.

## Sharing a conversation

| Setting | Who can open it |
|---|---|
| Private | The owner |
| PIN protected | Members who enter the PIN |
| Trusted members | Trusted members directly; others with the PIN |
| PIN for everyone | Everyone with the PIN, including the owner |

Each member gets View only, Interact or Manage. A PIN gives View or Interact, as the owner chooses, and never Manage. Unlocks last 30 minutes, and changing the PIN or membership ends them at once. Revoking access ends an open conversation stream within seconds.

PINs are 4 to 6 digits, stored as scrypt hashes, and never sent to the browser. After four wrong guesses, the wait doubles each time up to an hour, counted per person, per session and per source. Other people's wrong guesses can't lock out the owner. If a PIN is forgotten, the admin can recover the session, which removes the PIN and makes it private. Failed attempts and changes are recorded in `access-audit.jsonl`.

## What this does not protect against

**This is access control inside one application, not separation between Unix users.** Agents and the terminal all run as one server account, so:

- Anyone with SSH or a web terminal as that account can read every session's files.
- An agent started by a member can do whatever that account can, within its access mode. In Read only and Codex's sandbox that's limited; a Claude session that a member can approve commands in is not.
- The admin account can read any transcript through files or the terminal, even where the dashboard refuses a private session.

Give member accounts only to people you'd trust with that server account. Real separation between untrusted people needs separate Unix users or containers, which this doesn't provide.
