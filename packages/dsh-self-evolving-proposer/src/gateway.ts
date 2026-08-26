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
}

export type ProposalGatewayResponse =
  | { schemaVersion: 1; requestId: string; ok: true; result: unknown; responseHash: string }
  | { schemaVersion: 1; requestId: string; ok: false; error: string }

export interface ProposalGatewayReceipt {
  requestId: string
  requestHash: string
  responseHash: string
  routeHash: string
}

export interface ProposalGatewayOptions {
  socketPath: string
  route: ProposalGatewayRoute
  handle: (payload: unknown) => Promise<unknown>
  maxRequestBytes?: number
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

  const request = async (candidate: ProposalGatewayRequest): Promise<ProposalGatewayResponse> => {
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
      result = await options.handle(candidate.payload)
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
    receiptLog.push({
      requestId,
      requestHash,
      responseHash,
      routeHash: sha256(stableJson(options.route)),
    })
    return response
  }

  const connections = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
    const chunks: Buffer[] = []
    let size = 0
    let overLimit = false
    socket.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > maxRequestBytes) {
        overLimit = true
        return
      }
      chunks.push(chunk)
    })
    socket.once('end', () => {
      void (async () => {
        let response: ProposalGatewayResponse
        if (overLimit) {
          response = {
            schemaVersion: 1,
            requestId: 'invalid',
            ok: false,
            error: 'request exceeds byte limit',
          }
        } else {
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            if (raw.split('\n').filter((line) => line.length > 0).length !== 1) {
              throw new Error('one request required')
            }
            response = await request(JSON.parse(raw) as ProposalGatewayRequest)
          } catch {
            response = {
              schemaVersion: 1,
              requestId: 'invalid',
              ok: false,
              error: 'invalid request JSON',
            }
          }
        }
        socket.end(JSON.stringify(response) + '\n')
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

export function requestProposalGateway(
  socketPath: string,
  request: ProposalGatewayRequest,
): Promise<ProposalGatewayResponse> {
  return new Promise((done, reject) => {
    const socket = createConnection(socketPath)
    const chunks: Buffer[] = []
    socket.once('connect', () => socket.end(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.once('error', reject)
    socket.once('end', () => {
      try {
        done(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProposalGatewayResponse)
      } catch (error) {
        reject(error)
      }
    })
  })
}
