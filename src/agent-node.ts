/**
 * The `agent-prompt` Workflow Studio node: runs one prompt in a new root agent
 * Session composed from a selected agent preset and returns the final
 * assistant text.
 * @module dsh-workflow-demo-node
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionLogOffset, SessionSeq, type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { NodeFailure, WorkflowNode } from 'dsh-workflow-studio'
import type {
  JsonValue,
  NodeControlDefinition,
  NodeExecutionContext,
  WorkflowNodeExecutor,
  WorkflowNodePorts,
} from 'dsh-workflow-studio'

/** Cordis plugin name recorded as the node's source plugin and message source. */
export const PLUGIN_NAME = 'dsh-workflow-demo-node'

/** Node type identifier in the Workflow Studio catalog. */
export const AGENT_NODE_TYPE = 'agent-prompt'

/** Deployment settings shared by every `agent-prompt` node. */
export interface AgentNodeSettings {
  /** Absolute directory used as each new Session's workspace and cwd. */
  readonly workspacePath: string
}

/** Choices offered by the node's select controls, captured at registration. */
export interface AgentNodeChoices {
  /** Composable presets; broken presets are excluded. */
  readonly agentPresets: readonly AgentPreset[]
  /** Preset preselected on new nodes. */
  readonly defaultAgentPreset: string
  /** Configured permission preset names. */
  readonly permissionPresets: readonly string[]
  /** Permission preset preselected on new nodes. */
  readonly defaultPermissionPreset: string
}

type TurnEndReason = SessionEvent<'turn/end'>['data']['reason']

/** Final assistant text and turn outcome of one owned run interval. */
interface RunOutcome {
  /** Whether a turn started at or after the summarized offset. */
  readonly started: boolean
  readonly text: string
  readonly reason: TurnEndReason | undefined
}

/**
 * Notepad value that lets a re-called node reopen its Session instead of starting a new one.
 * `promptSeq` is the Session log length just before the prompt was sent.
 */
interface AgentNodeNotepad {
  readonly sessionId: SessionId
  readonly agentPreset: string
  readonly promptSeq: number
}

/** Message sent to a reopened Session whose prompt turn did not finish. */
export const CONTINUE_PROMPT = 'The previous turn was interrupted before it finished because the workflow Host restarted. Continue the original task and give your final answer.'

/**
 * Read this node's notepad value.
 * @returns the saved Session, or undefined when no earlier call saved one.
 * @throws when the durable value is not a value this node saved.
 */
function readNotepad(value: JsonValue | undefined): AgentNodeNotepad | undefined {
  if (value === undefined) return undefined
  const { sessionId, agentPreset, promptSeq } = (value ?? {}) as Record<string, unknown>
  if (typeof value !== 'object' || Array.isArray(value)
    || typeof sessionId !== 'string' || typeof agentPreset !== 'string'
    || typeof promptSeq !== 'number' || !Number.isSafeInteger(promptSeq) || promptSeq < 0) {
    throw new Error(`agent node notepad is malformed: ${JSON.stringify(value)}`)
  }
  return { sessionId: sessionId as SessionId, agentPreset, promptSeq }
}

/** Validated node inputs and config for one execution. */
interface ResolvedAgentRequest {
  readonly prompt: string
  readonly agentPreset: string
  readonly permissionPreset: string
}

/**
 * Validate one execution's runtime JSON.
 * @param context - node execution context.
 * @returns the request, or an error message for a failed result.
 */
function resolveRequest(context: NodeExecutionContext): ResolvedAgentRequest | string {
  const connected = context.connected.has('prompt')
  const prompt = connected ? context.inputs.prompt : context.config.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return connected ? 'prompt input must be a non-empty string' : 'prompt text must be a non-empty string'
  }
  const agentPreset = context.config.agentPreset
  if (typeof agentPreset !== 'string' || agentPreset === '') return 'agentPreset must be a non-empty string'
  const permissionPreset = context.config.permissionPreset
  if (typeof permissionPreset !== 'string' || permissionPreset === '') {
    return 'permissionPreset must be a non-empty string'
  }
  return { prompt, agentPreset, permissionPreset }
}

/**
 * Apply the creation-time model selection until the Session's first durable
 * request header exists, matching how the Host starts other root Sessions.
 */
function installInitialModelSelection(agentCtx: Context, selection: ModelSelection): void {
  agentCtx.on('agent/request', async ({ agent }, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (agent.session.requestHeader() !== undefined
      || resolved.provider !== selection.provider
      || resolved.model !== selection.model) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
  })
}

/**
 * Read the last non-empty assistant text and the turn outcome logged at or
 * after `firstSeq`.
 */
function summarize(session: Session, firstSeq: SessionLogOffset): RunOutcome {
  let started = false
  let text = ''
  let reason: TurnEndReason | undefined
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`agent node cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { started, text, reason }
}

/** Outputs of a completed `agent-prompt` node. */
interface AgentNodeOutputs extends Record<string, unknown> {
  readonly output: string
  readonly sessionId: string
}

/**
 * Map a logged turn outcome to the node outputs.
 * @param outcome - final text and turn-end reason.
 * @param sessionId - Session that ran the prompt, reported on success and failure.
 * @returns the outputs of a completed turn.
 * @throws NodeFailure carrying the same outputs when the turn did not complete.
 */
function toOutputs(outcome: RunOutcome, sessionId: SessionId): AgentNodeOutputs {
  const outputs = { output: outcome.text, sessionId }
  const reason = outcome.reason
  if (reason === undefined) {
    throw new NodeFailure(`agent Session ${sessionId} went idle without ending a turn`, outputs)
  }
  switch (reason.kind) {
    case 'completed':
      return outputs
    case 'error':
      throw new NodeFailure(`${reason.error.code}: ${reason.error.message}`, outputs)
    case 'aborted':
      throw new NodeFailure(`agent turn was cancelled (${reason.reason.kind})`, outputs)
    // TurnEndReasonMap is merge-extensible; every other reason is an unsuccessful end.
    default:
      throw new NodeFailure(`agent turn ended with reason "${reason.kind}"`, outputs)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the Session, submit the prompt, and wait until the Agent is idle.
 * The Session remains persisted and attached to its workspace; the live Agent
 * is disposed before this function settles.
 */
async function runPrompt(
  ctx: Context,
  settings: AgentNodeSettings,
  request: ResolvedAgentRequest,
  context: NodeExecutionContext,
): Promise<AgentNodeOutputs> {
  const { signal } = context
  ctx.permissionPresets.resolve(request.permissionPreset)
  const preset = await ctx.agentPresets.resolve(request.agentPreset)
  if (preset.broken !== undefined) {
    throw new NodeFailure(`agent preset "${preset.id}" cannot compose a Session: ${preset.broken}`)
  }
  await ctx.agentPresets.standingKeyFor(preset.id)
  signal.throwIfAborted()

  const workspace = await ctx.workspaceRegistry.create(settings.workspacePath)
  signal.throwIfAborted()
  const selected = ctx.agentDefaultModel.currentSelection()
  const selection: ModelSelection = { ...selected }
  const sessionId = `workflow-${randomUUID()}` as SessionId
  const handle = await ctx.agents.create({
    sessionId,
    signal,
    meta: { cwd: workspace.path, agentPreset: preset.id },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, preset.id)
      installInitialModelSelection(agentCtx, selection)
    },
  })
  const agent: Agent = handle.agent

  let attached = false
  let admitted = false
  try {
    signal.throwIfAborted()
    await workspace.attachSession(sessionId)
    attached = true
    signal.throwIfAborted()
    ctx.permissionPresets.set(agent.session, request.permissionPreset)
    const saved: AgentNodeNotepad = { sessionId, agentPreset: preset.id, promptSeq: agent.session.seq }
    await context.notepad.save({ ...saved })
    context.log(`agent Session ${sessionId} started with preset "${preset.id}"`)
    admitted = true
    return toOutputs(await sendAndWait(ctx, agent, context, request.prompt), sessionId)
  } catch (error: unknown) {
    if (!admitted && attached) {
      try {
        await workspace.detachSession(sessionId)
      } catch (rollbackError: unknown) {
        // Report the rollback failure without replacing the operation's original error.
        ctx.logger.warn(`${PLUGIN_NAME}: workspace detach for Session "${sessionId}" failed: ${messageOf(rollbackError)}`)
      }
    }
    throw error
  } finally {
    await handle.dispose()
  }
}

/**
 * Send one message as a new turn, wait until the Agent is idle, and summarize that turn.
 * Aborting the node's signal cancels the turn.
 */
async function sendAndWait(ctx: Context, agent: Agent, context: NodeExecutionContext, text: string): Promise<RunOutcome> {
  const cancel = (): void => { agent.cancel({ kind: 'user' }) }
  const firstSeq = agent.session.seq
  context.signal.addEventListener('abort', cancel, { once: true })
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME },
    }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    return summarize(agent.session, SessionLogOffset(firstSeq))
  } finally {
    context.signal.removeEventListener('abort', cancel)
  }
}

/**
 * Finish the prompt in the Session an earlier call of this node started.
 * A completed or failed prompt turn is reported as is; an interrupted one is continued; a Session
 * that never received the prompt gets it now.
 * @returns the node outputs, or undefined when the Session cannot be reopened.
 */
async function reopenPrompt(
  ctx: Context,
  saved: AgentNodeNotepad,
  request: ResolvedAgentRequest,
  context: NodeExecutionContext,
): Promise<AgentNodeOutputs | undefined> {
  const live = ctx.agents.get(saved.sessionId)
  let handle: { readonly agent: Agent; dispose(): Promise<void> } | undefined
  if (live === undefined) {
    try {
      const { provider, model } = ctx.agentDefaultModel.currentSelection()
      handle = await ctx.agents.resume({
        resumeSessionId: saved.sessionId,
        signal: context.signal,
        agentOptions: { provider, model },
        setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, saved.agentPreset) },
      })
    } catch (error: unknown) {
      if (context.signal.aborted) throw error
      context.log(`cannot reopen agent Session ${saved.sessionId}, starting a new one: ${messageOf(error)}`)
      return undefined
    }
  }
  const agent = live ?? handle!.agent
  try {
    await agent.whenIdle()
    const previous = summarize(agent.session, SessionLogOffset(saved.promptSeq))
    if (!previous.started) {
      context.log(`agent Session ${saved.sessionId} reopened; sending the prompt`)
      return toOutputs(await sendAndWait(ctx, agent, context, request.prompt), saved.sessionId)
    }
    if (previous.reason?.kind === 'completed' || previous.reason?.kind === 'error') {
      return toOutputs(previous, saved.sessionId)
    }
    context.log(`agent Session ${saved.sessionId} reopened; continuing the interrupted turn`)
    return toOutputs(await sendAndWait(ctx, agent, context, CONTINUE_PROMPT), saved.sessionId)
  } finally {
    await handle?.dispose()
  }
}

/** The `agent-prompt` node; see the module documentation. */
class AgentPromptNode extends WorkflowNode<AgentNodeOutputs> {
  readonly type = AGENT_NODE_TYPE
  readonly label = 'Agent 提示词'
  readonly description = '在所选 agent 预设的新会话中执行提示词，并输出最终回复'
  protected readonly ports: WorkflowNodePorts = {
    inputs: [
      { name: 'prompt', type: 'string', description: '发送给 agent 的提示词；连接后覆盖卡片中的提示词', required: false },
    ],
    outputs: [
      { name: 'output', type: 'string', description: 'agent 的最终回复文本', display: 'value' },
      { name: 'sessionId', type: 'string', description: '执行该提示词的会话 ID', display: 'value' },
    ],
  }
  override readonly controls: readonly NodeControlDefinition[]

  constructor(
    private readonly ctx: Context,
    private readonly settings: AgentNodeSettings,
    choices: AgentNodeChoices,
  ) {
    super()
    this.controls = [
      {
        name: 'prompt',
        label: '提示词',
        kind: 'text',
        defaultValue: '',
        placeholder: '发送给 agent 的提示词',
      },
      {
        name: 'agentPreset',
        label: 'Agent 预设',
        kind: 'select',
        defaultValue: choices.defaultAgentPreset,
        options: choices.agentPresets.map(preset => ({ label: preset.name ?? preset.id, value: preset.id })),
      },
      {
        name: 'permissionPreset',
        label: '权限',
        kind: 'select',
        defaultValue: choices.defaultPermissionPreset,
        options: choices.permissionPresets.map(name => ({ label: name, value: name })),
      },
    ]
  }

  protected async run(context: NodeExecutionContext): Promise<AgentNodeOutputs> {
    const request = resolveRequest(context)
    if (typeof request === 'string') throw new NodeFailure(request)
    const saved = readNotepad(context.notepad.value)
    const reopened = saved === undefined ? undefined : await reopenPrompt(this.ctx, saved, request, context)
    return reopened ?? await runPrompt(this.ctx, this.settings, request, context)
  }
}

/**
 * Build the `agent-prompt` executor.
 * @param ctx - context carrying the Agent, preset, permission, workspace, model, and Session services.
 * @param settings - validated deployment settings.
 * @param choices - select-control options captured at registration.
 * @returns the executor to register with `ctx.workflowNodeRegistry`.
 */
export function createAgentNode(
  ctx: Context,
  settings: AgentNodeSettings,
  choices: AgentNodeChoices,
): WorkflowNodeExecutor {
  if (!isAbsolute(settings.workspacePath)) {
    throw new TypeError(`${PLUGIN_NAME}: workspacePath must be absolute, got ${JSON.stringify(settings.workspacePath)}`)
  }
  return new AgentPromptNode(ctx, settings, choices)
}
