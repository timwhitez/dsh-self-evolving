/**
 * Parser + protocol-validation tests (no model call). Proves the proposer
 * output pipeline correctly parses + admits/rejects model output shapes.
 */
import { describe, expect, it } from 'vitest'
import {
  parseAndValidate,
  retainRejected,
  buildProposalPrompt,
  proposalMaxTokens,
} from '../src/index.js'

const PARENT = 'sha256:' + 'a'.repeat(64)

function childJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    proposalId: 'p1',
    canonicalParentDigest: PARENT,
    donorCandidates: [],
    hypothesis:
      'Add a bounded retry wrapper around transient tool failures to improve recovery without extra calls on success',
    evidenceRefs: ['evidence://dev/trace1'],
    mechanismTests: ['retries on transient failure'],
    preservationTests: ['no extra call when the first call succeeds'],
    sourceDiff:
      '+export function withRetry(fn) { let attempts = 0; while (attempts < 3) { try { return fn() } catch (e) { attempts++ } } throw e }\n+export const name = "retry"',
    ...overrides,
  })
}

describe('parse + validate', () => {
  it('admits a well-formed single-child response', () => {
    const res = parseAndValidate(childJson(), PARENT, 3)
    expect(res.accepted.length).toBe(1)
    expect(res.accepted[0]!.canonicalParentDigest).toBe(PARENT)
    expect(res.rejected).toEqual([])
  })

  it('strips accidental markdown fences', () => {
    const fenced = '```json\n' + childJson() + '\n```'
    const res = parseAndValidate(fenced, PARENT, 3)
    expect(res.accepted.length).toBe(1)
  })

  it('extracts JSON embedded in surrounding prose', () => {
    const prose = 'Here is my proposal:\n' + childJson() + '\nHope this helps.'
    const res = parseAndValidate(prose, PARENT, 3)
    expect(res.accepted.length).toBe(1)
  })

  it('rejects a no-change (empty diff) response', () => {
    const res = parseAndValidate(childJson({ sourceDiff: '' }), PARENT, 3)
    expect(res.accepted.length).toBe(0)
    expect(res.rejected[0]!.reason).toMatch(/no-change/)
  })

  it('rejects a missing, empty, or non-string proposal id deterministically', () => {
    const missing = JSON.parse(childJson()) as Record<string, unknown>
    delete missing['proposalId']
    const first = parseAndValidate(JSON.stringify(missing), PARENT, 3)
    const second = parseAndValidate(JSON.stringify(missing), PARENT, 3)
    expect(first.accepted).toEqual([])
    expect(first.rejected).toHaveLength(1)
    expect(first.rejected[0]?.proposalId).toMatch(/^invalid_[0-9a-f]{64}$/)
    expect(first.rejected[0]?.reason).toMatch(/proposalId is required/)
    expect(second).toEqual(first)

    for (const proposalId of ['', 42, null]) {
      const invalid = parseAndValidate(childJson({ proposalId }), PARENT, 3)
      expect(invalid.accepted).toEqual([])
      expect(invalid.rejected).toHaveLength(1)
      expect(invalid.rejected[0]?.proposalId).toMatch(/^invalid_[0-9a-f]{64}$/)
      expect(invalid.rejected[0]?.reason).toMatch(/proposalId is required/)
    }
  })

  it('rejects a parent-digest mismatch', () => {
    const res = parseAndValidate(
      childJson({ canonicalParentDigest: 'sha256:' + 'b'.repeat(64) }),
      PARENT,
      3,
    )
    expect(res.accepted.length).toBe(0)
  })

  it('retains rejected proposals with their raw text (evidence retention)', () => {
    const res = parseAndValidate(childJson({ sourceDiff: '' }), PARENT, 3)
    const records = retainRejected(res.rejected, 'raw assistant text')
    expect(records.length).toBe(1)
    expect(records[0]!.rawAssistantText).toBe('raw assistant text')
    expect(records[0]!.reason).toMatch(/no-change/)
    expect(records[0]!.retainedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns 0 accepted on unparseable output (NO_NONTRIVIAL_PROPOSAL)', () => {
    const res = parseAndValidate('the model rambled without JSON', PARENT, 3)
    expect(res.accepted.length).toBe(0)
    expect(res.rejected).toEqual([])
  })
})

describe('buildProposalPrompt', () => {
  it('uses the locked route output budget instead of silently forcing 2048 tokens', () => {
    expect(
      proposalMaxTokens({
        provider: 'deepseek',
        model: 'deepseek-v4-flash-zen',
        maxTokens: 32_768,
      }),
    ).toBe(32_768)
    expect(() =>
      proposalMaxTokens({ provider: 'deepseek', model: 'deepseek-v4-flash-zen', maxTokens: 0 }),
    ).toThrow(/positive safe integer/)
  })

  it('embeds the parent digest and width in the protocol contract', () => {
    const prompt = buildProposalPrompt({
      parentDigest: PARENT,
      parentSource: 'export function apply() {}',
      evidenceSummary: '2 dev failures: transient tool timeout',
      width: 3,
    })
    expect(prompt).toContain(PARENT)
    expect(prompt).toContain('Width is 3')
    expect(prompt).toContain('exactly ONE child')
  })
})