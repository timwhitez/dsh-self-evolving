/**
 * Public entry of the loader E2E harness. Re-exports the inventory probe so the
 * Gate 0 tests and any future quiescence helper share one definition.
 */
export { snapshot, render, leakedHandleDelta, activeHandleCounts } from './inventory.js'
export type { Inventory } from './inventory.js'
