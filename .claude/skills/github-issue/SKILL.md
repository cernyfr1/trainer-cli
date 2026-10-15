---
name: github-issue
description: Draft a GitHub issue together with the user, iterate on functionality and preferences until they approve it, then create it with gh. Use when the user wants to plan, write up or file an issue, feature request or bug for this repo.
---

# github-issue

Turn an idea into a well-scoped GitHub issue by iterating with the user. The issue is
the output — **do not write implementation code** while running this skill.

## 1. Preflight

Run, and stop on any failure:

```bash
gh auth status
gh repo view --json nameWithOwner -q .nameWithOwner
gh label list --limit 100
```

- `gh` missing → tell the user to run `brew install gh && gh auth login` (interactive, they must run it) and stop.
- Not logged in → `gh auth login`, stop.
- Remember the existing labels; only those may be used without asking.

## 2. Gather context

- Read what's relevant: `README.md`, `DESIGN.md`, the `src/` modules the idea touches, existing issues
  (`gh issue list --search "<keywords>" --state all`) to avoid duplicates.
- If the request depends on outside facts (APIs, libraries, prior art), research them and keep the source URLs.
- Reuse anything already decided earlier in the conversation — don't re-ask it.
- Summarize what you know in a few lines before asking anything.

## 3. Ask

Use AskUserQuestion with focused, multiple-choice questions (recommended option first). Cover, as needed:

- goal / problem being solved
- scope: what's in, what's explicitly out (or deferred to follow-ups)
- user-facing behavior: commands, flags, output, config keys
- preferences and constraints (dependencies, offline, auth, formats, compatibility)
- priority and labels

Every question should be able to change the draft — skip ones with an obvious default and note the default in the draft instead.

## 4. Draft

Write the body to `<scratchpad>/issue-<slug>.md` using this template:

```markdown
## Problem / Goal
<why; what the user can't do today>

## Proposed solution
<user-facing behavior first — example commands/output — then a short technical sketch
referencing existing modules/functions>

## Scope
**In**
- …
**Out / follow-ups**
- …

## Open questions
- …

## Acceptance criteria
- [ ] <testable item>
- [ ] …

## Research & links
- [title](url) — one-line takeaway
```

Show the user the proposed **title**, **labels**, and the full draft in chat.

## 5. Refine

Apply the user's feedback to the file and show the updated draft (or the changed sections).
Ask follow-up questions when feedback opens new decisions. Repeat until the user clearly says it's good —
never assume approval from silence or partial feedback.

## 6. Final confirmation

Show the exact command that will run, e.g.

```bash
gh issue create --title "<title>" --body-file <scratchpad>/issue-<slug>.md --label enhancement
```

Creating an issue is public/outward-facing: run it only after an explicit "yes". If a wanted label
doesn't exist, ask before creating it (`gh label create`).

## 7. Create

Run the command and report the issue URL. Don't commit, push, or start implementing.
