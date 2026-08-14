/**
 * Policy scanner rejection fixtures (spec 02 §8-§9, Phase 1 rejection suite).
 *
 * Each test feeds a source containing a forbidden construct and asserts the
 * scanner flags it as a REJECT. These are the import/secret/task-fingerprint
 * rejections; the Loader default-export rejection is in the loader-e2e package.
 */
import { describe, expect, it } from 'vitest'
import { scanSource } from '../src/index.js'

describe('policy scanner — rejection fixtures', () => {
  it('rejects dynamic import()', () => {
    const hits = scanSource('a.ts', 'const m = await import("./x.js")')
    expect(hits.some((h) => h.rule === 'dynamic-import' && h.severity === 'reject')).toBe(true)
  })

  it('rejects require()', () => {
    const hits = scanSource('a.ts', 'const fs = require("node:fs")')
    expect(hits.some((h) => h.rule === 'require-call')).toBe(true)
  })

  it('rejects eval()', () => {
    const hits = scanSource('a.ts', 'eval("1+1")')
    expect(hits.some((h) => h.rule === 'eval')).toBe(true)
  })

  it('rejects Function constructor', () => {
    const hits = scanSource('a.ts', 'const f = new Function("return 1")')
    expect(hits.some((h) => h.rule === 'function-constructor')).toBe(true)
  })

  it('rejects node:child_process import', () => {
    const hits = scanSource('a.ts', 'import { spawn } from "node:child_process"')
    expect(hits.some((h) => h.rule === 'child-process')).toBe(true)
  })

  it('rejects node:vm import', () => {
    const hits = scanSource('a.ts', 'import vm from "node:vm"')
    expect(hits.some((h) => h.rule === 'vm-module')).toBe(true)
  })

  it('rejects native addon (.node)', () => {
    const hits = scanSource('a.ts', "require('./native.node')")
    expect(hits.some((h) => h.rule === 'native-addon')).toBe(true)
  })

  it('rejects export default (Loader unwrap defect)', () => {
    const hits = scanSource('a.ts', "import { apply } from './x.js'\nexport default apply\n")
    expect(hits.some((h) => h.rule === 'default-export')).toBe(true)
  })

  it('does NOT flag "export default" mentioned inside a comment', () => {
    const hits = scanSource(
      'a.ts',
      '// Do not add `export default apply` beside named exports.\nexport function apply() {}\n',
    )
    expect(hits.some((h) => h.rule === 'default-export')).toBe(false)
  })

  it('rejects an api-key-shaped secret', () => {
    const syntheticSecret = ['sk-', 'AbCdEfGhIjKlMnOpQrStUv1234'].join('')
    const hits = scanSource('a.ts', `const apiKey = "${syntheticSecret}"`)
    expect(hits.some((h) => h.rule === 'secret-api-key')).toBe(true)
  })

  it('rejects a private key block', () => {
    const syntheticHeader = ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('')
    const hits = scanSource('a.ts', `const pk = "${syntheticHeader}"`)
    expect(hits.some((h) => h.rule === 'secret-private-key')).toBe(true)
  })

  it('rejects TB task name literal (extract-elf as quoted slug)', () => {
    const hits = scanSource('a.ts', 'const task = "extract-elf"')
    expect(hits.some((h) => h.rule === 'tb-task-name-literal')).toBe(true)
  })

  it('does NOT reject the neutral benchmark name Terminal-Bench in a prompt', () => {
    const hits = scanSource('a.ts', "'You are solving a Terminal-Bench task.'")
    expect(hits.some((h) => h.rule === 'tb-task-name-literal')).toBe(false)
  })

  it('rejects TB verifier filename (test_solution.py)', () => {
    const hits = scanSource('a.ts', 'const f = "test_solution.py"')
    expect(hits.some((h) => h.rule === 'tb-verifier-file')).toBe(true)
  })

  it('rejects an external (non-allowlist) import', () => {
    const hits = scanSource('a.ts', 'import axios from "axios"')
    expect(hits.some((h) => h.rule === 'import-external')).toBe(true)
  })

  it('rejects an unpinned @deepseek-ai/* package not in allowlist', () => {
    const hits = scanSource('a.ts', 'import x from "@deepseek-ai/dsh-controller"')
    expect(hits.some((h) => h.rule === 'import-dsh-unpinned')).toBe(true)
  })

  it('rejects a node: import outside the node allowlist', () => {
    const hits = scanSource('a.ts', 'import { readFileSync } from "node:fs"')
    expect(hits.some((h) => h.rule === 'import-node-disallowed')).toBe(true)
  })
})

describe('policy scanner — allowlist acceptance', () => {
  it('allows a clean candidate-baseline-shaped source', () => {
    const clean = `
      import type { Context } from '@deepseek-ai/cordis'
      import Schema from '@deepseek-ai/schemastery'
      import type {} from '@deepseek-ai/dsh-system-prompt'
      export const name = 'rsi-candidate'
      export const inject = ['systemPrompt']
      export function apply(ctx: Context): void {
        ctx.systemPrompt.section({ name: 'candidate:x', order: 1, text: 'hi' })
      }
    `
    const hits = scanSource('src/index.ts', clean)
    expect(hits.filter((h) => h.severity === 'reject')).toEqual([])
  })

  it('allows candidate-relative imports', () => {
    const hits = scanSource('a.ts', "import { x } from './helper.js'")
    expect(hits.some((h) => h.rule === 'import-external')).toBe(false)
  })
})
