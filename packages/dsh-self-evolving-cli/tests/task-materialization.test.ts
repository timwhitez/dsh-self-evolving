import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectTaskMaterializations } from '../src/task-materialization.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('planned task materialization', () => {
  it('reports every missing task rather than probing only the first one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-task-materialization-'))
    roots.push(root)
    for (const taskId of ['task-a', 'task-c']) {
      await mkdir(join(root, taskId), { recursive: true })
      await writeFile(join(root, taskId, 'task.toml'), 'version = 1\n')
    }

    const inspection = await inspectTaskMaterializations(root, [
      'task-a',
      'task-b',
      'task-c',
      'task-d',
    ])

    expect(inspection.malformed).toEqual([])
    expect(inspection.duplicates).toEqual([])
    expect(inspection.missing).toEqual(['task-b', 'task-d'])
  })

  it('rejects duplicate IDs before filesystem probes', async () => {
    const unavailableRoot = join(tmpdir(), 'dsh-task-root-that-must-not-be-probed')
    const inspection = await inspectTaskMaterializations(unavailableRoot, [
      'task-a',
      'task-a',
      'task-b',
    ])

    expect(inspection.taskIds).toEqual(['task-a', 'task-b'])
    expect(inspection.duplicates).toEqual(['task-a'])
    expect(inspection.missing).toEqual([])
  })

  it('rejects empty, non-string, traversal, and separator-bearing IDs', async () => {
    const inspection = await inspectTaskMaterializations('/unreachable', [
      '',
      ' task-a',
      '../task-a',
      'group/task-a',
      null,
      7,
    ])

    expect(inspection.taskIds).toEqual([])
    expect(inspection.malformed).toHaveLength(6)
    expect(inspection.duplicates).toEqual([])
    expect(inspection.missing).toEqual([])
  })

  it('accepts the canonical Terminal-Bench identifier alphabet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-self-evolving-canonical-task-id-'))
    roots.push(root)
    const taskId = 'task_name.v2-01'
    await mkdir(join(root, taskId), { recursive: true })
    await writeFile(join(root, taskId, 'task.toml'), 'version = 1\n')

    await expect(inspectTaskMaterializations(root, [taskId])).resolves.toEqual({
      taskIds: [taskId],
      malformed: [],
      duplicates: [],
      missing: [],
    })
  })
})
