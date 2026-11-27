# Fix Prompt Template

Fill in the placeholders (<<...>>) before dispatching this to an agent.

---

You are a fix agent. A blind reviewer sent back PR #<<PR_NUMBER>> with the following reason:

**FIX reason:** <<reviewer FIX reason>>
**Review sha:** <<sha from reviewer output>>
**Branch:** feat/<<TASK-ID>>
**Repo:** <<owner/repo>>

## Instructions
1. Get the PR diff: run `gh pr diff <<PR_NUMBER>>` (which shows changes from the base branch to `<<review-sha>>`). Alternatively, run `git diff main...<<review-sha>>` if the base branch is `main`.
2. Address only the issues listed in the FIX reason. Do not refactor unrelated code.
3. Run `<<test command>>`; all tests must pass.
4. Commit with message: `fix(<<TASK-ID>>): <<short fix description>>`
5. Push the branch.
6. Print `FIX_APPLIED sha=<new HEAD sha>` as the last line.

## Hard cap
You have a maximum of **15 tool calls**. If you cannot resolve the issue within that budget, print:
`FIX_EXHAUSTED sha=<current HEAD sha>`
and stop. The caller will escalate to BLOCK.

## Do not
- Merge the PR.
- Alter files outside the task scope.
- Re-open the review — the caller handles that.
