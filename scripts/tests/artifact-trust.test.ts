import { describe, expect, it } from 'vitest'
import { combinePemTrustBundle } from '../artifact-trust.js'

const cert = (name: string) =>
  Buffer.from(`-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----\n`)

describe('artifact TLS trust bundle', () => {
  it('appends the private artifact CA without replacing public roots', () => {
    const bundle = Buffer.from(combinePemTrustBundle(cert('PUBLIC_ROOT'), cert('ARTIFACT_CA')))
    expect(bundle.toString()).toBe(
      '-----BEGIN CERTIFICATE-----\nPUBLIC_ROOT\n-----END CERTIFICATE-----\n' +
        '-----BEGIN CERTIFICATE-----\nARTIFACT_CA\n-----END CERTIFICATE-----\n',
    )
  })

  it('rejects a key or a non-certificate input', () => {
    const syntheticPrivateKeyMarker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
    expect(() =>
      combinePemTrustBundle(cert('PUBLIC_ROOT'), Buffer.from(syntheticPrivateKeyMarker)),
    ).toThrow(/no PEM certificate|private key/)
    expect(() => combinePemTrustBundle(Buffer.from('not a bundle'), cert('ARTIFACT_CA'))).toThrow(
      /no PEM certificate/,
    )
  })
})
