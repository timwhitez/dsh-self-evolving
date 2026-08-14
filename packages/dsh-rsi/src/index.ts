/**
 * @dsh-rsi/core — trusted durable RSI controller core (spec 06).
 *
 * Crash-safe by construction: content-addressed object store, hash-chain JSONL
 * journal, pure state reducer + disposable snapshot, budget double-entry ledger.
 * The filesystem is the source of truth; every derived index is rebuildable.
 */
export * from './object-store/index.js'
export * from './journal/index.js'
export * from './reducer/index.js'
export * from './budget/index.js'
