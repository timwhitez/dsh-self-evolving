const certificateBlock = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/

function decodePem(bytes: Uint8Array, label: string): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (!certificateBlock.test(text)) throw new Error(`${label} has no PEM certificate`)
  if (text.includes('PRIVATE KEY')) throw new Error(`${label} unexpectedly contains a private key`)
  return text.trimEnd()
}

/** Preserve public roots while adding the private, one-run artifact CA. */
export function combinePemTrustBundle(publicRoots: Uint8Array, artifactCa: Uint8Array): Uint8Array {
  const publicPem = decodePem(publicRoots, 'public trust bundle')
  const artifactPem = decodePem(artifactCa, 'artifact CA')
  return Buffer.from(`${publicPem}\n${artifactPem}\n`)
}
