/**
 * 基础演示节点单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RunId, type NodeExecutionContext } from 'dsh-workflow-studio'
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

describe('input 节点', () => {
  const node = DEMO_NODES.find(n => n.type === 'input')!

  it('应使用配置的默认值', async () => {
    const result = await node.execute(buildCtx({ config: { defaultValue: 42 } }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') assert.equal(result.outputs.output, 42)
  })

  it('无默认值时返回 0', async () => {
    const result = await node.execute(buildCtx({ config: {} }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') assert.equal(result.outputs.output, 0)
  })

  it('非法默认值应明确失败', async () => {
    const result = await node.execute(buildCtx({ config: { defaultValue: '42' } }))
    assert.deepEqual(result, { status: 'failed', error: 'defaultValue 必须为有限数值' })
  })
})

describe('arithmetic 节点', () => {
  const node = DEMO_NODES.find(n => n.type === 'arithmetic')!

  it('应正确执行加法', async () => {
    const result = await node.execute(buildCtx({
      config: { operator: 'add' },
      inputs: { left: 10, right: 20 },
    }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') assert.equal(result.outputs.result, 30)
  })

  it('应正确执行除法', async () => {
    const result = await node.execute(buildCtx({
      config: { operator: 'divide' },
      inputs: { left: 10, right: 2 },
    }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') assert.equal(result.outputs.result, 5)
  })

  it('除零应返回明确错误', async () => {
    const result = await node.execute(buildCtx({
      config: { operator: 'divide' },
      inputs: { left: 10, right: 0 },
    }))
    assert.deepEqual(result, { status: 'failed', error: '除数不能为 0' })
  })

  it('缺少操作数时不应默认补 0', async () => {
    const result = await node.execute(buildCtx({
      config: { operator: 'add' },
      inputs: { left: 10 },
    }))
    assert.equal(result.status, 'failed')
  })
})

describe('compare 节点', () => {
  const node = DEMO_NODES.find(n => n.type === 'compare')!

  it('表达式为 true 时输出 true', async () => {
    const result = await node.execute(buildCtx({
      config: { expression: 'left > right && right > 0' },
      inputs: { left: 3, right: 2 },
    }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') {
      assert.deepEqual(result.outputs, { result: true })
    }
  })

  it('表达式为 false 时输出 false', async () => {
    const result = await node.execute(buildCtx({
      config: { expression: 'left === right' },
      inputs: { left: 'a', right: 'b' },
    }))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') {
      assert.deepEqual(result.outputs, { result: false })
    }
  })

  it('支持属性访问和三元表达式', async () => {
    const result = await node.execute(buildCtx({
      config: { expression: 'left.score >= right ? true : false' },
      inputs: { left: { score: 10 }, right: 8 },
    }))
    assert.deepEqual(result, { status: 'completed', outputs: { result: true } })
  })

  it('拒绝语法错误和非布尔结果', async () => {
    const invalid = await node.execute(buildCtx({
      config: { expression: 'left >' },
      inputs: { left: 1, right: 0 },
    }))
    assert.equal(invalid.status, 'failed')
    if (invalid.status === 'failed') assert.match(invalid.error, /expression 执行失败/)

    assert.deepEqual(
      await node.execute(buildCtx({
        config: { expression: 'left + right' },
        inputs: { left: 1, right: 2 },
      })),
      { status: 'failed', error: 'expression 必须返回布尔值' },
    )
  })

  it('不允许通过表达式调用对象构造器', async () => {
    const result = await node.execute(buildCtx({
      config: { expression: 'left.constructor.constructor("return process")()' },
      inputs: { left: {}, right: null },
    }))
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') assert.match(result.error, /expression 执行失败/)
  })
})
