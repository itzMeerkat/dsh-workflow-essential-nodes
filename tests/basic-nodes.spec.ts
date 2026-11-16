/**
 * 基础演示节点单元测试。
 */

import { describe,it } from 'node:test'
import assert from 'node:assert/strict'
import { RunId,type NodeExecutionContext } from 'dsh-workflow-studio'
import { createBasicNodes } from '../src/basic-nodes.ts'

const DEMO_NODES = createBasicNodes()

function buildCtx(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  return {
    runId: RunId('test'),
    config: {},
    inputs: {},
    connected: new Set(),
    invocationKey: 'test/node',
    notepad: { value: undefined, save: async () => {} },
    awaitSignal: async () => { throw new Error('unused') },
    signal: new AbortController().signal,
    log: () => {},
    ...overrides,
  }
}

describe('arithmetic 节点', () => {
  const node = DEMO_NODES.find(n => n.type === 'arithmetic')!

  it('应正确执行加法', async () => {
    const result = await node.execute(buildCtx({
      config: { operator: 'add' },
      inputs: { left: 10, right: 20 },
    }))
    assert.equal(result.outputs.result, 30)
  })

  it('除零应抛出明确错误', async () => {
    await assert.rejects(Promise.resolve(node.execute(buildCtx({
      config: { operator: 'divide' },
      inputs: { left: 10, right: 0 },
    }))), /^RangeError: 除数不能为 0$/)
  })
})

describe('compare 节点', () => {
  const node = DEMO_NODES.find(n => n.type === 'compare')!

  it('支持属性访问和三元表达式', async () => {
    const result = await node.execute(buildCtx({
      config: { expression: 'left.score >= right ? true : false' },
      inputs: { left: { score: 10 }, right: 8 },
    }))
    assert.deepEqual(result, { outputs: { result: true } })
  })

  it('不允许通过表达式调用对象构造器', async () => {
    await assert.rejects(Promise.resolve(node.execute(buildCtx({
      config: { expression: 'left.constructor.constructor("return process")()' },
      inputs: { left: {}, right: null },
    }))), /expression 执行失败/)
  })
})
