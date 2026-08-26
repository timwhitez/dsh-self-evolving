/** Trusted fixed-route Unix gateway for a networkless proposal sandbox. */
import { createHash } from 'node:crypto'
import { chmod, mkdir, rm, stat } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
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
  /** Transport-retry attempt log for the trusted provider fetch (issue #123). */
  attempts?: Array<{
    attemptIndex: number
    status: number | null
    retryable: boolean
    ambiguous: boolean
    discardedUsage: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      reasoningTokens: number
    } | null
    responseId: string | null
  }>
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

export async function startProposalGateway(
  options: ProposalGatewayOptions,
): Promise<ProposalGatewayHandle> {
  if (!validRoute(options.route)) throw new Error('proposal gateway: invalid locked route')
  const socketPath = resolve(options.socketPath)
  if ((await stat(socketPath).catch(() => null)) !== null) {
    throw new Error(`proposal gateway: socket path already exists: ${socketPath}`)
  }
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  const maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024
  const completed = new Map<string, { requestHash: string; response: ProposalGatewayResponse }>()
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
    let result: unknown
    try {
      result = await options.handle(candidate.payload, context ?? { signal: neverSignal() })
    } catch {
      return { schemaVersion: 1, requestId, ok: false, error: 'trusted provider handler failed' }
    }
    const responseHash = sha256(stableJson(result))
    const response: ProposalGatewayResponse = {
      schemaVersion: 1,
      requestId,
      ok: true,
      result,
      responseHash,
    }
    completed.set(requestId, { requestHash, response })
    const attempts =
      result !== null &&
      typeof result === 'object' &&
      Array.isArray((result as { attempts?: unknown }).attempts)
        ? ((result as { attempts: ProposalGatewayReceipt['attempts'] }).attempts ?? undefined)
        : undefined
    receiptLog.push({
      requestId,
      requestHash,
      responseHash,
      routeHash: sha256(stableJson(options.route)),
      ...(attempts === undefined ? {} : { attempts }),
    })
    return response
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
    receipts: () => receiptLog.map((receipt) => ({ ...receipt })),
    async close() {
      if (closed) return
      closed = true
      for (const connection of connections) connection.destroy()
      await closeServer(server)
      await rm(socketPath, { force: true })
    },
  }
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
