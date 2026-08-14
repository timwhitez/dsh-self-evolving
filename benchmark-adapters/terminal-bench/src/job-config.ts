/**
 * Harbor JobConfig generator for Terminal-Bench (spec 07 §4 Build).
 *
 * Produces a JobConfig YAML (schema: Harbor JobConfig) that runs a DSH
 * candidate (via its inline AcpRegistryEntry) against one or more TB tasks.
 *
 * The adapter is policy-free: it takes a candidate identity + task list and a
 * fixed environment template, and emits deterministic config. The controller
 * passes the idempotency key and budget; this module never invents scores,
 * sealed labels, or retry exemptions.
 */
import { stringify } from 'yaml'
import type { AcpRegistryEntry } from './acp-registry.js'

/** A TB task to run (path to a TB original-tasks/<name> directory). */
export interface TBTaskSpec {
  /** TB task id (directory name), e.g. "extract-elf". Used as the trial key. */
  taskId: string
  /** Absolute path to the task directory (contains task.yaml, Dockerfile, ...). */
  path: string
}

export interface TBVerifierConfig {
  /** Verifier timeout in seconds (mirrors Harbor TaskConfig verifier.timeout_sec). */
  timeoutSec: number
  /** Agent timeout in seconds. */
  agentTimeoutSec: number
}

export interface JobConfigInput {
  jobName: string
  /** Inline ACP registry entry for the candidate capsule. */
  registryEntry: AcpRegistryEntry
  /** Model route (provider/model), content-addressed in the run manifest. */
  modelName: string
  /** TB tasks to run. */
  tasks: TBTaskSpec[]
  /** Number of attempts per task (k_sealed or dev). */
  nAttempts: number
  /** Concurrent trials. */
  nConcurrentTrials: number
  /** Verifier/agent timeouts. */
  verifier: TBVerifierConfig
  /**
   * Idempotency key for the whole job (controller-assigned). The provider
   * embeds it in job_name + metadata so a duplicate submit is detectable and
   * Harbor/TCB can refuse a second paid trial for the same key.
   */
  idempotencyKey: string
  /** Jobs output directory. */
  jobsDir: string
}

/** The Harbor JobConfig as a plain object (serialized to YAML by the caller). */
export interface HarborJobConfig {
  job_name: string
  jobs_dir: string
  n_attempts: number
  n_concurrent_trials: number
  timeout_multiplier: number
  environment: {
    type: 'docker'
    force_build: boolean
    delete: boolean
  }
  agents: Array<{
    name: string
    model_name: string
    kwargs: Record<string, unknown>
  }>
  tasks: Array<{ path: string }>
  /** Custom metadata block; Harbor ignores unknown top-level keys. */
  metadata: Record<string, unknown>
}

/**
 * Build the Harbor JobConfig object for a candidate-on-TB run.
 */
export function buildJobConfig(input: JobConfigInput): HarborJobConfig {
  if (input.tasks.length === 0) throw new Error('job config: no tasks specified')
  if (!input.idempotencyKey) throw new Error('job config: idempotency key required')
  return {
    job_name: input.jobName,
    jobs_dir: input.jobsDir,
    n_attempts: input.nAttempts,
    n_concurrent_trials: input.nConcurrentTrials,
    timeout_multiplier: 1.0,
    environment: {
      type: 'docker',
      force_build: true,
      delete: true,
    },
    agents: [
      {
        // The inline registry entry is passed via kwargs; the agent name is the
        // enum value "acp" so Harbor's AcpAgent is selected.
        name: 'acp',
        model_name: input.modelName,
        kwargs: {
          registry_entry: input.registryEntry,
          auth_policy: 'disabled',
          permission_mode: 'allow',
        },
      },
    ],
    tasks: input.tasks.map((t) => ({ path: t.path })),
    metadata: {
      'dsh-rsi': {
        idempotency_key: input.idempotencyKey,
        candidate_id: input.registryEntry.id,
        tasks: input.tasks.map((t) => t.taskId),
        n_attempts: input.nAttempts,
        agent_timeout_sec: input.verifier.agentTimeoutSec,
        verifier_timeout_sec: input.verifier.timeoutSec,
      },
    },
  }
}

/** Serialize a JobConfig to YAML (deterministic key order via object construction). */
export function jobConfigToYaml(config: HarborJobConfig): string {
  return stringify(config, { sortMapEntries: false })
}
