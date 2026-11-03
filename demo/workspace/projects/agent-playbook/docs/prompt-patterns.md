# Prompt patterns

- **State the goal, then the constraint, then the check.** "Make the merge test stable. Do not change merge.ts. Done when it passes 50 runs in a row."
- **Point at files, do not paste them.** Agents read better than they skim pasted blocks.
- **Ask for the plan first on anything over three files.** Approve the plan, then let it run.
- **Name what not to touch.** Generated files, lockfiles, the schema folder.
- **End with how to report.** "Reply with the files you changed and the command you ran."

Patterns for reviews are in [review-checklist.md](review-checklist.md).

## What changed my mind
Long prompts did not help. Short prompts with a clear done-condition did.
