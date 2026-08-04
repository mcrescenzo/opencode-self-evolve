// Compile-only declarations for optional TUI peers intentionally omitted from
// this server-first checkout. Packed consumer lanes load the real exact peers.
declare module "solid-js" {
  export function createMemo<Value>(compute: () => Value): () => Value;
  export function createSignal<Value>(value: Value): [
    get: () => Value,
    set: (next: Value | ((prior: Value) => Value)) => Value,
  ];
  export function onCleanup(callback: () => void): void;
  export function onMount(callback: () => void): void;
  export function Show(props: {
    when: unknown;
    children?: unknown;
  }): unknown;
}

declare module "node:timers/promises" {
  export function setTimeout(milliseconds: number): Promise<void>;
}

declare module "@opentui/core" {
  export interface KeyEvent {
    name: string;
    preventDefault(): void;
  }
  export interface Renderable {
    focus(): void;
  }
}

declare module "@opentui/solid/jsx-runtime" {
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown;
  export const Fragment: unknown;
  export namespace JSX {
    interface IntrinsicElements {
      [name: string]: Record<string, unknown>;
    }
    type Element = unknown;
  }
}
