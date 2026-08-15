import { describe, expect, it } from 'vitest'
import { consumeV011ToolBudget, type V011ToolState } from '../src/v011-tools.js'

function state(): V011ToolState {
  return {
    finished: false,
    callCount: 0,
    authoringCallCount: 0,
    correctionCallCount: 0,
    controlCallCount: 0,
    correctionMode: false,
  }
}

describe('v0.1.1 proposer tool budgets', () => {
  it('reserves finish and correction capacity after authoring is exhausted', () => {
    const value = state()
    for (let index = 0; index < 64; index += 1) consumeV011ToolBudget(value, 'content')
    expect(() => consumeV011ToolBudget(value, 'content')).toThrow(/finish_proposal/)

    consumeV011ToolBudget(value, 'control', true)
    for (let index = 0; index < 16; index += 1) consumeV011ToolBudget(value, 'content')
    expect(() => consumeV011ToolBudget(value, 'content')).toThrow(/semantic-correction/)
    consumeV011ToolBudget(value, 'control', true)

    expect(value).toMatchObject({
      callCount: 82,
      authoringCallCount: 64,
      correctionCallCount: 16,
      controlCallCount: 2,
      correctionMode: true,
    })
  })

  it('bounds control calls independently', () => {
    const value = state()
    for (let index = 0; index < 8; index += 1) consumeV011ToolBudget(value, 'control')
    expect(() => consumeV011ToolBudget(value, 'control')).not.toThrow()
    for (let index = 9; index < 16; index += 1) consumeV011ToolBudget(value, 'control')
    expect(() => consumeV011ToolBudget(value, 'control')).toThrow(/control-call limit/)
    expect(value.callCount).toBe(16)
  })
})
