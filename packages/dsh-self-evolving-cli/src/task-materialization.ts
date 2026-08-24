import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

export interface TaskMaterializationInspection {
  taskIds: string[]
  malformed: string[]
  duplicates: string[]
  missing: string[]
}

const CANONICAL_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function describeMalformed(value: unknown, index: number): string {
  let rendered: string
  try {
    rendered = JSON.stringify(value) ?? String(value)
  } catch {
    rendered = String(value)
  }
  return `[${index}]=${rendered}`
}

/**
 * Validate the frozen task prefix before probing the filesystem. Invalid or
 * duplicate IDs make the inventory fail closed without turning attacker-owned
 * values into paths.
 */
export async function inspectTaskMaterializations(
  terminalBenchRoot: string,
  values: readonly unknown[],
): Promise<TaskMaterializationInspection> {
  const taskIds: string[] = []
  const malformed: string[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()

  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string' || !CANONICAL_TASK_ID.test(value)) {
      malformed.push(describeMalformed(value, index))
      continue
    }
    if (seen.has(value)) {
      if (!duplicates.includes(value)) duplicates.push(value)
      continue
    }
    seen.add(value)
    taskIds.push(value)
  }

  if (malformed.length > 0 || duplicates.length > 0) {
    return { taskIds, malformed, duplicates, missing: [] }
  }

  const checks = await Promise.all(
    taskIds.map(async (taskId) => ({
      taskId,
      present: await access(join(terminalBenchRoot, taskId, 'task.toml'), constants.R_OK)
        .then(() => true)
        .catch(() => false),
    })),
  )
  const missing = checks.filter((item) => !item.present).map((item) => item.taskId)
  return { taskIds, malformed, duplicates, missing }
}
