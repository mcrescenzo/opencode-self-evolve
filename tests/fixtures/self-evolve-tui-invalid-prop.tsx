/** @jsxImportSource @opentui/solid */

// This compile-only negative fixture must consume the installed OpenTUI JSX
// declarations. If an ambient wildcard starts accepting arbitrary properties,
// the now-unused expectation makes the canonical typecheck fail.
export const invalidIntrinsicProperty = (
  // @ts-expect-error deliberate unsupported BoxProps property
  <box selfEvolveInvalidProperty="must-be-rejected" />
)
