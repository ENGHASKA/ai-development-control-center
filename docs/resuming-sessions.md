# Resuming sessions and working with background tasks

## Resume an existing conversation

Choose **Resume session**, pick your agent, then choose a saved session or paste its ID. The server checks that the saved conversation exists, finds its folder, and confirms that folder is approved and that nothing else has the conversation open. If any check fails, it says why. It never starts a new conversation in its place.

| | Open in terminal | Continue in background |
|---|---|---|
| Runs | The agent's own interface, in a kept terminal | One turn at a time, supervised by the server |
| You can | Answer prompts live | Send a message between turns |
| Survives closing the browser | Yes | Yes |
| Needs | An approved folder | An approved Git repository |

Both continue the provider's original conversation, using `claude --resume` or `codex resume`. Background turns work in the conversation's own folder rather than a copy, because the conversation belongs to that folder: Claude can only resume from there, and its file paths refer to it. While one runs, nothing else can work in that folder.

If a conversation is open elsewhere, such as in an SSH session, close it first. Two copies writing to one conversation can corrupt it.

If its folder isn't approved, the dashboard shows the command to approve it. Approval happens at a shell on purpose. A conversation doesn't carry permission to work in its folder.

## Background tasks

Open a task on the tasks page to see its output, copy it, and act on it.

| Control | What it does |
|---|---|
| Send a message | Continues the same conversation. During a running turn the message waits, because background turns take one prompt at a time |
| Approve, Reject | Decide a task waiting for you. Everything decided is kept in the audit log, shown under History |
| Pause, Resume | Pause stops the current turn; Resume continues from the saved session |
| Cancel | Stops the task and keeps its work |
| Finish | Closes a conversation waiting for a message |

**Ask before editing** (Claude only) runs the task without its writing tools. When it needs them it stops and asks; approving continues the same session with edits allowed. **Wait for my approval before starting** holds any task until you approve it.

### What background turns can't do

- Neither CLI accepts new input during a print-mode turn, so messages wait for the turn to end.
- Codex's background mode has no approval requests: it runs in its sandbox and stops if blocked. Use a terminal to answer Codex live.
- Claude's denial is only reported at the end of a turn, so approval reruns from that point, not mid-action.

## Projects and tasks

A task starts from the project you've chosen. It's refused, with the reason, if the folder isn't a Git repository, has no commits, can't be read, or holds no files. To start from nothing on purpose, confirm it in the form. If a prompt names a project in a different folder, that folder is used instead, once the server approves it.
