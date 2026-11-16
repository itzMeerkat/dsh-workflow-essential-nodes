/**
 * `human-approval` 节点测试：批准、拒绝分支和重启后复用审批请求。
 */

import { afterEach,describe,it } from 'node:test'
import assert from 'node:assert/strict'
import {
EdgeId,NodeId,WORKFLOW_INPUT_TYPE,WORKFLOW_OUTPUT_TYPE,type RunId
} from 'dsh-workflow-studio'
import type { DagEdgeDefinition,DagEngineProvider,DagNodeDefinition,WorkflowRunRecord } from 'dsh-workflow-studio'
import { HumanApprovalNode } from '../src/approval-node.ts'
import { createBasicNodes } from '../src/basic-nodes.ts'
import { SinkNode } from './fixture-nodes.ts'
import { TestHosts,signalRequested,runEnded } from './host.ts'

const APPROVE = { answers: [{ id: 'decision', selected: ['批准'] }] }
const REJECT_WITH = (comment: string) => ({ answers: [{ id: 'decision', selected: [], custom: comment }] })

function edge(source: string, target: string, sourcePort?: string, targetPort?: string): DagEdgeDefinition {
  return {
    id: EdgeId(`${source}.${sourcePort ?? 'output'}->${target}.${targetPort ?? 'input'}`),
    kind: 'data',
    source: NodeId(source),
    target: NodeId(target),
    ...(sourcePort === undefined ? {} : { sourcePort }),
    ...(targetPort === undefined ? {} : { targetPort }),
  }
}

function execEdge(source: string, target: string, sourcePort?: string): DagEdgeDefinition {
  return {
    id: EdgeId(`${source}.${sourcePort ?? 'then'}=>${target}`),
    kind: 'exec',
    source: NodeId(source),
    target: NodeId(target),
    ...(sourcePort === undefined ? {} : { sourcePort }),
  }
}

function node(id: string, type: string, config: Record<string, unknown> = {}): DagNodeDefinition {
  return { id: NodeId(id), type, config }
}

/** workflow input value(5) → approval → passed (gated by approved), rejectedPath (gated by rejected). */
async function saveApprovalFlow(engine: DagEngineProvider, name = 'approval'): Promise<RunId> {
  const workflowId = await engine.save({
    name,
    nodes: [
      { ...node('in', WORKFLOW_INPUT_TYPE), outputs: [{ name: 'value', type: 'number', default: 5 }] },
      node('approval', 'human-approval', { question: 'Ship it?' }),
      node('passed', 'sink'),
      node('rejectedPath', 'sink'),
      {
        ...node('out', WORKFLOW_OUTPUT_TYPE),
        inputs: [
          { name: 'passed', type: 'any', required: false },
          { name: 'rejected', type: 'any', required: false },
        ],
      },
    ],
    edges: [
      edge('in', 'approval', 'value'),
      edge('approval', 'passed', 'output'),
      execEdge('approval', 'passed', 'approved'),
      edge('in', 'rejectedPath', 'value'),
      execEdge('approval', 'rejectedPath', 'rejected'),
      edge('passed', 'out', 'output', 'passed'),
      edge('rejectedPath', 'out', 'output', 'rejected'),
    ],
  })
  return engine.start(workflowId).runId
}

function status(result: WorkflowRunRecord, nodeId: string): string | undefined {
  return result.nodes.find(record => record.nodeId === nodeId)?.status
}

describe('human-approval 节点', () => {
  const hosts = new TestHosts()
  afterEach(async () => { await hosts.cleanup() })

  async function start() {
    return hosts.start(await hosts.root(), [...createBasicNodes(), new HumanApprovalNode(), new SinkNode()])
  }

  it('向审批人展示输入；批准后传递输入并输出 approved 信号', async () => {
    const { ctx, engine } = await start()
    const requested = signalRequested(ctx, 'approval')
    const runId = await saveApprovalFlow(engine, 'fail')
    assert.equal((await requested).requestId, 'approval')

    const request = engine.getRun(runId)!.nodes.find(item => item.nodeId === NodeId('approval'))!.requests![0]!
    assert.deepEqual(request.request, { kind: 'questions', questions: [{
      id: 'decision',
      header: '人工审批',
      question: 'Ship it?',
      detail: '5',
      options: [{ label: '批准' }, { label: '拒绝' }],
    }] })

    const done = runEnded(ctx, runId)
    await engine.signal(runId, NodeId('approval'), 'approval', APPROVE)
    const result = await done
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.nodes.find(record => record.nodeId === NodeId('approval'))?.outputs, { output: 5, comment: null })
    assert.equal(status(result, 'passed'), 'completed')
    assert.equal(status(result, 'rejectedPath'), 'skipped')
  })

  it('拒绝时触发 rejected 引脚，运行完成并执行拒绝分支', async () => {
    const { ctx, engine } = await start()
    const requested = signalRequested(ctx, 'approval')
    const runId = await saveApprovalFlow(engine, 'approval-rejected')
    await requested
    const done = runEnded(ctx, runId)
    await engine.signal(runId, NodeId('approval'), 'approval', REJECT_WITH('numbers look wrong'))
    const result = await done

    // A rejected approval is the process's answer, not a malfunction, so the run completes.
    assert.equal(result.status, 'completed')
    const approval = result.nodes.find(record => record.nodeId === NodeId('approval'))
    assert.equal(approval?.error, undefined)
    assert.deepEqual(approval?.outputs, { output: null, comment: 'numbers look wrong' })
    assert.deepEqual(approval?.fired, ['rejected'])
    assert.equal(status(result, 'passed'), 'skipped')
    assert.equal(status(result, 'rejectedPath'), 'completed')
  })

  it('重启后复用未回答的审批请求', async () => {
    const root = await hosts.root()
    const executors = () => [...createBasicNodes(), new HumanApprovalNode(), new SinkNode()]
    const first = await hosts.start(root, executors())
    const requested = signalRequested(first.ctx, 'approval')
    const runId = await saveApprovalFlow(first.engine, 'approval-restart')
    await requested
    await first.ctx.fiber.dispose()

    const second = await hosts.start(root, executors())
    const again = signalRequested(second.ctx, 'approval')
    await again
    const done = runEnded(second.ctx, runId)
    await second.engine.signal(runId, NodeId('approval'), 'approval', APPROVE)
    const result = await done
    assert.equal(result.status, 'completed')
    const approval = result.nodes.find(record => record.nodeId === NodeId('approval'))
    assert.equal(approval?.attempts, 2)
    assert.equal(approval?.requests?.length, 1)
  })
})
