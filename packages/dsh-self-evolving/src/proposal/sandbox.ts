/**
 * Proposal sandbox policy (spec 05 §5.2, §6, §7; spec 03 §10).
 *
 * The proposer runs in a one-shot sandbox. Inputs are READ-ONLY capabilities,
 * not controller paths:
 *   /input/parent/        read-only parent source
 *   /input/archive/       candidate metadata; stats from DEV_OBSERVED only
 *   /input/evidence/      DEV_OBSERVED only; guarded by manifest
 *   /input/contracts/     candidate schema + selected DSH docs
 *   /work/children/<id>/  the ONLY writable output
 *
 * This module encodes the policy as a pure, testable decision function. A trace
 * prompt-injection fixture MUST NOT change it (spec 05 §3).
 */
import { createHash } from 'node:crypto'

/** Network policy per phase (spec 05 §6). */
export type Phase = 'controller' | 'proposal' | 'build' | 'task-agent' | 'verifier' | 'analysis'

export interface NetworkRule {
  /** Explicit allowlist of host patterns; everything else denied. */
  allowHosts: ReadonlySet<string>
  /** When true, NO network access is permitted (build phase). */
  denyAll: boolean
}

const PHASE_NETWORK: Record<Phase, NetworkRule> = {
  controller: {
    allowHosts: new Set(['llm-gateway', 'artifact-store', 'harbor-control']),
    denyAll: false,
  },
  proposal: { allowHosts: new Set(['proposer-gateway', 'docs-mirror']), denyAll: false },
  build: { allowHosts: new Set(), denyAll: true },
  'task-agent': { allowHosts: new Set(['task-policy-governed']), denyAll: false },
  verifier: { allowHosts: new Set(), denyAll: true },
  analysis: { allowHosts: new Set(), denyAll: true },
}

/** Filesystem access decision for one (path, mode) request inside the sandbox. */
export type FsDecision = 'allow-read' | 'allow-write' | 'deny'

export interface SandboxPaths {
  /** Read-only inputs. */
  parent: string
  archive: string
  evidence: string
  contracts: string
  /** The ONLY writable root. */
  childrenRoot: string
}

/**
 * Decide filesystem access for a path under the sandbox. Rules (spec 05 §5.2):
 *   - parent/archive/evidence/contracts: read-only;
 *   - childrenRoot and below: read+write;
 *   - anything else (host home, SSH, Docker socket, controller IPC): deny;
 *   - symlink escapes: deny (the exporter re-canonicalizes outside too).
 *
 * This is a pure function — the same (paths, requestedPath, mode) always yields
 * the same decision, so a prompt-injected trace cannot change policy.
 */
export function decideFsAccess(
  paths: SandboxPaths,
  requestedPath: string,
  mode: 'read' | 'write',
): FsDecision {
  // Deny obvious escape vectors regardless of path.
  if (requestedPath.includes('..')) return 'deny'
  if (isHostSensitive(requestedPath)) return 'deny'

  const roInputs = [paths.parent, paths.archive, paths.evidence, paths.contracts]
  for (const ro of roInputs) {
    if (requestedPath === ro || requestedPath.startsWith(ro + '/')) {
      return mode === 'write' ? 'deny' : 'allow-read'
    }
  }
  if (requestedPath === paths.childrenRoot || requestedPath.startsWith(paths.childrenRoot + '/')) {
    return 'allow-write'
  }
  return 'deny'
}

/** Host-sensitive paths a proposer must NEVER touch (spec 05 §5.2). */
function isHostSensitive(p: string): boolean {
  const lower = p.toLowerCase()
  const forbidden = [
    '/home/',
    '/root/',
    '.ssh',
    'docker.sock',
    '.aws',
    '.config/',
    'cloud-metadata',
    '169.254.169.254',
    '/var/run/',
    '/etc/shadow',
    'controller.sock',
    '.npmrc',
    '.netrc',
    'id_rsa',
    'id_ed25519',
  ]
  return forbidden.some((f) => lower.includes(f))
}

/** Network decision for a host under a phase policy. */
export function decideNetwork(phase: Phase, host: string): boolean {
  const rule = PHASE_NETWORK[phase]
  if (rule.denyAll) return false
  return rule.allowHosts.has(host)
}

/**
 * Model gateway firewall (spec 05 §7). The proposer may only call the locked
 * provider/model/endpoint — never an arbitrary URL. Returns the effective
 * request envelope, or throws if the candidate tried to override the route.
 */
export interface ModelRoute {
  provider: string
  endpoint: string
  model: string
  reasoningEffort: string
  maxTokens: number
}

export interface ModelRequest {
  model: string
  endpoint?: string
  /** Candidate-attempted overrides that the firewall strips/rejects. */
  customBillingTags?: Record<string, unknown>
}

export function enforceModelFirewall(route: ModelRoute, request: ModelRequest): ModelRoute {
  if (request.model !== route.model) {
    throw new Error(
      `model-firewall: candidate requested model ${request.model}, locked to ${route.model}`,
    )
  }
  if (request.endpoint !== undefined && request.endpoint !== route.endpoint) {
    throw new Error(
      `model-firewall: candidate requested endpoint ${request.endpoint}, locked to ${route.endpoint}`,
    )
  }
  if (request.customBillingTags && Object.keys(request.customBillingTags).length > 0) {
    throw new Error('model-firewall: candidate may not set custom billing tags')
  }
  return route
}

/** A content-addressed canary used to prove sealed/guard data never leaked. */
export function canary(id: string): { id: string; token: string } {
  return { id, token: createHash('sha256').update(`canary:${id}`).digest('hex').slice(0, 32) }
}
