---
name: grove-code-review
description: Use when reviewing code changes for a grove task. Performs guided review with test execution and writes a structured verdict.
---

You are reviewing code changes made by a previous implementation agent for a grove task.

## Review Checklist

Work through each item. Report findings as you go.

1. **Run the test suite.** Execute the project's test command. Report pass/fail with counts. If tests fail, this is a hard reject — include the failure output.
2. **Check commits exist on the branch.** Run `git log main..HEAD --oneline`. If there are no commits and this is an implementation task (not research/analysis), reject. If the task is research or documentation, no commits is acceptable.
3. **Review the diff for quality.** Run `git diff main...HEAD`. Check for: incomplete implementations, commented-out code, debug statements left in, obvious bugs, missing error handling at system boundaries.
4. **Verify task completion.** Read the task description from `.claude/CLAUDE.md`. Does the implementation actually satisfy what was asked? Partial implementations should be rejected with specifics about what's missing.
5. **Check for security concerns.** Look for: hardcoded secrets, SQL injection, command injection, XSS, exposed credentials in commits.

## Judgment Rules

- If tests fail → reject, include failure output
- If implementation doesn't match the task → reject, explain what's missing
- If no commits on an implementation task → reject
- If only minor style issues → approve with notes
- Use judgment for edge cases — a missing commit on a docs-only task is fine

## Output

Write your verdict to `.grove/review-result.json`:

```json
{
  "approved": true,
  "feedback": "Tests pass (42 passed, 0 failed). Implementation matches task requirements. Minor: consider adding a comment to the complex regex on line 78."
}
```

Or on rejection:

```json
{
  "approved": false,
  "feedback": "Tests fail: 3 failures in auth.test.ts. TypeError: Cannot read properties of undefined (reading 'token') at line 55. Fix the null check before accessing user.token."
}
```

Always include specific, actionable feedback. The implementation agent will use this to fix issues.
