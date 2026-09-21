/**
 * 测试用节点：插件自身不提供的通用节点。
 */

import { WorkflowNode, type NodeExecutionContext, type WorkflowNodePorts } from 'dsh-workflow-studio'

/**
 * `sink`：原样输出送达的值。
 *
 * 插件不再提供收集结果的节点——那是工作流自身的输出端口的职责——但测试仍然需要一个
 * 可被执行边门控的下游节点，用来观察跳过是否沿执行边传递。
 */
export class SinkNode extends WorkflowNode<{ output: unknown }> {
  readonly type = 'sink'
  readonly label = 'Sink'
  readonly description = 'Passes its input through'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [{ name: 'input', type: 'any', required: false }],
    outputs: [{ name: 'output', type: 'any', display: 'json' }],
  }

  protected run({ inputs }: NodeExecutionContext): { output: unknown } {
    return { output: inputs.input ?? null }
  }
}
