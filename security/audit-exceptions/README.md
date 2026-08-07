# Dependency Audit Exceptions

`npm run audit:dependencies` passes only when `bun audit --json` has no findings or every recognized, lockfile-applicable finding has a current owner-authored exception named `<GHSA>.json` in this directory.

Agents and automation must not author or renew exceptions. The repository owner must review the upstream advisory, exact locked path, package applicability, and available remediation before creating one. Each JSON record is bounded and must contain exactly:

```json
{
  "advisoryUrl": "https://github.com/advisories/GHSA-...",
  "package": "package-name",
  "installedVersion": "1.2.3",
  "dependencyPaths": ["root > direct@1.0.0 > package-name@1.2.3"],
  "applicability": "the exact applicability identifier enforced by the gate",
  "scope": "The narrowly reviewed use and trust boundary covered by this acceptance.",
  "owner": "The accountable repository owner",
  "reviewDate": "YYYY-MM-DD",
  "expiresOn": "YYYY-MM-DD"
}
```

The gate rejects unknown advisories, changed advisory metadata, changed lock paths, malformed or extra fields, path mismatches, unsupported version ranges, expired records, and records whose review date follows expiry. Changes in any of those inputs require a fresh code review; they cannot silently inherit an old acceptance.
