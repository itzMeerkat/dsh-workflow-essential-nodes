/**
 * 基础演示节点：input/arithmetic/compare/output。
 * @module dsh-workflow-demo-node
 */

import jexl from 'jexl'
import { NodeFailure, WorkflowNode } from 'dsh-workflow-studio'
import type {
  NodeControlDefinition,
  NodeExecutionContext,
  WorkflowNodeExecutor,
  WorkflowNodePorts,
} from 'dsh-workflow-studio'

const expressionEngine = new jexl.Jexl()
expressionEngine.addBinaryOp('===', 20, (left: unknown, right: unknown) => left === right)
expressionEngine.addBinaryOp('!==', 20, (left: unknown, right: unknown) => left !== right)

/** input 节点：提供可配置的数值。 */
export class InputNode extends WorkflowNode<{ output: number }> {
  readonly type = 'input'
  readonly label = '输入'
  readonly description = '提供一个可配置的数值输入'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [],
    outputs: [{ name: 'output', type: 'number', description: '输出数值', display: 'value' }],
  }
  override readonly controls: readonly NodeControlDefinition[] = [{
    name: 'defaultValue',
    label: '数值',
    kind: 'number',
    defaultValue: 0,
    step: 1,
  }]

  protected run(ctx: NodeExecutionContext): { output: number } {
    const value = ctx.config.defaultValue ?? 0
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new NodeFailure('defaultValue 必须为有限数值')
    }
    return { output: value }
  }
}

/** arithmetic 节点：四则运算。 */
export class ArithmeticNode extends WorkflowNode<{ result: number }> {
  readonly type = 'arithmetic'
  readonly label = '四则运算'
  readonly description = '对 left 和 right 两个输入执行四则运算'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [
      { name: 'left', type: 'number', description: '左操作数' },
      { name: 'right', type: 'number', description: '右操作数' },
    ],
    outputs: [{ name: 'result', type: 'number', description: '运算结果', display: 'value' }],
  }
  override readonly controls: readonly NodeControlDefinition[] = [{
    name: 'operator',
    label: '运算',
    kind: 'select',
    defaultValue: 'add',
    options: [
      { label: '加', value: 'add' },
      { label: '减', value: 'subtract' },
      { label: '乘', value: 'multiply' },
      { label: '除', value: 'divide' },
    ],
  }]

  protected run(ctx: NodeExecutionContext): { result: number } {
    const left = ctx.inputs.left
    const right = ctx.inputs.right
    if (typeof left !== 'number' || !Number.isFinite(left)
      || typeof right !== 'number' || !Number.isFinite(right)) {
      throw new NodeFailure('left 和 right 必须为有限数值')
    }
    const op = ctx.config.operator ?? 'add'
    if (typeof op !== 'string') throw new NodeFailure('operator 必须为字符串')
    switch (op) {
      case 'add':
        return { result: left + right }
      case 'subtract':
        return { result: left - right }
      case 'multiply':
        return { result: left * right }
      case 'divide':
        if (right === 0) throw new NodeFailure('除数不能为 0')
        return { result: left / right }
      default:
        throw new NodeFailure(`不支持的运算符: ${op}`)
    }
  }
}

/** compare 节点：计算两个输入上的受限表达式并输出布尔结果，供引擎的 branch 节点分叉执行流。 */
export class CompareNode extends WorkflowNode<{ result: boolean }> {
  readonly type = 'compare'
  readonly label = '条件判断'
  readonly description = '计算 left 和 right 上的 JS 风格表达式并输出布尔结果'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [
      { name: 'left', type: 'any', description: '表达式变量 left' },
      { name: 'right', type: 'any', description: '表达式变量 right' },
    ],
    outputs: [{ name: 'result', type: 'boolean', description: '表达式结果', display: 'value' }],
  }
  override readonly controls: readonly NodeControlDefinition[] = [{
    name: 'expression',
    label: '表达式',
    kind: 'text',
    defaultValue: 'left === right',
    placeholder: 'left === right',
  }]

  protected run(ctx: NodeExecutionContext): { result: boolean } {
    const expression = ctx.config.expression ?? 'left === right'
    if (typeof expression !== 'string' || expression.trim() === '') {
      throw new NodeFailure('expression 必须为非空字符串')
    }
    let condition: unknown
    try {
      condition = expressionEngine.evalSync(expression, {
        left: ctx.inputs.left,
        right: ctx.inputs.right,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new NodeFailure(`expression 执行失败: ${message}`)
    }
    if (typeof condition !== 'boolean') throw new NodeFailure('expression 必须返回布尔值')
    return { result: condition }
  }
}

/** output 节点：输出最终结果。 */
export class OutputNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'output'
  readonly label = '输出'
  readonly description = '收集最终的运行结果'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [{ name: 'input', type: 'any', description: '要输出的值' }],
    outputs: [{ name: 'output', type: 'any', description: '最终结果', display: 'json' }],
  }

  protected run(ctx: NodeExecutionContext): { output: unknown } {
    const value = ctx.inputs.input
    ctx.log(`输出结果: ${JSON.stringify(value)}`)
    return { output: value }
  }
}

/** 所有基础演示节点的新实例。 */
export function createBasicNodes(): WorkflowNodeExecutor[] {
  return [new InputNode(), new ArithmeticNode(), new CompareNode(), new OutputNode()]
}
