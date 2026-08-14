/** Lifecycle-owned Cordis service for the durable RSI controller. */
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  acquireLock,
  append,
  readAll,
  readHead,
  type Journal,
  type JournalEvent,
  type LockHandle,
} from './journal/index.js'
import { readControllerStatus, type ControllerStatus } from './status.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    rsi: RsiService
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

export type RecordInput<P = Record<string, unknown>> = Omit<
  JournalEvent<P>,
  'schemaVersion' | 'runId' | 'seq' | 'eventHash' | 'previousHash'
> & { payload: P }

/**
 * The sole controller capability exposed to trusted in-process consumers.
 * Its writer lock and teardown are owned by the mounting Cordis fiber.
 */
export class RsiService extends Service {
  readonly journal: Journal
  private lock: LockHandle | undefined
  private acceptingRecords = false
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    ctx: Context,
    readonly config: Config,
  ) {
    super(ctx, 'rsi')
    this.journal = {
      journalDir: join(config.stateDir, 'journal'),
      runId: config.runId,
      segmentMaxBytes: config.segmentMaxBytes,
    }
  }

  async start(): Promise<void> {
    const lock = await acquireLock(this.journal, `dsh-rsi:${this.config.runId}`)
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
      return await append(this.journal, input)
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

export const name = 'dsh-rsi'
export const inject: string[] = []

export async function* apply(
  ctx: Context,
  config: Config,
): AsyncGenerator<() => Promise<void>, void, void> {
  const service = new RsiService(ctx, config)
  await service.start()
  yield () => service.stop()
}
