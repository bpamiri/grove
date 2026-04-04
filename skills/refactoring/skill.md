---
name: grove-refactoring
description: Use during refactoring tasks — guides analysis of code smells, planning safe transformations, and verifying behavior preservation.
---

You are performing a code refactoring task. Your goal is to improve code structure without changing behavior.

## Refactoring Principles

1. **Behavior preservation is non-negotiable.** Every refactoring must produce identical observable behavior. If you're unsure, don't change it.
2. **Atomic commits.** Each logical refactoring gets its own commit. Never mix multiple refactorings in one commit.
3. **Tests first.** Before refactoring, ensure tests exist for the code you're changing. If they don't, write them first in a separate commit.
4. **Measure improvement.** Track concrete metrics (file length, function count, duplication, nesting depth) before and after.

## Code Smell Detection

When analyzing code, look for these patterns:

### High Priority
- **Long functions** (>50 lines) — Extract into smaller, named functions
- **Duplicated logic** — Find 3+ similar blocks and extract a shared abstraction
- **Deep nesting** (>3 levels) — Use early returns, guard clauses, or extract helpers
- **God objects/files** (>500 lines) — Split by responsibility into separate modules
- **Feature envy** — A function that uses more of another module's data than its own

### Medium Priority
- **Long parameter lists** (>4 params) — Group into an options/config object
- **Switch/if chains on type** — Replace with polymorphism or a dispatch map
- **Primitive obsession** — Raw strings/numbers where a domain type would add clarity
- **Dead code** — Unreachable branches, unused exports, commented-out blocks

### Lower Priority
- **Inconsistent naming** — Align with project conventions
- **Magic numbers/strings** — Extract to named constants
- **Temporal coupling** — Functions that must be called in a specific order

## Analysis Output Format

Write `.grove/refactor-analysis.json`:

```json
{
  "summary": "Brief overview of findings",
  "metrics": {
    "files_analyzed": 42,
    "total_issues": 12,
    "by_severity": { "high": 3, "medium": 5, "low": 4 }
  },
  "targets": [
    {
      "file": "src/engine/processor.ts",
      "line": 45,
      "issue": "long-function",
      "severity": "high",
      "description": "processTask() is 120 lines with 4 levels of nesting",
      "suggestion": "Extract validation, transformation, and persistence into separate functions"
    }
  ]
}
```

## Refactoring Plan Format

Write `.grove/refactor-plan.md` with this structure:

```markdown
# Refactoring Plan

## Baseline Metrics
- Files: X, Total lines: Y, Average function length: Z
- Test coverage: N tests, all passing

## Changes

### 1. [Title] — [file(s)]
- **Before:** Description of current state
- **After:** Description of target state
- **Risk:** Low/Medium/High — why
- **Test strategy:** How to verify behavior is preserved

### 2. ...

## Execution Order
Ordered list of changes, with dependencies noted.
```

## Safe Transformation Patterns

### Extract Function
1. Identify the code block to extract
2. Determine inputs (parameters) and outputs (return value)
3. Create the new function with a descriptive name
4. Replace the original block with a call to the new function
5. Run tests

### Move to Module
1. Identify code that belongs in a different module
2. Create or identify the target module
3. Move the code, updating imports in both source and all consumers
4. Run tests

### Replace Conditional with Polymorphism
1. Identify repeated type-checking conditionals
2. Define an interface for the shared behavior
3. Create implementations for each type
4. Replace conditionals with interface calls
5. Run tests

### Simplify Conditional
1. Identify complex boolean expressions or deep nesting
2. Extract conditions into named boolean variables
3. Use early returns to reduce nesting
4. Run tests

## Verification Checklist

After refactoring, verify:
- [ ] All existing tests pass with no modifications
- [ ] No public API signatures changed (unless intentional and documented)
- [ ] No new dependencies introduced
- [ ] File sizes decreased or stayed the same
- [ ] Function lengths decreased
- [ ] Nesting depth decreased
- [ ] No commented-out code left behind

Write verification results to `.grove/verify-result.json`:
```json
{
  "tests_passed": true,
  "baseline_comparison": "All 42 tests pass, matching pre-refactoring baseline",
  "metrics_improved": true,
  "details": {
    "files_changed": 3,
    "lines_before": 450,
    "lines_after": 380,
    "functions_extracted": 5,
    "max_nesting_before": 5,
    "max_nesting_after": 2
  }
}
```
