import { readControllerStatus } from '@dsh-rsi/core'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StableDemoConfig } from './config.js'

export interface StableAuditReport {
  accepted: boolean
  status: 'STABLE_ITERATION_VERIFIED' | 'IN_PROGRESS' | 'REJECTED'
  reasons: string[]
  stateHash: string
  eventCount: number
}

export async function auditStableRun(config: StableDemoConfig): Promise<StableAuditReport> {
  const controller = await readControllerStatus(config)
  const reasons: string[] = []
  const state = controller.state
  const nodes = Object.values(state.candidates)
  const childNodes = nodes.filter((node) => node.canonicalParent !== null)
  const byId = new Map(nodes.map((node) => [node.candidateId, node]))
  const depthOf = (candidateId: string): number => {
    let depth = 0
    let current = byId.get(candidateId)
    const seen = new Set<string>()
    while (current?.canonicalParent !== null && current !== undefined) {
      if (seen.has(current.candidateId)) return -1
      seen.add(current.candidateId)
      depth += 1
      current = byId.get(current.canonicalParent)
    }
    return depth
  }
  if (childNodes.length !== config.limits.admittedChildren) {
    reasons.push(
      `unique admitted children incomplete: ${childNodes.length}/${config.limits.admittedChildren}`,
    )
  }
  if (Math.max(0, ...childNodes.map((node) => depthOf(node.candidateId))) < 2) {
    reasons.push('lineage depth is below 2')
  }
  if (state.observations.filter((row) => row.candidateId !== 'baseline').length !== 3) {
    reasons.push('candidate observation matrix is not exactly 3')
  }
  if (state.sealedAccessCount !== 0) reasons.push('sealed state was accessed')
  const freezePath = join(config.stateDir, 'failure-pool.json')
  const freezeInfo = await stat(freezePath).catch(() => null)
  if (freezeInfo?.isFile() !== true) reasons.push('frozen failure pool missing')
  else {
    const freeze = JSON.parse(await readFile(freezePath, 'utf8')) as { taskIds?: unknown }
    if (!Array.isArray(freeze.taskIds) || freeze.taskIds.length === 0) {
      reasons.push('frozen failure pool is empty')
    }
  }
  const crashReceipt = await stat(join(config.stateDir, 'crash-resume-receipt.json')).catch(
    () => null,
  )
  if (crashReceipt?.isFile() !== true) reasons.push('real crash/resume receipt missing')
  if (state.runPhase !== 'TERMINAL') reasons.push(`run is not terminal: ${state.runPhase}`)
  return {
    accepted: reasons.length === 0,
    status:
      reasons.length === 0
        ? 'STABLE_ITERATION_VERIFIED'
        : state.runPhase === 'TERMINAL'
          ? 'REJECTED'
          : 'IN_PROGRESS',
    reasons,
    stateHash: controller.stateHash,
    eventCount: controller.eventCount,
  }
}
