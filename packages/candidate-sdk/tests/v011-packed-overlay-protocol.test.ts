import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  parseV011PackedOverlayControl,
  V011_PACKED_OVERLAY_ACP_OUTPUT_LIMIT_BYTES,
  V011PackedOverlayAcpOutputGuard,
  validateV011AcpOutputLine,
} from '../src/v011/admission.js'

const CANDIDATE_ID = `sha256:${'a'.repeat(64)}`
const NONCE = 'b'.repeat(64)

function control(...records: unknown[]): Buffer {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n')
}

const challenge = { schemaVersion: 1, phase: 'challenge', nonce: NONCE }
const ready = {
  schemaVersion: 1,
  phase: 'ready',
  nonce: NONCE,
  candidateId: CANDIDATE_ID,
  configRef: 'runtime/cordis.yml',
  runtimeSettled: true,
}

describe('v0.1.1 packed-overlay trusted control protocol (issue #197)', () => {
  it('accepts exactly one worker challenge followed by its matching post-import receipt', () => {
    expect(parseV011PackedOverlayControl(control(challenge, ready), CANDIDATE_ID)).toEqual(ready)
  })

  it('rejects candidate-forgeable ready-only, wrong-nonce, and duplicate transcripts', () => {
    expect(() => parseV011PackedOverlayControl(control(ready), CANDIDATE_ID)).toThrow(
      /exactly two records/,
    )
    expect(() =>
      parseV011PackedOverlayControl(
        control(challenge, { ...ready, nonce: 'c'.repeat(64) }),
        CANDIDATE_ID,
      ),
    ).toThrow(/nonce mismatch/)
    expect(() =>
      parseV011PackedOverlayControl(control(challenge, ready, ready), CANDIDATE_ID),
    ).toThrow(/exactly two records/)
  })

  it('rejects malformed, unterminated, or wrong-identity control transcripts', () => {
    expect(() => parseV011PackedOverlayControl(Buffer.from('{not-json}\n'), CANDIDATE_ID)).toThrow(
      /exactly two records|invalid JSON/,
    )
    expect(() =>
      parseV011PackedOverlayControl(Buffer.from(JSON.stringify(challenge)), CANDIDATE_ID),
    ).toThrow(/newline-terminated/)
    expect(() =>
      parseV011PackedOverlayControl(control(challenge, ready), `sha256:${'d'.repeat(64)}`),
    ).toThrow(/ready receipt is invalid/)
  })
})

describe('v0.1.1 packed-overlay ACP stdout guard (issue #197)', () => {
  it('accepts only JSON-RPC 2.0 objects', () => {
    expect(() => validateV011AcpOutputLine('{"jsonrpc":"2.0","id":1,"result":{}}')).not.toThrow()
    expect(() =>
      validateV011AcpOutputLine('{"jsonrpc":"2.0","method":"session/update","params":{}}'),
    ).not.toThrow()
    expect(() => validateV011AcpOutputLine('not-json')).toThrow(/valid JSON/)
    expect(() => validateV011AcpOutputLine('[]')).toThrow(/JSON-RPC 2.0 object/)
    expect(() => validateV011AcpOutputLine('{"id":1,"result":{}}')).toThrow(/JSON-RPC 2.0 object/)
    expect(() => validateV011AcpOutputLine('{"jsonrpc":"2.0"}')).toThrow(
      /JSON-RPC request or response/,
    )
    expect(() => validateV011AcpOutputLine('{"jsonrpc":"2.0","method":"x","result":{}}')).toThrow(
      /invalid JSON-RPC request/,
    )
    expect(() => validateV011AcpOutputLine('{"jsonrpc":"2.0","id":1.5,"result":{}}')).toThrow(
      /invalid JSON-RPC id/,
    )
  })

  it('fails on any stdout before the trusted worker finishes boot', async () => {
    const guard = new V011PackedOverlayAcpOutputGuard()
    const failed = once(guard, 'error')
    guard.write('{"jsonrpc":"2.0","id":1,"result":{}}\n')
    const [error] = (await failed) as [Error]
    expect(error.message).toMatch(/before trusted runtime ready/)
  })

  it('fails closed on malformed lines and output above the byte cap', async () => {
    const malformed = new V011PackedOverlayAcpOutputGuard()
    malformed.beginHandshake()
    const malformedFailure = once(malformed, 'error')
    malformed.write('not-json\n')
    const [malformedError] = (await malformedFailure) as [Error]
    expect(malformedError.message).toMatch(/valid JSON/)

    const oversized = new V011PackedOverlayAcpOutputGuard()
    oversized.beginHandshake()
    const oversizedFailure = once(oversized, 'error')
    oversized.write(Buffer.alloc(V011_PACKED_OVERLAY_ACP_OUTPUT_LIMIT_BYTES + 1, 0x20))
    const [oversizedError] = (await oversizedFailure) as [Error]
    expect(oversizedError.message).toMatch(/byte limit/)
  })
})
