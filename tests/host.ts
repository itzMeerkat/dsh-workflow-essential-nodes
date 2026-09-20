/**
 * 测试用 Host：在指定存储根目录上挂载存储、节点注册表和引擎。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig,
  inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig,
  inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import { DagEngineProvider, WorkflowNodeRegistry } from 'dsh-workflow-studio'
import type { DagEngineConfig, RunId, WorkflowNodeExecutor, WorkflowRunRecord } from 'dsh-workflow-studio'

/** 一组测试共享的 Host 与临时目录；`cleanup()` 在 afterEach 中调用。 */
export class TestHosts {
  private readonly contexts: Context[] = []
  private readonly roots: string[] = []

  /** 创建一个随 {@link cleanup} 删除的存储根目录。 */
  async root(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-studio-'))
    this.roots.push(root)
    return root
  }

  /**
   * 在存储根目录上启动 Host，注册节点并等待启动恢复完成。
   * @param root - 存储根目录；同一目录上的新 Host 模拟重启。
   * @param executors - 注册的节点执行器。
   * @param config - 引擎配置；省略时使用默认值。
   */
  async start(
    root: string,
    executors: readonly WorkflowNodeExecutor[],
    config?: Partial<DagEngineConfig>,
  ): Promise<{ ctx: Context; engine: DagEngineProvider }> {
    const ctx = new Context()
    this.contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({
      name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig,
    }, { backend: 'json' })
    await ctx.plugin(WorkflowNodeRegistry)
    for (const executor of executors) ctx.workflowNodeRegistry.register(executor, 'engine-tests')
    if (config === undefined) await ctx.plugin(DagEngineProvider)
    // The plugin Config schema fills the fields a test omits.
    else await ctx.plugin(DagEngineProvider, config as DagEngineConfig)
    const engine = ctx.dagEngine as DagEngineProvider
    await engine.recovered
    return { ctx, engine }
  }

  /** 停止所有 Host 并删除临时目录。 */
  async cleanup(): Promise<void> {
    await Promise.all(this.contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
    await Promise.all(this.roots.splice(0).map(async root => rm(root, { recursive: true, force: true })))
  }
}

/**
 * 等待运行结束；运行已结束时立即返回其结果。
 * @param ctx - 运行所在的 Host。
 * @param runId - 运行 ID。
 */
export function runEnded(ctx: Context, runId: RunId): Promise<WorkflowRunRecord> {
  const current = ctx.dagEngine.getRun(runId)
  if (current !== undefined && ['completed', 'failed', 'cancelled'].includes(current.status)) {
    return Promise.resolve(current)
  }
  return new Promise((resolve) => {
    const dispose = ctx.on('dag/end', (info) => {
      if (info.runId !== runId) return
      dispose()
      queueMicrotask(() => { resolve(ctx.dagEngine.getRun(runId)!) })
    })
  })
}

/**
 * 等待节点声明外部结果等待。
 * @param ctx - 运行所在的 Host。
 * @param nodeId - 节点 ID；省略时等待任意节点。
 */
export function signalRequested(ctx: Context, nodeId?: string): Promise<{ runId: RunId; nodeId: string; requestId: string }> {
  return new Promise((resolve) => {
    const dispose = ctx.on('dag/signal-requested', (info, node, requestId) => {
      if (nodeId !== undefined && node.nodeId !== nodeId) return
      dispose()
      resolve({ runId: info.runId, nodeId: node.nodeId, requestId })
    })
  })
}
