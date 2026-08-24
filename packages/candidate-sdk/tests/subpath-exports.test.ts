import { describe, expect, it } from 'vitest'
import * as identity from '../src/identity/index.js'
import * as scan from '../src/scan/index.js'

describe('candidate-sdk public subpath entrypoints', () => {
  it('exposes the identity API through the declared identity entrypoint', () => {
    expect(typeof identity.buildCanonicalArchive).toBe('function')
    expect(typeof identity.candidateIdFromArchive).toBe('function')
  })

  it('exposes the policy scanner through the declared scan entrypoint', () => {
    expect(typeof scan.scanPaths).toBe('function')
  })
})
