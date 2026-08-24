/** Lifecycle-owned Cordis service for the durable RSI controller. */
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  acquireLock,
  append,
  appendOnce,
  snapshotAppendInput,
  readAll,
  readHead,
  type Journal,
  type AppendOnceResult,
  type JournalAppendInput,
  type JournalEvent,
  type LockHandle,
} from './journal/index.js'
import { readControllerStatus, type ControllerStatus } from './status.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    selfEvolving: SelfEvolvingService
  }
}

export interface Config {
  stateDir: string
  runId: string
  segmentMaxBytes: number
}

export const Config: Schema<Config> = Schema.object({
  stateDir: Schema.string().required(),
  runId: Schema.string().required(),
  segmentMaxBytes: Schema.number()
    .min(1)
    .default(16 * 1024 * 1024),
})

export type RecordInput<P = Record<string, unknown>> = JournalAppendInput<P>

/**
 * The sole controller capability exposed to trusted in-process consumers.
 * Its writer lock and teardown are owned by the mounting Cordis fiber.
 */
export class SelfEvolvingService extends Service {
  readonly config: Readonly<Config>
  readonly journal: Journal
  private lock: LockHandle | undefined
  private acceptingRecords = false
  private writeTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'selfEvolving')
    this.config = Object.freeze({ ...config })
    this.journal = Object.freeze({
      journalDir: join(this.config.stateDir, 'journal'),
      runId: this.config.runId,
      segmentMaxBytes: this.config.segmentMaxBytes,
    })
  }

  async start(): Promise<void> {
    const lock = await acquireLock(this.journal, `dsh-self-evolving:${this.config.runId}`)
    this.lock = lock
    try {
      // Startup is fail-closed: validate the full durable chain before the
      // service becomes available to dependents.
      await readAll(this.journal)
    } catch (error) {
      this.lock = undefined
      await lock.release()
      throw error
    }
    this.acceptingRecords = true
  }

  async stop(): Promise<void> {
    const lock = this.lock
    if (lock === undefined) return
    this.acceptingRecords = false
    await this.writeTail
    // Every record fsyncs before returning. Reading HEAD here is the explicit
    // final flush/validation barrier before releasing single-writer ownership.
    await readHead(this.journal)
    await lock.release()
    this.lock = undefined
  }

  async record<P = Record<string, unknown>>(input: RecordInput<P>): Promise<JournalEvent<P>> {
    const frozenInput = snapshotAppendInput(input)
    return this.withWriter(() => append(this.journal, frozenInput))
  }

  /** Commit one immutable semantic event, idempotently across action recovery. */
  async recordOnce<P = Record<string, unknown>>(
    input: RecordInput<P>,
  ): Promise<AppendOnceResult<P>> {
    const frozenInput = snapshotAppendInput(input)
    return this.withWriter(() => appendOnce(this.journal, frozenInput))
  }

  private async withWriter<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lock === undefined || !this.acceptingRecords) {
      throw new Error('controller service is not active')
    }
    const previous = this.writeTail
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    this.writeTail = previous.then(() => gate)
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  /** Read-only status rebuilt from authoritative durable events. */
  async status(): Promise<ControllerStatus> {
    await this.writeTail
    return readControllerStatus(this.config)
  }
}

export const name = 'dsh-self-evolving'
export const inject: string[] = []

export async function* apply(
  ctx: Context,
  config: Config,
): AsyncGenerator<() => Promise<void>, void, void> {
  const service = new SelfEvolvingService(ctx, config)
  await service.start()
  yield () => service.stop()
}
