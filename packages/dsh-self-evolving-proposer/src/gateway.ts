/** Trusted fixed-route Unix gateway for a networkless proposal sandbox. */
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { AdapterFetchAttempt } from './fetch-attempts.js'
import { dirname, resolve } from 'node:path'

export interface ProposalGatewayRoute {
  provider: string
  endpoint: string
  model: string
  reasoningEffort: string
  maxTokens: number
}

export interface ProposalGatewayRequest {
  schemaVersion: 1
  requestId: string
  route: ProposalGatewayRoute
  payload: unknown
  /**
   * Remaining request budget in milliseconds, measured from gateway receipt.
   * The trusted host aborts the in-flight provider fetch when it elapses so a
   * sandbox timeout bounds cost on BOTH sides of the socket (issue #57).
   */
  deadlineMs?: number
}

export type ProposalGatewayResponse =
  | { schemaVersion: 1; requestId: string; ok: true; result: unknown; responseHash: string }
  | { schemaVersion: 1; requestId: string; ok: false; error: string }

export interface ProposalGatewayReceipt {
  requestId: string
  requestHash: string
  responseHash: string
  routeHash: string
  /**
   * Transport-retry attempt log for the trusted provider fetch (issue #123).
   * Present on failure receipts too, so billed attempts never vanish with a
   * failed handler (issue #193).
   */
  attempts?: AdapterFetchAttempt[]
  /**
   * Set on failure receipts: the trusted handler did not produce a result.
   * NOTE: a request that fails and is later retried successfully yields TWO
   * receipt rows with the same requestId (failure first, success second).
   */
  error?: string
}

/**
 * A trusted-handler failure carrying its transport-retry attempt log: the
 * gateway records a failure receipt instead of dropping billed attempts
 * (issue #193).
 */
export class ProposalGatewayHandlerFailure extends Error {
  constructor(
    message: string,
    readonly attempts: AdapterFetchAttempt[],
  ) {
    super(message)
  }
}

export interface ProposalGatewayHandleContext {
  /** Aborts when the client disconnects or the request deadline elapses. */
  signal: AbortSignal
}

export interface ProposalGatewayOptions {
  socketPath: string
  route: ProposalGatewayRoute
  handle: (payload: unknown, context: ProposalGatewayHandleContext) => Promise<unknown>
  maxRequestBytes?: number
  /** Maximum concurrent sandbox connections; excess connections are destroyed on accept. */
  maxConnections?: number
  /**
   * Inactivity deadline from accept until the client half-closes with its
   * full request; a connection that never sends data/EOF is destroyed.
   */
  idleTimeoutMs?: number
  /** Deadline from a complete request until the response is written. */
  requestTimeoutMs?: number
  /**
   * Durable request store (issue #56): when set, each dispatched request is
   * reserved on disk before the provider runs and its final response is
   * recorded atomically, so idempotency survives process restarts and the
   * completed map is no longer the only state. Single owner process per
   * directory. A record left `pending` by a crashed dispatch fails closed:
   * the provider outcome is unknowable, so the request id is never
   * re-dispatched.
   */
  stateDir?: string
}

export interface ProposalGatewayHandle {
  socketPath: string
  request: (request: ProposalGatewayRequest) => Promise<ProposalGatewayResponse>
  receipts: () => ProposalGatewayReceipt[]
  close: () => Promise<void>
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function validRoute(route: ProposalGatewayRoute): boolean {
  return (
    typeof route.provider === 'string' &&
    route.provider.length > 0 &&
    typeof route.endpoint === 'string' &&
    route.endpoint.startsWith('https://') &&
    typeof route.model === 'string' &&
    route.model.length > 0 &&
    typeof route.reasoningEffort === 'string' &&
    route.reasoningEffort.length > 0 &&
    Number.isSafeInteger(route.maxTokens) &&
    route.maxTokens > 0
  )
}

interface DurableRequestRecord {
  schemaVersion: 1
  phase: 'pending' | 'complete'
  requestId: string
  requestHash: string
  routeHash: string
  response?: ProposalGatewayResponse
}

/**
 * File name is the hash of the request id, never the id itself: the id is
 * sandbox-controlled and must not become a path component.
 */
function durableRequestPath(stateDir: string, requestId: string): string {
  return `${stateDir}/request-${createHash('sha256').update(requestId).digest('hex')}.json`
}

async function readDurableRequest(path: string): Promise<DurableRequestRecord | null> {
  const raw = await readFile(path, 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as DurableRequestRecord
    if (
      value.schemaVersion !== 1 ||
      (value.phase !== 'pending' && value.phase !== 'complete') ||
      typeof value.requestId !== 'string' ||
      typeof value.requestHash !== 'string'
    ) {
      // A corrupt record is treated as pending: fail closed (issue #56).
      return { schemaVersion: 1, phase: 'pending', requestId: '', requestHash: '', routeHash: '' }
    }
    return value
  } catch {
    return { schemaVersion: 1, phase: 'pending', requestId: '', requestHash: '', routeHash: '' }
  }
}

/**
 * A replayed durable response must be a self-consistent envelope for THIS
 * request: shape, requestId, and — for successes — responseHash recomputed
 * from the stored result. Corruption confined to the response body must fail
 * closed, never replay as a poisoned success (issue #56).
 */
function durableResponseMatches(
  record: DurableRequestRecord,
  requestId: string,
): record is DurableRequestRecord & { response: ProposalGatewayResponse } {
  const response = record.response
  if (response === null || typeof response !== 'object') return false
  if (response.schemaVersion !== 1 || response.requestId !== requestId) return false
  if (response.ok === true) {
    return (
      typeof response.responseHash === 'string' &&
      response.responseHash === sha256(stableJson(response.result))
    )
  }
  return response.ok === false && typeof response.error === 'string'
}

async function reserveDurableRequest(path: string, record: DurableRequestRecord): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    // A failed reservation write (ENOSPC/EROFS/...) must not leave a partial
    // marker that permanently poisons this id: surface the failure instead of
    // silently treating it as a lost race.
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
}

/** Atomic completion: write a sibling temp file, then rename over the record. */
async function completeDurableRequest(path: string, record: DurableRequestRecord): Promise<void> {
  const temp = `${path}.complete-${process.pid}-${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

export async function startProposalGateway(
  options: ProposalGatewayOptions,
): Promise<ProposalGatewayHandle> {
  if (!validRoute(options.route)) throw new Error('proposal gateway: invalid locked route')
  const socketPath = resolve(options.socketPath)
  if ((await stat(socketPath).catch(() => null)) !== null) {
    // Refuse only when another gateway actually answers on this path; a
    // leftover socket file from a crashed owner is unlinked so a resumed run
    // can rebind and serve durable replays (issue #56).
    if (await socketIsLive(socketPath)) {
      throw new Error(`proposal gateway: socket path already exists: ${socketPath}`)
    }
    await rm(socketPath, { force: true }).catch(() => {
      throw new Error(`proposal gateway: cannot remove stale socket: ${socketPath}`)
    })
  }
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  const maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024
  const stateDir = options.stateDir === undefined ? undefined : resolve(options.stateDir)
  if (stateDir !== undefined) await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const completed = new Map<string, { requestHash: string; response: ProposalGatewayResponse }>()
  // Same-id dispatches in THIS process await one shared promise instead of
  // racing the handler (issue #56).
  const inFlight = new Map<
    string,
    { requestHash: string; promise: Promise<ProposalGatewayResponse> }
  >()
  const receiptLog: ProposalGatewayReceipt[] = []

  const request = async (
    candidate: ProposalGatewayRequest,
    context?: ProposalGatewayHandleContext,
  ): Promise<ProposalGatewayResponse> => {
    const requestId =
      typeof candidate?.requestId === 'string' && candidate.requestId.length > 0
        ? candidate.requestId
        : 'invalid'
    if (candidate?.schemaVersion !== 1 || requestId === 'invalid' || !validRoute(candidate.route)) {
      return { schemaVersion: 1, requestId, ok: false, error: 'invalid request envelope' }
    }
    const requestBytes = stableJson(candidate)
    if (Buffer.byteLength(requestBytes) > maxRequestBytes) {
      return { schemaVersion: 1, requestId, ok: false, error: 'request exceeds byte limit' }
    }
    const requestHash = sha256(requestBytes)
    const replay = completed.get(requestId)
    if (replay !== undefined) {
      if (replay.requestHash !== requestHash) {
        return { schemaVersion: 1, requestId, ok: false, error: 'conflicting idempotency replay' }
      }
      return replay.response
    }
    if (stableJson(candidate.route) !== stableJson(options.route)) {
      return { schemaVersion: 1, requestId, ok: false, error: 'route does not match locked route' }
    }
    // In-process concurrency: a second caller with the same id joins the
    // running dispatch instead of invoking the paid handler again (issue #56).
    const active = inFlight.get(requestId)
    if (active !== undefined) {
      if (active.requestHash !== requestHash) {
        return { schemaVersion: 1, requestId, ok: false, error: 'conflicting idempotency replay' }
      }
      return active.promise
    }
    const routeHash = sha256(stableJson(options.route))
    const dispatch = (async (): Promise<ProposalGatewayResponse> => {
      // Durable reservation runs INSIDE the shared dispatch promise so a
      // concurrent same-id caller joins this dispatch instead of observing
      // the pending marker between reservation and registration (issue #56).
      if (stateDir !== undefined) {
        const path = durableRequestPath(stateDir, requestId)
        const record = await readDurableRequest(path)
        if (record !== null) {
          if (record.requestHash === '') {
            // Corrupt record: fail closed without a misleading conflict claim.
            return {
              schemaVersion: 1,
              requestId,
              ok: false,
              error: 'durable request record is corrupt',
            }
          }
          if (record.requestHash !== requestHash) {
            return {
              schemaVersion: 1,
              requestId,
              ok: false,
              error: 'conflicting idempotency replay',
            }
          }
          if (record.phase === 'complete' && durableResponseMatches(record, requestId)) {
            completed.set(requestId, { requestHash, response: record.response })
            // The replayed response's billed attempts must still reach the
            // surfaced receipts on a resumed run (issue #193/#56).
            const replayResult = record.response.ok ? record.response.result : null
            const replayAttempts =
              replayResult !== null &&
              typeof replayResult === 'object' &&
              Array.isArray((replayResult as { attempts?: unknown }).attempts)
                ? ((replayResult as { attempts: ProposalGatewayReceipt['attempts'] }).attempts ??
                  undefined)
                : undefined
            receiptLog.push({
              requestId,
              requestHash,
              responseHash: record.response.ok
                ? record.response.responseHash
                : sha256(stableJson({ failed: true })),
              routeHash,
              ...(replayAttempts === undefined ? {} : { attempts: replayAttempts }),
            })
            return record.response
          }
          if (record.phase === 'complete') {
            // Complete record with a corrupt/foreign response body: treat as
            // interrupted, never replay it (issue #56).
            return {
              schemaVersion: 1,
              requestId,
              ok: false,
              error: 'durable request record is corrupt',
            }
          }
          // Pending from an interrupted (or cross-process) dispatch: the
          // provider outcome is unknowable, so fail closed instead of
          // dispatching a second paid call (issue #56).
          return {
            schemaVersion: 1,
            requestId,
            ok: false,
            error: 'durable request pending from an interrupted dispatch',
          }
        }
        const reserved = await reserveDurableRequest(path, {
          schemaVersion: 1,
          phase: 'pending',
          requestId,
          requestHash,
          routeHash,
        })
        if (!reserved) {
          // Lost the reservation race (cross-process): re-read and apply the
          // same rules to whatever won.
          const winner = await readDurableRequest(path)
          if (
            winner !== null &&
            winner.phase === 'complete' &&
            winner.requestHash === requestHash &&
            durableResponseMatches(winner, requestId)
          ) {
            return winner.response
          }
          return {
            schemaVersion: 1,
            requestId,
            ok: false,
            error: 'durable request pending from an interrupted dispatch',
          }
        }
      }
      let result: unknown
      try {
        result = await options.handle(candidate.payload, context ?? { signal: neverSignal() })
      } catch (error) {
        // A failed handler may still have billed attempts on the wire; record a
        // durable failure receipt so the attempt log reaches evidence (issue
        // #193). The client still sees the generic transport error. The
        // durable reservation is dropped so an in-place retry of the same id
        // stays possible, exactly as the pre-durable behavior allowed.
        if (error instanceof ProposalGatewayHandlerFailure && error.attempts.length > 0) {
          receiptLog.push({
            requestId,
            requestHash,
            responseHash: sha256(stableJson({ failed: true })),
            routeHash,
            attempts: error.attempts.map((row: AdapterFetchAttempt) => ({ ...row })),
            error: String(error.message),
          })
        }
        if (stateDir !== undefined) {
          await rm(durableRequestPath(stateDir, requestId), { force: true }).catch(() => {})
        }
        return { schemaVersion: 1, requestId, ok: false, error: 'trusted provider handler failed' }
      }
      let responseHash: string
      let attempts: ProposalGatewayReceipt['attempts'] | undefined
      try {
        responseHash = sha256(stableJson(result))
        attempts =
          result !== null &&
          typeof result === 'object' &&
          Array.isArray((result as { attempts?: unknown }).attempts)
            ? ((result as { attempts: ProposalGatewayReceipt['attempts'] }).attempts ?? undefined)
            : undefined
      } catch {
        // An unserializable handler result cannot be hashed or recorded;
        // drop the reservation so an in-place retry stays possible instead of
        // stranding this id as forever-pending.
        if (stateDir !== undefined) {
          await rm(durableRequestPath(stateDir, requestId), { force: true }).catch(() => {})
        }
        return { schemaVersion: 1, requestId, ok: false, error: 'trusted provider handler failed' }
      }
      const response: ProposalGatewayResponse = {
        schemaVersion: 1,
        requestId,
        ok: true,
        result,
        responseHash,
      }
      receiptLog.push({
        requestId,
        requestHash,
        responseHash,
        routeHash,
        ...(attempts === undefined ? {} : { attempts }),
      })
      if (stateDir !== undefined) {
        try {
          await completeDurableRequest(durableRequestPath(stateDir, requestId), {
            schemaVersion: 1,
            phase: 'complete',
            requestId,
            requestHash,
            routeHash,
            response,
          })
        } catch {
          // The paid call ran but its result cannot be made durable: never
          // cache or return it, and never re-dispatch this id. The receipt
          // log above still carries the attempt evidence.
          return {
            schemaVersion: 1,
            requestId,
            ok: false,
            error: 'durable completion write failed',
          }
        }
      }
      completed.set(requestId, { requestHash, response })
      return response
    })()
    inFlight.set(requestId, { requestHash, promise: dispatch })
    try {
      return await dispatch
    } finally {
      inFlight.delete(requestId)
    }
  }

  const connections = new Set<Socket>()
  // Connection-budget defaults bound socket count and lifetime so a single
  // untrusted sandbox cannot exhaust the trusted gateway's descriptors by
  // holding sockets open without EOF (issue #86).
  const maxConnections = options.maxConnections ?? 16
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000
  const requestTimeoutMs = options.requestTimeoutMs ?? 25 * 60_000
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (connections.size >= maxConnections) {
      socket.destroy()
      return
    }
    connections.add(socket)
    const drop = (): void => {
      socket.destroy()
      connections.delete(socket)
    }
    // Idle/first-byte deadline: armed from accept and disarmed as soon as the
    // request arrives; slowloris-style trickled or silent sockets die here.
    let idleArmed = true
    const disarmIdle = (): void => {
      if (idleArmed) {
        idleArmed = false
        socket.setTimeout(0)
      }
    }
    socket.setTimeout(idleTimeoutMs, drop)
    socket.once('close', () => connections.delete(socket))
    socket.once('error', drop)
    const chunks: Buffer[] = []
    let size = 0
    socket.on('data', (chunk: Buffer) => {
      disarmIdle()
      size += chunk.byteLength
      if (size > maxRequestBytes) {
        // Destroy immediately instead of waiting for EOF while buffering.
        drop()
        return
      }
      chunks.push(chunk)
    })
    socket.once('end', () => {
      disarmIdle()
      void (async () => {
        let response: ProposalGatewayResponse
        // Cancellation reaches the trusted provider fetch: the controller
        // aborts on client disconnect or the envelope's deadlineMs budget,
        // whichever fires first (issue #57).
        const cancellation = new AbortController()
        let deadlineTimer: NodeJS.Timeout | undefined
        socket.once('close', () => cancellation.abort(new Error('client disconnected')))
        const budget = setTimeout(drop, requestTimeoutMs)
        try {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (raw.split('\n').filter((line) => line.length > 0).length !== 1) {
            throw new Error('one request required')
          }
          const candidate = JSON.parse(raw) as ProposalGatewayRequest
          if (
            typeof candidate?.deadlineMs === 'number' &&
            Number.isFinite(candidate.deadlineMs) &&
            candidate.deadlineMs > 0 &&
            candidate.deadlineMs <= 3_600_000
          ) {
            deadlineTimer = setTimeout(
              () => cancellation.abort(new Error('request deadline elapsed')),
              candidate.deadlineMs,
            )
          }
          response = await request(candidate, { signal: cancellation.signal })
        } catch {
          response = {
            schemaVersion: 1,
            requestId: 'invalid',
            ok: false,
            error: 'invalid request JSON',
          }
        } finally {
          clearTimeout(budget)
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
        }
        socket.end(`${JSON.stringify(response)}\n`)
      })()
    })
  })
  await listen(server, socketPath)
  try {
    await chmod(socketPath, 0o600)
  } catch (error) {
    // A chmod failure must not strand the already-listening server/socket:
    // tear down before propagating (issue #118).
    await closeServer(server).catch(() => {})
    await rm(socketPath, { force: true }).catch(() => {})
    throw error
  }
  let closed = false
  return {
    socketPath,
    request,
    receipts: () =>
      receiptLog.map((receipt) => ({
        ...receipt,
        ...(receipt.attempts === undefined
          ? {}
          : { attempts: receipt.attempts.map((row) => ({ ...row })) }),
      })),
    async close() {
      if (closed) return
      closed = true
      for (const connection of connections) connection.destroy()
      await closeServer(server)
      await rm(socketPath, { force: true })
    },
  }
}

function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = createConnection(socketPath)
    const finish = (live: boolean): void => {
      probe.destroy()
      done(live)
    }
    probe.once('connect', () => finish(true))
    probe.once('error', () => finish(false))
    setTimeout(() => finish(false), 1_000).unref?.()
  })
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      done()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done, reject) => {
    server.close((error) => (error ? reject(error) : done()))
  })
}

function neverSignal(): AbortSignal {
  return new AbortController().signal
}

export interface ProposalGatewayClientOptions {
  /** Caller cancellation: destroys the connection and rejects promptly. */
  signal?: AbortSignal
  /**
   * Remaining request budget sent in the envelope; the trusted host aborts
   * its provider fetch when the budget elapses even if this client hangs.
   */
  deadlineMs?: number
}

export function requestProposalGateway(
  socketPath: string,
  request: ProposalGatewayRequest,
  options: ProposalGatewayClientOptions = {},
): Promise<ProposalGatewayResponse> {
  return new Promise((done, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error('request aborted before connect'))
      return
    }
    const socket = createConnection(socketPath)
    const chunks: Buffer[] = []
    const onAbort = (): void => {
      socket.destroy()
      reject(options.signal?.reason ?? new Error('request aborted'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const envelope: ProposalGatewayRequest =
      options.deadlineMs === undefined ? request : { ...request, deadlineMs: options.deadlineMs }
    socket.once('connect', () => socket.end(`${JSON.stringify(envelope)}\n`))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.once('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    socket.once('close', () => options.signal?.removeEventListener('abort', onAbort))
    socket.once('end', () => {
      options.signal?.removeEventListener('abort', onAbort)
      try {
        done(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProposalGatewayResponse)
      } catch (error) {
        reject(error)
      }
    })
  })
}
