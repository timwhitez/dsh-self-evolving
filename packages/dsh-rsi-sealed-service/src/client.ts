import { execFile } from 'node:child_process'
import type { ServiceRequest, ServiceResponse } from './service.js'

interface ErrorResponse {
  ok: false
  error: string
}

export function invokeSealedWorker(
  workerPath: string,
  request: ServiceRequest,
): Promise<ServiceResponse> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [workerPath],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        let response: ServiceResponse | ErrorResponse
        try {
          response = JSON.parse(stdout) as ServiceResponse | ErrorResponse
        } catch {
          reject(new Error(`SEALED_WORKER_PROTOCOL_ERROR: ${stderr || error?.message || stdout}`))
          return
        }
        if (!response.ok) {
          reject(new Error(response.error))
          return
        }
        resolve(response)
      },
    )
    child.stdin?.end(JSON.stringify(request))
  })
}
