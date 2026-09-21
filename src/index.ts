/**
 * dsh-workflow-demo-node plugin entry: registers the example Workflow Studio nodes —
 * `agent-prompt`, `human-approval`, and the basic `input`, `arithmetic`, `if`,
 * `compare`, and `output` nodes.
 * @module dsh-workflow-demo-node
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WorkflowNodeExecutor } from 'dsh-workflow-studio'
import { PLUGIN_NAME, createAgentNode, type AgentNodeSettings } from './agent-node.ts'
import { HumanApprovalNode } from './approval-node.ts'
import { createBasicNodes } from './basic-nodes.ts'

/** Stable Cordis plugin name, also recorded as every node's source plugin. */
export const name = PLUGIN_NAME

/** Services the nodes use; `agent-prompt` needs all but the registry. */
export const inject = [
  'workflowNodeRegistry',
  'agents',
  'agentPresets',
  'agentDefaultModel',
  'permissionPresets',
  'sessions',
  'workspaceRegistry',
]

/** Plugin config. */
export interface Config extends AgentNodeSettings {}

export const Config: z<Config> = z.object({
  workspacePath: z.string().required().description('Absolute workspace directory for Sessions started by agent-prompt nodes.'),
})

/**
 * Register every example node. Each registration is effect-owned, so a failed
 * registration unwinds the ones before it. The `agent-prompt` select options are
 * read once here; restart the profile to offer presets added later.
 * @param ctx - plugin context carrying the injected services.
 * @param config - validated plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const presets = await ctx.agentPresets.list()
  const nodes: WorkflowNodeExecutor[] = [
    createAgentNode(ctx, config, {
      agentPresets: presets.filter(preset => preset.broken === undefined),
      defaultAgentPreset: ctx.agentPresets.defaultId,
      permissionPresets: ctx.permissionPresets.names,
      defaultPermissionPreset: ctx.permissionPresets.defaultPreset,
    }),
    new HumanApprovalNode(),
    ...createBasicNodes(),
  ]
  for (const node of nodes) {
    ctx.effect(() => ctx.workflowNodeRegistry.register(node, PLUGIN_NAME), `${PLUGIN_NAME}:${node.type}`)
  }
}

export { AGENT_NODE_TYPE, CONTINUE_PROMPT, PLUGIN_NAME, createAgentNode } from './agent-node.ts'
export type { AgentNodeChoices, AgentNodeSettings } from './agent-node.ts'
export {
  APPROVAL_QUESTION_ID, APPROVAL_REQUEST_ID, DEFAULT_APPROVAL_QUESTION, HumanApprovalNode,
} from './approval-node.ts'
export { ArithmeticNode, CompareNode, createBasicNodes } from './basic-nodes.ts'
