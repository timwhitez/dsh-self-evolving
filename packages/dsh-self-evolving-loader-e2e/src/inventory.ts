/**
 * Quiescence inventory probe (spec 01 §4, dsh-integration.md §4).
 *
 * RSI acceptance tests must observe quiescence, not merely invoke a disposer:
 * compare tool/service/listener/timer/open-handle inventory before load and
 * after disposal. A candidate that leaves a detached promise, raw timer or
 * process handler would make the after-snapshot differ.
 *
 * This module captures a deterministic snapshot of the observable process +
 * Cordis-context surface. Two snapshots are "equal" iff every recorded dimension
 * is byte-identical, so the test fails on the smallest leak.
 */
import type { Context } from '@deepseek-ai/cordis'

export interface Inventory {
  /** Active handles from the Node async hooks resource tree (timers/promises/etc). */
  activeHandles: string[]
  /** Cordis registry service names present on the context. */
  registryServices: string[]
  /** Number of active child Fibers on the root context. */
  fiberCount: number
  /** Snapshot of process-level state that should be stable across a clean boot/unload. */
  listenerCount: number
  activeResources: number
}

/**
 * Snapshot the observable surface. Order is canonicalized so equality is stable
 * regardless of insertion order within a wave (spec 07 §5: event completion
 * order permutation must yield the same state hash).
 */
export function snapshot(ctx: Context, _label: string): Inventory {
  // process._getActiveHandles() / _getActiveRequests() are the documented
  // (if underscore-prefixed) Node internals used by the repl and debug tooling
  // to list live timers/sockets/child processes. They are the right probe for
  // "did the candidate leak a handle?".
  const handles = process as unknown as {
    _getActiveHandles?: () => unknown[]
    _getActiveRequests?: () => unknown[]
  }
  const activeHandles = (handles._getActiveHandles?.() ?? []).map((h) => {
    // Reduce to a stable constructor name; never serialize the object itself
    // (may contain sockets with non-deterministic ports).
    const ctor = (h as { constructor?: { name?: string } }).constructor
    return ctor?.name ?? 'anonymous'
  })
  activeHandles.sort()

  // Registry: enumerate the loader entries a real boot mounted. Each Entry
  // carries its options (.id, .name) on `entry.options`; the getter `entry.id`
  // prepends the parent path. We record "options.id:options.name" for a stable,
  // human-auditable fingerprint of exactly which rows are active.
  const registryServices: string[] = []
  const loader = (
    ctx as unknown as {
      loader?: {
        entries?: () => Iterable<{ options?: { id?: string; name?: string }; id?: string }>
      }
    }
  ).loader
  if (loader?.entries) {
    for (const entry of loader.entries()) {
      const oid = entry.options?.id ?? '?'
      const name = entry.options?.name ?? '?'
      registryServices.push(`${oid}:${name}`)
    }
  }
  registryServices.sort()

  return {
    activeHandles,
    registryServices,
    fiberCount: countFibers(ctx),
    listenerCount: (ctx as unknown as { state?: { listener?: number } }).state?.listener ?? -1,
    activeResources: (handles._getActiveRequests?.() ?? []).length,
  }
}

function countFibers(ctx: Context): number {
  // Active loader entries == active Fibers for the boot/unload test.
  const loader = (
    ctx as unknown as {
      loader?: { entries?: () => Iterable<unknown> }
    }
  ).loader
  let n = 0
  if (loader?.entries) {
    for (const _entry of loader.entries()) n++
  }
  return n
}

/** Render an inventory for assertion diff output. */
export function render(inv: Inventory): string {
  return [
    `activeHandles=[${inv.activeHandles.join(',')}]`,
    `fiberCount=${inv.fiberCount}`,
    `listenerCount=${inv.listenerCount}`,
    `activeResources=${inv.activeResources}`,
    `registryServices=[${inv.registryServices.join(',')}]`,
  ].join('\n')
}

/**
 * Per-constructor handle-count delta between a pre-load baseline and a
 * post-disposal probe. Any type whose count grew is a leak — a membership
 * comparison would hide additional handles of an already-present type.
 */
export function leakedHandleDelta(
  baseline: ReadonlyMap<string, number>,
  current: ReadonlyMap<string, number>,
): string[] {
  const leaked: string[] = []
  for (const [name, count] of current) {
    const before = baseline.get(name) ?? 0
    if (count > before) leaked.push(`${name}(+${count - before})`)
  }
  return leaked.sort()
}

/** Count live Node async handles (timers/sockets/etc) per constructor name. */
export function activeHandleCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const handle of (
    process as unknown as { _getActiveHandles?: () => { constructor?: { name?: string } }[] }
  )._getActiveHandles?.() ?? []) {
    const name = handle.constructor?.name ?? 'anon'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}
