"use client";

// Tiny JSON-spec → React renderer. Walks a `{ root, elements }` spec and maps
// each element's `type` string to a component in a Registry. Element props
// containing `{ $bindState: "/key" }` are wired live to a small external store
// so inputs become two-way bindings without each component holding its own
// state. `on.<event>` declarative handlers dispatch through a `handlers` map.
//
// This is the minimum viable replacement for the prod widget's
// `@json-render/react`. It's enough for the spec shape produced by
// apps/web/lib/chat/ui-tools.ts (FormShell / ViewShell / Input / Textarea /
// Select / SubmitButton / Heading / Text / Table / KeyValue / PlanCard).

import { useSyncExternalStore, type ReactNode } from "react";

export type Spec = {
  root: string;
  elements: Record<string, ElementSpec>;
};

export type ElementSpec = {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
  on?: { press?: { action: string; params?: Record<string, unknown> } };
};

export type Store = {
  get(path: string): unknown;
  set(path: string, value: unknown): void;
  snapshot(): Record<string, unknown>;
  subscribe(listener: () => void): () => void;
};

export type Handlers = Record<string, (params: Record<string, unknown>) => void>;

export type RenderCtx = {
  store: Store;
  handlers: Handlers;
  renderChildren: (ids: string[]) => ReactNode;
};

export type Registry = Record<
  string,
  (props: Record<string, unknown> & {
    onPress?: () => void;
    renderChildren?: () => ReactNode;
  }) => ReactNode
>;

// ─────────────────────────────────────────────────────────────────────────
// Store: a JSON-pointer-ish ("/key") key-value bag with subscribe.
//
// Build ONCE per spec via useMemo(() => createStateStore(), []). Keying the
// memo on the spec rebuilds the store every render and the user's typing
// disappears.
// ─────────────────────────────────────────────────────────────────────────

export function createStateStore(
  initial: Record<string, unknown> = {},
): Store {
  let state: Record<string, unknown> = { ...initial };
  const listeners = new Set<() => void>();
  return {
    get: (path) => state[stripSlash(path)],
    set: (path, value) => {
      state = { ...state, [stripSlash(path)]: value };
      listeners.forEach((l) => l());
    },
    snapshot: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

function stripSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

// ─────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────

export function MiniRenderer({
  spec,
  registry,
  store,
  handlers,
}: {
  spec: Spec;
  registry: Registry;
  store: Store;
  handlers: Handlers;
}) {
  const renderNode = (id: string): ReactNode => {
    const node = spec.elements[id];
    if (!node) return null;
    const Component = registry[node.type];
    if (!Component) {
      return (
        <span key={id} className="text-xs text-rose-500">
          Unknown element: {node.type}
        </span>
      );
    }
    const props = bindProps(node.props ?? {}, store);
    if (node.on?.press) {
      const { action, params } = node.on.press;
      props.onPress = () => handlers[action]?.(params ?? {});
    }
    if (node.children && node.children.length > 0) {
      props.renderChildren = () => node.children!.map(renderNode);
    }
    return (
      <Component key={id} {...props} />
    );
  };
  return <>{renderNode(spec.root)}</>;
}

// Resolves `{ $bindState: "/foo" }` props into live values. Also exposes
// `on<Prop>Change(next)` setters so components don't need to know about the
// store.
function bindProps(
  rawProps: Record<string, unknown>,
  store: Store,
): Record<string, unknown> & {
  onPress?: () => void;
  renderChildren?: () => ReactNode;
} {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawProps)) {
    if (isBinding(v)) {
      const path = v.$bindState;
      // useSyncExternalStore inside the renderer would violate rules-of-hooks
      // (the renderer is called inside map). We instead read the snapshot per
      // render — the host component subscribes once and re-renders the whole
      // tree on any change. That's fine for forms with <20 fields; revisit if
      // we ever ship a spec with hundreds of inputs.
      out[k] = store.get(path);
      out[capitalizeChange(k)] = (next: unknown) => store.set(path, next);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function capitalizeChange(propName: string): string {
  return `on${propName[0]?.toUpperCase()}${propName.slice(1)}Change`;
}

function isBinding(v: unknown): v is { $bindState: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "$bindState" in v &&
    typeof (v as { $bindState: unknown }).$bindState === "string"
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Subscription helper for the host component
// ─────────────────────────────────────────────────────────────────────────

/**
 * Use this in the component that owns the store so a state change triggers
 * a re-render of the whole MiniRenderer tree.
 *
 * Example:
 *   const store = useMemo(() => createStateStore(), []);
 *   useStoreSnapshot(store); // subscribes
 *   return <MiniRenderer spec={spec} registry={registry} store={store} handlers={...} />;
 */
export function useStoreSnapshot(store: Store): Record<string, unknown> {
  return useSyncExternalStore(
    store.subscribe,
    () => store.snapshot(),
    () => store.snapshot(),
  );
}
