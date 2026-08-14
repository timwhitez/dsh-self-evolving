#!/usr/bin/env node
import { handleServiceRequest, type ServiceRequest } from './service.js'

async function readInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

try {
  const request = JSON.parse(await readInput()) as ServiceRequest
  const response = await handleServiceRequest(request)
  process.stdout.write(JSON.stringify(response) + '\n')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n')
  process.exitCode = 1
}
