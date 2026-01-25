import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createCharter } from '../core/charter.js'
import { createNode } from '../core/node.js'
import { createStandardExecutor } from '../executor/standard.js'
import { buildSystemPrompt } from '../runtime/system-prompt.js'
import type { Node } from '../types/node.js'
import type { Instance } from '../types/instance.js'
import type { Charter } from '../types/charter'

describe('Custom System Prompt Builder', () => {
  it('should use default system prompt when no custom builder is provided', () => {
    const node = createNode({
      instructions: 'Test node instructions',
      validator: z.object({ count: z.number() }),
      initialState: { count: 0 },
    })

    const charter = createCharter({
      name: 'test-charter',
      executor: createStandardExecutor(),
    })

    const prompt = buildSystemPrompt(charter, node, { count: 0 }, [], {})

    expect(prompt).toContain('Test node instructions')
    expect(prompt).toContain('## Current Node State')
    expect(prompt).toContain('"count": 0')
  })

  it('should use custom system prompt builder when provided', () => {
    const node = createNode({
      instructions: 'Test node instructions',
      validator: z.object({ count: z.number() }),
      initialState: { count: 0 },
    })

    const customBuilder = <S>(
      charter: Charter,
      node: Node<any, S>,
      state: S,
      ancestors: Instance[],
      packStates: Record<string, unknown>
    ): string => {
      return `CUSTOM PROMPT: ${node.instructions} - State: ${JSON.stringify(state)}`
    }

    const charter = createCharter({
      name: 'test-charter',
      executor: createStandardExecutor(),
      buildSystemPrompt: customBuilder,
    })

    const prompt = buildSystemPrompt(charter, node, { count: 42 }, [], {})

    expect(prompt).toBe('CUSTOM PROMPT: Test node instructions - State: {"count":42}')
    expect(prompt).not.toContain('## Current Node State')
  })

  it('should pass all parameters to custom builder', () => {
    let capturedParams: {
      node: Node<any, any>
      state: any
      ancestors: Instance[]
      packStates: Record<string, unknown>
      options?: any
    } | null = null

    const customBuilder = <S>(
      charter: Charter,
      node: Node<any, S>,
      state: S,
      ancestors: Instance[],
      packStates: Record<string, unknown>,
      options?: any
    ): string => {
      capturedParams = { node, state, ancestors, packStates, options }
      return 'test'
    }

    const node = createNode({
      instructions: 'Test node',
      validator: z.object({ value: z.string() }),
      initialState: { value: 'test' },
    })

    const ancestorNode = createNode({
      instructions: 'Ancestor node',
      validator: z.object({ ancestorValue: z.string() }),
      initialState: { ancestorValue: 'ancestor' },
    })

    const ancestors: Instance[] = [
      {
        id: 'ancestor-1',
        node: ancestorNode,
        state: { ancestorValue: 'ancestor' },
      },
    ]

    const packStates = { myPack: { data: 'pack-data' } }
    const options = { currentStep: 5, maxSteps: 10 }

    const charter = createCharter({
      name: 'test-charter',
      executor: createStandardExecutor(),
      buildSystemPrompt: customBuilder,
    })

    buildSystemPrompt(charter, node, { value: 'test-state' }, ancestors, packStates, options)

    expect(capturedParams).not.toBeNull()
    expect(capturedParams!.node).toBe(node)
    expect(capturedParams!.state).toEqual({ value: 'test-state' })
    expect(capturedParams!.ancestors).toEqual(ancestors)
    expect(capturedParams!.packStates).toEqual(packStates)
    expect(capturedParams!.options).toEqual(options)
  })

  it('should allow custom builder to access node metadata', () => {
    const managerNode = createNode({
      instructions: 'Manager node',
      validator: z.object({}),
      initialState: {},
    })

    const troubleshooterNode = createNode({
      instructions: 'Troubleshooter node',
      validator: z.object({ issue: z.string() }),
      initialState: { issue: '' },
    })

    const nodeMetadata: Record<string, { role: string; purpose: string }> = {
      manager: {
        role: 'You are a support manager',
        purpose: 'Coordinate support tasks',
      },
      troubleshooter: {
        role: 'You are a troubleshooter',
        purpose: 'Diagnose and resolve issues',
      },
    }

    const customBuilder = <S>(
      charter: Charter,
      node: Node<any, S>,
      state: S,
      ancestors: Instance[],
      packStates: Record<string, unknown>
    ): string => {
      // In real implementation, node.id would be used to lookup metadata
      const nodeId = node.instructions.includes('Manager') ? 'manager' : 'troubleshooter'
      const metadata = nodeMetadata[nodeId]
      if (!metadata) return node.instructions
      return `${metadata.role}\n\nPurpose: ${metadata.purpose}\n\n${node.instructions}`
    }

    const charter = createCharter({
      name: 'test-charter',
      executor: createStandardExecutor(),
      buildSystemPrompt: customBuilder,
    })

    const managerPrompt = buildSystemPrompt(charter, managerNode, {}, [], {})
    expect(managerPrompt).toContain('You are a support manager')
    expect(managerPrompt).toContain('Coordinate support tasks')

    const troubleshooterPrompt = buildSystemPrompt(charter, troubleshooterNode, { issue: 'test' }, [], {})
    expect(troubleshooterPrompt).toContain('You are a troubleshooter')
    expect(troubleshooterPrompt).toContain('Diagnose and resolve issues')
  })

  it('should allow custom builder to format pack states differently', () => {
    const node = createNode({
      instructions: 'Test node',
      validator: z.object({}),
      initialState: {},
    })

    const customBuilder = <S>(
      charter: Charter,
      node: Node<any, S>,
      state: S,
      ancestors: Instance[],
      packStates: Record<string, unknown>
    ): string => {
      const packInfo = Object.entries(packStates)
        .map(([name, state]) => `Pack ${name}: ${JSON.stringify(state)}`)
        .join('\n')
      return `${node.instructions}\n\n# Pack States:\n${packInfo}`
    }

    const charter = createCharter({
      name: 'test-charter',
      executor: createStandardExecutor(),
      buildSystemPrompt: customBuilder,
    })

    const packStates = {
      plans: { activePlan: { id: '1', status: 'active' } },
      context: { userId: 'user-123' },
    }

    const prompt = buildSystemPrompt(charter, node, {}, [], packStates)

    expect(prompt).toContain('# Pack States:')
    expect(prompt).toContain('Pack plans:')
    expect(prompt).toContain('Pack context:')
    expect(prompt).toContain('activePlan')
    expect(prompt).toContain('userId')
  })
})
