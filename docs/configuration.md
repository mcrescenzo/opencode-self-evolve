# Configuration Reference

`self-evolve` can be registered as a tuple with an options object:

```json
{
  "plugin": [
    [
      "@mcrescenzo/opencode-self-evolve",
      {
        "maxAnalyzerRuns": 4,
        "maxProposals": 2,
        "minConfidence": 0.8
      }
    ]
  ]
}
```

The README covers the two or three options most people tune (`minConfidence`, `maxProposals`,
`minIntervalMs`). This page is the full reference for all eleven.

| Option | Default | Meaning |
|---|---|---|
| `minIntervalMs` | `600000` (10 minutes) | Cooldown recorded after a scan result before another scan is allowed. |
| `maxAnalyzerRuns` | `8` | Maximum analyzer runs per session. |
| `maxProposals` | `3` | Maximum accepted proposals per session. |
| `maxAnalyzerFailures` | `3` | Disables the session after this many repeated counted analyzer failures. |
| `messageLimit` | `120` | Recent messages considered for transcript construction. |
| `transcriptMaxChars` | `30000` | Maximum transcript characters sent to the analyzer. |
| `messageMaxChars` | `2000` | Maximum characters retained from each message. |
| `minConfidence` | `0.72` | Minimum proposal confidence accepted by validation. |
| `analyzerTimeoutMs` | `120000` | Timeout for the analyzer prompt call. |
| `sdkTimeoutMs` | `15000` | Timeout for SDK reads and analyzer-session creation. |
| `cleanupTimeoutMs` | `5000` | Timeout for best-effort analyzer-session cleanup. |
| `deliveryTimeoutMs` | `5000` | Timeout for optional TUI toast delivery. |
| `maxRegistrySessions` | `200` | Lazy cap for inactive per-session states kept in memory. |

See the [README](../README.md) for installation and the most commonly tuned options, and
[docs/internals.md](internals.md) for how these values are used at runtime.
