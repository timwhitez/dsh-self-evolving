import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const schemaFiles = [
  'candidate.manifest.schema.json',
  'build.manifest.schema.json',
  'capsule.manifest.schema.json',
  'v011.candidate-intent.schema.json',
  'v011.evidence-citation.schema.json',
  'v011.proposal.schema.json',
  'v011.analysis.schema.json',
  'v011.mechanism-outcome.schema.json',
  'v011.capability-catalog.schema.json',
  'v011.materialization-receipt.schema.json',
  'v011.admission-receipt.schema.json',
  'v011.migration-receipt.schema.json',
]

describe('candidate-sdk packaged schema assets', () => {
  it('keeps every runtime validator schema under the package root', async () => {
    for (const file of schemaFiles) {
      const path = fileURLToPath(new URL(`../schemas/${file}`, import.meta.url))
      await expect(access(path)).resolves.toBeUndefined()
    }
  })
})
