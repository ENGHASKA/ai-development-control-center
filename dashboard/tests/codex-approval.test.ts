import { describe, expect, it } from "vitest";
import { parseApproval, parseClaudeApproval, parseCodexApproval } from "@/lib/codex-approval";

/* The real dialog, captured from Codex 0.166. */
const DIALOG = `• I'll create made.txt containing hi using the shell.

• Running printf 'hi' > made.txt

  Would you like to run the following command?

  Environment: local

  Reason: May I create made.txt containing hi? The filesystem is read-only, so this shell write requires
  approval.

  $ printf 'hi' > made.txt

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`printf 'hi' > made.txt\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`;

describe("parseCodexApproval", () => {
  it("reads the question, reason and command", () => {
    const a = parseCodexApproval(DIALOG)!;
    expect(a.question).toBe("Would you like to run the following command?");
    expect(a.detail).toBe("printf 'hi' > made.txt");
    expect(a.reason).toContain("filesystem is read-only");
    expect(a.reason).toContain("approval.");
  });
  it("gives different requests different ids, and the same one the same id", () => {
    expect(parseCodexApproval(DIALOG)!.id).toBe(parseCodexApproval(DIALOG)!.id);
    expect(parseCodexApproval(DIALOG.replaceAll("made.txt", "other.txt"))!.id).not.toBe(parseCodexApproval(DIALOG)!.id);
  });
  it("won't offer an answer unless Yes is the focused row, since Enter would pick something else", () => {
    expect(parseCodexApproval(DIALOG.replace("› 1. Yes", "  1. Yes").replace("  2. Yes", "› 2. Yes"))).toBeNull();
  });
  it("sees nothing on an ordinary screen, even one that mentions the words", () => {
    expect(parseCodexApproval("› Ask Codex to do anything\n")).toBeNull();
    expect(parseCodexApproval("I asked: Would you like to run the following command?\n")).toBeNull();
    expect(parseCodexApproval("")).toBeNull();
  });
  it("reads an old dialog as gone once the footer has scrolled off", () => {
    expect(parseCodexApproval(DIALOG.replace("Press enter to confirm or esc to cancel", ""))).toBeNull();
  });
});

/* The real dialog, captured from Claude Code in manual mode. */
const CLAUDE = `  Creating out.txt containing hi and verifying it

────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 Create out.txt containing hi and verify it
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 │ printf 'hi\\n' > /w/out.txt
 │ && cat /w/out.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
      /w from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
`;

describe("parseClaudeApproval", () => {
  it("reads the question, what it's for and the command, without the tip", () => {
    const a = parseApproval(CLAUDE)!;
    expect(a.agent).toBe("claude");
    expect(a.question).toBe("Do you want to proceed?");
    expect(a.reason).toBe("Bash command · Create out.txt containing hi and verify it");
    expect(a.detail).toBe("printf 'hi\\n' > /w/out.txt\n&& cat /w/out.txt");
  });

  it("gives nothing to answer unless Yes has focus, or after the dialog closed", () => {
    expect(parseClaudeApproval(CLAUDE.replace("❯ 1. Yes", "  1. Yes").replace("   4. No", " ❯ 4. No"))).toBeNull();
    expect(parseClaudeApproval(CLAUDE.replace(" Esc to cancel · Tab to amend", ""))).toBeNull();
  });

  it("names a different request differently", () => {
    expect(parseApproval(CLAUDE)!.id).not.toBe(parseApproval(CLAUDE.replace(/out\.txt/g, "other.txt"))!.id);
  });
});
