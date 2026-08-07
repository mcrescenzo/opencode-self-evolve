// Compile-only declaration for the one Node built-in used by the target.
// OpenTUI, Solid, JSX element, event, and renderable declarations intentionally
// resolve from the actual installed peers so this file cannot admit arbitrary
// intrinsic elements or properties.
declare module "node:timers/promises" {
  export function setTimeout(milliseconds: number): Promise<void>;
}
