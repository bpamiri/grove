---
name: grove-security-audit
description: Use when performing security audits on a codebase. Covers dependency scanning, SAST, secrets detection, analysis, reporting, and remediation.
---

You are performing a security audit of a codebase as part of a grove pipeline. This skill covers four pipeline steps: **scan**, **analyze**, **report**, and **remediate**. Follow the instructions for your current step.

---

## Step: scan

Run a comprehensive security scan. Detect the project's language/package ecosystem and run the appropriate checks.

### 1. Dependency Audit

Detect the package manager and run the corresponding audit command:

| Ecosystem | Detection File | Audit Command |
|-----------|---------------|---------------|
| Node.js | `package.json` | `npm audit --json` or `yarn audit --json` |
| Python | `requirements.txt`, `pyproject.toml` | `pip-audit --format=json` or `safety check --json` |
| Go | `go.mod` | `govulncheck ./...` |
| Rust | `Cargo.toml` | `cargo audit --json` |
| Ruby | `Gemfile` | `bundle audit check --format=json` |
| Java/Kotlin | `pom.xml`, `build.gradle` | `mvn dependency-check:check` or `gradle dependencyCheckAnalyze` |

If the tool isn't installed, note it as a finding with severity `info` and move on. Do not fail the scan because a tool is missing.

### 2. Secrets Detection

Search the codebase for hardcoded secrets using pattern matching. Check for:

- **API keys**: patterns like `AKIA[0-9A-Z]{16}` (AWS), `sk-[a-zA-Z0-9]{48}` (OpenAI), `ghp_[a-zA-Z0-9]{36}` (GitHub PAT)
- **Private keys**: `-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`
- **Connection strings**: `postgres://`, `mysql://`, `mongodb://`, `redis://` with embedded credentials
- **Generic secrets**: variables named `password`, `secret`, `token`, `api_key`, `apikey`, `auth` assigned to string literals (not env vars or config lookups)
- **JWT tokens**: `eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]*`
- **High-entropy strings**: base64 or hex strings > 20 chars assigned to secret-looking variable names

Exclude from secrets detection:
- `.env.example`, `.env.sample` files (templates, not real secrets)
- Test fixtures and mock data directories
- Lock files (`package-lock.json`, `yarn.lock`, `Gemfile.lock`)
- Files matching `.gitignore` patterns

If `trufflehog` or `gitleaks` is available, run it as well and merge results.

### 3. SAST — Static Analysis (OWASP Top 10)

Scan source code for common vulnerability patterns:

| OWASP Category | What to Look For |
|----------------|-----------------|
| **A01 Broken Access Control** | Missing auth checks on routes/endpoints, IDOR patterns (user ID from request used directly in DB query) |
| **A02 Cryptographic Failures** | MD5/SHA1 for passwords, hardcoded salts, `Math.random()` for security, weak TLS configs |
| **A03 Injection** | String concatenation in SQL/shell/LDAP queries, unsanitized template literals in queries, use of shell commands with string interpolation instead of parameterized execution |
| **A04 Insecure Design** | Missing rate limiting, no CSRF tokens on state-changing endpoints, missing input validation |
| **A05 Security Misconfiguration** | Debug mode enabled, default credentials, overly permissive CORS (`*`), directory listing enabled |
| **A06 Vulnerable Components** | Flagged by dependency audit above |
| **A07 Auth Failures** | Weak password requirements, missing account lockout, session tokens in URLs, cookies missing httpOnly/secure flags |
| **A08 Data Integrity Failures** | Unsafe HTML injection (React dangerouslySetInnerHTML or equivalent), deserialization of untrusted data, missing integrity checks on downloads |
| **A09 Logging Failures** | Passwords/tokens logged in plaintext, no logging on auth events, PII in logs |
| **A10 SSRF** | User-controlled URLs passed to HTTP clients, DNS rebinding vectors |

### Output Format

Write findings to `.grove/security-scan.json`:

```json
{
  "scan_complete": true,
  "scanned_at": "2025-01-15T10:30:00Z",
  "project_type": "node",
  "tools_used": ["npm audit", "pattern matching"],
  "tools_unavailable": ["trufflehog"],
  "findings": [
    {
      "id": "SCAN-001",
      "category": "dependency",
      "severity": "high",
      "title": "Prototype pollution in lodash",
      "description": "lodash@4.17.15 has known prototype pollution vulnerability CVE-2020-8203",
      "file": "package.json",
      "line": null,
      "evidence": "\"lodash\": \"^4.17.15\"",
      "cve": "CVE-2020-8203",
      "cwe": "CWE-1321"
    },
    {
      "id": "SCAN-002",
      "category": "secret",
      "severity": "critical",
      "title": "Hardcoded AWS access key",
      "description": "AWS access key ID found in source code",
      "file": "src/config.ts",
      "line": 42,
      "evidence": "const AWS_KEY = \"AKIA...\" (redacted)",
      "cve": null,
      "cwe": "CWE-798"
    }
  ],
  "summary": {
    "total": 2,
    "critical": 1,
    "high": 1,
    "medium": 0,
    "low": 0,
    "info": 0
  }
}
```

---

## Step: analyze

Read `.grove/security-scan.json` and triage findings. You are read-only in this step — do not modify any source files.

### Triage Process

For each finding:

1. **Verify it exists** — check the file and line number. If the code has changed or the finding is stale, mark it `false_positive`.
2. **Check for false positives** using these heuristics:
   - Secrets in test/mock files → `false_positive` (unless they look like real production secrets)
   - Secrets that reference env vars or config lookups (e.g., `process.env.API_KEY`) → `false_positive`
   - Dependency vulnerabilities that don't affect the used API surface → `low` (downgrade from original severity)
   - SQL injection patterns in ORMs that auto-parameterize → `false_positive`
   - Shell command patterns using parameterized execution (e.g., `execFile` with argument arrays) → `false_positive`
3. **Cross-reference findings** — if a dependency vuln and a SAST finding point to the same root cause, link them.
4. **Classify remediation effort**: `trivial` (version bump), `simple` (code change < 10 lines), `moderate` (refactor needed), `complex` (architectural change).

### Output Format

Write to `.grove/security-analysis.json`:

```json
{
  "analysis_complete": true,
  "analyzed_at": "2025-01-15T10:35:00Z",
  "findings": [
    {
      "id": "SCAN-001",
      "original_severity": "high",
      "adjusted_severity": "high",
      "status": "confirmed",
      "false_positive": false,
      "reason": "lodash prototype pollution is exploitable via merge/set functions which are used in src/utils.ts",
      "remediation_effort": "trivial",
      "suggested_fix": "Upgrade lodash to >=4.17.21",
      "auto_fixable": true
    },
    {
      "id": "SCAN-002",
      "original_severity": "critical",
      "adjusted_severity": "critical",
      "status": "confirmed",
      "false_positive": false,
      "reason": "Real AWS access key in source code",
      "remediation_effort": "simple",
      "suggested_fix": "Move to environment variable, rotate the exposed key immediately",
      "auto_fixable": false
    }
  ],
  "summary": {
    "total_scanned": 2,
    "confirmed": 2,
    "false_positives": 0,
    "critical": 1,
    "high": 1,
    "medium": 0,
    "low": 0,
    "auto_fixable": 1
  }
}
```

---

## Step: report

Generate a human-readable security audit report from `.grove/security-analysis.json`.

Write to `.grove/security-report.md` using this structure:

```markdown
# Security Audit Report

**Project:** <project name>
**Date:** <date>
**Audited by:** Grove security-audit pipeline

## Executive Summary

<2-3 sentence overview: how many findings, what's the overall risk posture, are there any critical issues requiring immediate action?>

## Risk Rating

| Rating | Count |
|--------|-------|
| Critical | N |
| High | N |
| Medium | N |
| Low | N |
| Info | N |
| False Positives | N |

**Overall Risk:** <Critical / High / Medium / Low>

## Critical & High Findings

### [SCAN-XXX] <Title>

- **Severity:** Critical
- **Category:** <dependency / secret / sast>
- **File:** `<path>:<line>`
- **CWE:** <if applicable>
- **Description:** <what was found>
- **Impact:** <what could happen if exploited>
- **Remediation:** <specific fix steps>
- **Effort:** <trivial / simple / moderate / complex>

<repeat for each critical/high finding>

## Medium & Low Findings

<table format for brevity>

| ID | Severity | Category | File | Title | Fix |
|----|----------|----------|------|-------|-----|
| SCAN-XXX | Medium | sast | `file.ts:42` | Description | Suggested fix |

## False Positives

<brief list of dismissed findings with reasons, so the next auditor knows>

## Recommendations

1. **Immediate** — <actions for critical findings>
2. **Short-term** — <actions for high findings>
3. **Ongoing** — <process improvements, tooling suggestions>

## Scan Metadata

- Tools used: <list>
- Tools unavailable: <list>
- Files scanned: <count or scope>
```

---

## Step: remediate

Attempt automated fixes for findings marked `auto_fixable: true` in `.grove/security-analysis.json`. Only fix `trivial` and `simple` effort items.

### Rules

1. **Only fix low-risk items** — dependency upgrades, version pins, removing unused packages.
2. **Never fix** — hardcoded secrets (requires key rotation outside the codebase), architectural issues, anything marked `moderate` or `complex` effort.
3. **One commit per fix** — use conventional commit format: `fix: (security) upgrade lodash to 4.17.21 (CVE-2020-8203)`.
4. **Verify after each fix** — run the project's test suite if available. If tests break, revert the fix and note it.
5. **Update the report** — append a "Remediation Results" section to `.grove/security-report.md`.

### Output Format

Write to `.grove/security-remediation.json`:

```json
{
  "remediation_complete": true,
  "remediated_at": "2025-01-15T10:40:00Z",
  "fixes_attempted": 1,
  "fixes_applied": 1,
  "fixes_failed": 0,
  "fixes": [
    {
      "finding_id": "SCAN-001",
      "action": "Upgraded lodash from 4.17.15 to 4.17.21",
      "commit": "abc1234",
      "tests_passed": true,
      "reverted": false
    }
  ],
  "skipped": [
    {
      "finding_id": "SCAN-002",
      "reason": "Requires key rotation — cannot be auto-fixed"
    }
  ]
}
```
