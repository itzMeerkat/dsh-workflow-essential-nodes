/**
 * `agent-prompt` executor and registration tests over scripted Host services.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { WorkflowNodeRegistry, RunId } from 'dsh-workflow-studio'
import type { NodeExecutionContext, NodeExecutionResult, WorkflowNodeExecutor } from 'dsh-workflow-studio'
import { AGENT_NODE_TYPE, CONTINUE_PROMPT, PLUGIN_NAME, createAgentNode } from '../src/agent-node.ts'
import type { AgentNodeChoices } from '../src/agent-node.ts'

type ScriptedEvent = { type: string; data?: unknown }

/** What one scripted turn appends after the prompt arrives. */
type TurnScript =
  | { kind: 'events'; events: ScriptedEvent[] }
  | { kind: 'hang' }

/** Records every Host-service call the executor makes. */
interface Recorder {
  created: Array<{ sessionId: string; meta: unknown; agentOptions: unknown }>
  mounted: string[]
  attached: string[]
  detached: string[]
  permissions: string[]
  prompts: Array<{ content: unknown; source: unknown }>
  cancels: unknown[]
  flushed: number
  disposed: number
  resumed: string[]
}

/** A Session an earlier call of the node started, as the Host sees it on a re-call. */
interface ExistingSession {
  readonly events: ScriptedEvent[]
  /** `resume` loads it; `live` finds it already open; `missing` fails to load it. */
  readonly mode: 'resume' | 'live' | 'missing'
}

const EXISTING_ID = 'workflow-existing'


const CHOICES: AgentNodeChoices = {
  agentPresets: [
    { id: 'standard', trust: 'system', path: '/presets/standard/agent.cordis.yml', name: 'Standard' },
    { id: 'minimal', trust: 'system', path: '/presets/minimal/agent.cordis.yml' },
  ],
  defaultAgentPreset: 'standard',
  permissionPresets: ['workspace-write', 'danger-full-access'],
  defaultPermissionPreset: 'workspace-write',
}

function assistant(text: string): ScriptedEvent {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

function turnEnd(reason: unknown): ScriptedEvent {
  return { type: 'turn/end', data: { reason } }
}

/**
 * Build a Context-shaped object whose services script one Agent turn.
 * @param script - what the turn appends after the prompt.
 * @param brokenPreset - preset id `resolve()` reports as broken.
 */
function scriptedHost(
  script: TurnScript,
  brokenPreset?: string,
  existing?: ExistingSession,
): { host: Context; recorder: Recorder } {
  const recorder: Recorder = {
    created: [], mounted: [], attached: [], detached: [], permissions: [],
    prompts: [], cancels: [], flushed: 0, disposed: 0, resumed: [],
  }
  const agent = scriptedAgent([{ type: 'session/start' }], script, recorder)
  const reopened = existing === undefined ? undefined : scriptedAgent([...existing.events], script, recorder)
  const host = {
    logger: { warn() {} },
    on() { return () => {} },
    permissionPresets: {
      resolve(name: string) {
        if (!CHOICES.permissionPresets.includes(name)) throw new Error(`unknown permission preset "${name}"`)
        return {}
      },
      set(_session: unknown, name: string) { recorder.permissions.push(name) },
    },
    agentPresets: {
      async resolve(id: string) {
        return id === brokenPreset ? { id, broken: 'missing agent.cordis.yml' } : { id }
      },
      async standingKeyFor() { return 'key' },
      async mount(_agentCtx: unknown, id: string) { recorder.mounted.push(id) },
    },
    workspaceRegistry: {
      async create(path: string) {
        return {
          path,
          async attachSession(id: string) { recorder.attached.push(id) },
          async detachSession(id: string) { recorder.detached.push(id) },
        }
      },
    },
    agentDefaultModel: {
      currentSelection() { return { provider: 'deepseek', model: 'deepseek-chat' } },
    },
    agents: {
      get(id: string) {
        return existing?.mode === 'live' && id === EXISTING_ID ? reopened : undefined
      },
      async resume(options: { resumeSessionId: string; setup: (agentCtx: unknown) => Promise<void> }) {
        recorder.resumed.push(options.resumeSessionId)
        if (existing === undefined || existing.mode === 'missing' || options.resumeSessionId !== EXISTING_ID) {
          throw new Error(`session "${options.resumeSessionId}" not found`)
        }
        await options.setup({ on() { return () => {} } })
        return { agent: reopened, async dispose() { recorder.disposed++ } }
      },
      async create(options: {
        sessionId: string
        meta: unknown
        agentOptions: unknown
        setup: (agentCtx: unknown) => Promise<void>
      }) {
        recorder.created.push({ sessionId: options.sessionId, meta: options.meta, agentOptions: options.agentOptions })
        await options.setup({ on() { return () => {} } })
        return { agent, async dispose() { recorder.disposed++ } }
      },
    },
    sessions: {
      async flush() { recorder.flushed++ },
    },
  }
  return { host: host as unknown as Context, recorder }
}

/** An Agent over a scripted log; each follow-up appends a turn from `script`. */
function scriptedAgent(events: ScriptedEvent[], script: TurnScript, recorder: Recorder) {
  let settle: (() => void) | undefined
  let idle: Promise<void> = Promise.resolve()
  const session = {
    get seq() { return events.length },
    eventAt(seq: number) { return events[seq] },
    requestHeader() { return undefined },
  }
  return {
    session,
    followup(message: { content: unknown; source: unknown }) {
      recorder.prompts.push({ content: message.content, source: message.source })
      events.push({ type: 'turn/start' })
      if (script.kind === 'events') {
        events.push(...script.events)
        return
      }
      idle = new Promise<void>((resolve) => { settle = resolve })
    },
    cancel(cause: unknown) {
      recorder.cancels.push(cause)
      events.push(turnEnd({ kind: 'aborted', reason: cause }))
      settle?.()
    },
    whenIdle() { return idle },
  }
}

/** An in-memory notepad that records every saved value. */
function memoryNotepad(value?: unknown): NodeExecutionContext['notepad'] & { saves: unknown[] } {
  let current = value
  const saves: unknown[] = []
  return {
    saves,
    get value() { return current as never },
    async save(next) { current = next; saves.push(next) },
  }
}

function executionContext(
  inputs: Record<string, unknown>,
  config: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
  notepad: NodeExecutionContext['notepad'] = memoryNotepad(),
): NodeExecutionContext {
  return {
    runId: RunId('run-1'),
    inputs,
    connected: new Set(Object.keys(inputs)),
    invocationKey: 'run-1/ask',
    notepad,
    awaitSignal: async () => { throw new Error('awaitSignal is not used by agent-prompt') },
    config,
    signal,
    log() {},
  }
}

const VALID_CONFIG = { agentPreset: 'minimal', permissionPreset: 'danger-full-access' }

function node(host: Context): WorkflowNodeExecutor {
  return createAgentNode(host, { workspacePath: '/work/project' }, CHOICES)
}

describe('agent-prompt node', () => {
  it('declares its ports and preset controls', () => {
    const { host } = scriptedHost({ kind: 'events', events: [] })
    const executor = node(host)
    assert.equal(executor.type, AGENT_NODE_TYPE)
    assert.deepEqual(executor.inputs?.map(port => port.name), ['prompt'])
    assert.deepEqual(executor.outputs?.map(port => port.name), ['output', 'sessionId'])
    assert.equal(executor.inputs?.[0]?.required, false)
    assert.deepEqual(executor.controls, [
      { name: 'prompt', label: '提示词', kind: 'text', defaultValue: '', placeholder: '发送给 agent 的提示词' },
      {
        name: 'agentPreset',
        label: 'Agent 预设',
        kind: 'select',
        defaultValue: 'standard',
        options: [{ label: 'Standard', value: 'standard' }, { label: 'minimal', value: 'minimal' }],
      },
      {
        name: 'permissionPreset',
        label: '权限',
        kind: 'select',
        defaultValue: 'workspace-write',
        options: [
          { label: 'workspace-write', value: 'workspace-write' },
          { label: 'danger-full-access', value: 'danger-full-access' },
        ],
      },
    ])
  })

  it('rejects a relative workspace path', () => {
    const { host } = scriptedHost({ kind: 'events', events: [] })
    assert.throws(() => createAgentNode(host, { workspacePath: 'project' }, CHOICES), /workspacePath must be absolute/)
  })

  it('runs the prompt in a new Session under the selected preset and returns the final text', async () => {
    const { host, recorder } = scriptedHost({
      kind: 'events',
      events: [assistant('thinking out loud'), assistant(''), assistant('final answer'), turnEnd({ kind: 'completed' })],
    })
    const result = await node(host).execute(executionContext({ prompt: 'summarize README' }, VALID_CONFIG))

    const sessionId = recorder.created[0]?.sessionId
    assert.ok(sessionId?.startsWith('workflow-'))
    assert.deepEqual(result, { status: 'completed', outputs: { output: 'final answer', sessionId } })
    assert.deepEqual(recorder.created[0]?.meta, { cwd: '/work/project', agentPreset: 'minimal' })
    assert.deepEqual(recorder.created[0]?.agentOptions, { provider: 'deepseek', model: 'deepseek-chat' })
    assert.deepEqual(recorder.mounted, ['minimal'])
    assert.deepEqual(recorder.attached, [sessionId])
    assert.deepEqual(recorder.permissions, ['danger-full-access'])
    assert.deepEqual(recorder.prompts, [{
      content: [{ type: 'text', text: 'summarize README' }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME },
    }])
    assert.equal(recorder.flushed, 1)
    assert.equal(recorder.disposed, 1)
    assert.deepEqual(recorder.detached, [])
  })

  it('uses the card prompt when the input is not connected and the input when it is', async () => {
    const run = async (inputs: Record<string, unknown>): Promise<unknown> => {
      const { host, recorder } = scriptedHost({ kind: 'events', events: [turnEnd({ kind: 'completed' })] })
      await node(host).execute(executionContext(inputs, { ...VALID_CONFIG, prompt: 'card text' }))
      return recorder.prompts[0]?.content
    }
    assert.deepEqual(await run({}), [{ type: 'text', text: 'card text' }])
    assert.deepEqual(await run({ prompt: 'upstream text' }), [{ type: 'text', text: 'upstream text' }])
  })

  it('fails with the model error and keeps partial output', async () => {
    const { host, recorder } = scriptedHost({
      kind: 'events',
      events: [
        assistant('partial'),
        turnEnd({ kind: 'error', error: { code: 'rate_limited', message: 'slow down' } }),
      ],
    })
    const result = await node(host).execute(executionContext({ prompt: 'go' }, VALID_CONFIG))
    assert.deepEqual(result, {
      status: 'failed',
      error: 'rate_limited: slow down',
      outputs: { output: 'partial', sessionId: recorder.created[0]?.sessionId },
    })
    assert.equal(recorder.disposed, 1)
  })

  it('reports other turn-end reasons as failures', async () => {
    const { host } = scriptedHost({ kind: 'events', events: [turnEnd({ kind: 'max-tokens' })] })
    const result = await node(host).execute(executionContext({ prompt: 'go' }, VALID_CONFIG))
    assert.equal(result.status, 'failed')
    assert.match((result as Extract<NodeExecutionResult, { status: 'failed' }>).error, /"max-tokens"/)
  })

  it('rejects malformed input and config before creating a Session', async () => {
    const { host, recorder } = scriptedHost({ kind: 'events', events: [] })
    const executor = node(host)
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, RegExp]> = [
      [{}, VALID_CONFIG, /prompt text must be a non-empty string/],
      [{}, { ...VALID_CONFIG, prompt: '   ' }, /prompt text must be a non-empty string/],
      [{ prompt: 42 }, { ...VALID_CONFIG, prompt: 'card text' }, /prompt input must be a non-empty string/],
      [{ prompt: 'go' }, { permissionPreset: 'workspace-write' }, /agentPreset must be/],
      [{ prompt: 'go' }, { agentPreset: 'standard' }, /permissionPreset must be/],
    ]
    for (const [inputs, config, error] of cases) {
      const result = await executor.execute(executionContext(inputs, config))
      assert.equal(result.status, 'failed')
      assert.match((result as Extract<NodeExecutionResult, { status: 'failed' }>).error, error)
    }
    assert.deepEqual(recorder.created, [])
  })

  it('fails for an unknown permission preset or broken agent preset without creating a Session', async () => {
    const { host, recorder } = scriptedHost({ kind: 'events', events: [] }, 'standard')
    const executor = node(host)
    await assert.rejects(
      Promise.resolve(executor.execute(executionContext({ prompt: 'go' }, { ...VALID_CONFIG, permissionPreset: 'root' }))),
      /^Error: unknown permission preset "root"$/,
    )
    const broken = await executor.execute(executionContext({ prompt: 'go' }, { ...VALID_CONFIG, agentPreset: 'standard' }))
    assert.deepEqual(broken, {
      status: 'failed',
      error: 'agent preset "standard" cannot compose a Session: missing agent.cordis.yml',
    })
    assert.deepEqual(recorder.created, [])
  })

  it('rejects a notepad value it did not save without creating a Session', async () => {
    const { host, recorder } = scriptedHost({ kind: 'events', events: [] })
    await assert.rejects(
      Promise.resolve(node(host).execute(executionContext({ prompt: 'go' }, VALID_CONFIG, undefined, memoryNotepad({ sessionId: 1 })))),
      /agent node notepad is malformed/,
    )
    assert.deepEqual(recorder.created, [])
  })

  it('cancels the active turn and disposes the Agent when the run is aborted', async () => {
    const { host, recorder } = scriptedHost({ kind: 'hang' })
    const controller = new AbortController()
    const pending = node(host).execute(executionContext({ prompt: 'go' }, VALID_CONFIG, controller.signal))
    while (recorder.prompts.length === 0) await new Promise(resolve => setImmediate(resolve))
    controller.abort()
    const result = await pending
    assert.deepEqual(recorder.cancels, [{ kind: 'user' }])
    assert.equal(result.status, 'failed')
    assert.match((result as Extract<NodeExecutionResult, { status: 'failed' }>).error, /cancelled \(user\)/)
    assert.equal(recorder.disposed, 1)
  })
})

describe('agent-prompt registration', () => {
  let ctx: Context | undefined

  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  it('registers in the Workflow Studio catalog under this plugin and unregisters on dispose', () => {
    ctx = new Context()
    const registry = new WorkflowNodeRegistry(ctx)
    const { host } = scriptedHost({ kind: 'events', events: [] })
    const dispose = registry.register(node(host), PLUGIN_NAME)
    const summary = registry.listTypes().find(entry => entry.type === AGENT_NODE_TYPE)
    assert.equal(summary?.sourcePlugin, PLUGIN_NAME)
    assert.deepEqual(summary?.inputs.map(port => port.name), ['prompt'])
    dispose()
    assert.equal(registry.get(AGENT_NODE_TYPE), undefined)
  })
})

describe('agent-prompt re-calls', () => {
  const prior = (...events: ScriptedEvent[]): ScriptedEvent[] => [{ type: 'session/start' }, ...events]
  const saved = { sessionId: EXISTING_ID, agentPreset: 'minimal', promptSeq: 1 }

  it('saves the Session, preset, and prompt offset before sending the prompt', async () => {
    const { host, recorder } = scriptedHost({ kind: 'events', events: [turnEnd({ kind: 'completed' })] })
    const notepad = memoryNotepad()
    await node(host).execute(executionContext({ prompt: 'go' }, VALID_CONFIG, undefined, notepad))
    assert.deepEqual(notepad.saves, [{ sessionId: recorder.created[0]?.sessionId, agentPreset: 'minimal', promptSeq: 1 }])
  })

  it('returns a turn that completed before the restart without calling the model again', async () => {
    const { host, recorder } = scriptedHost({ kind: 'hang' }, undefined, {
      mode: 'resume',
      events: prior({ type: 'turn/start' }, assistant('done before'), turnEnd({ kind: 'completed' })),
    })
    const result = await node(host).execute(executionContext({ prompt: 'go' }, VALID_CONFIG, undefined, memoryNotepad(saved)))
    assert.deepEqual(result, { status: 'completed', outputs: { output: 'done before', sessionId: EXISTING_ID } })
    assert.deepEqual(recorder.resumed, [EXISTING_ID])
    assert.deepEqual(recorder.mounted, ['minimal'])
    assert.deepEqual(recorder.prompts, [])
    assert.deepEqual(recorder.created, [])
    assert.equal(recorder.disposed, 1)
  })

  it('continues a turn the restart interrupted', async () => {
    const { host, recorder } = scriptedHost({ kind: 'events', events: [assistant('finished now'), turnEnd({ kind: 'completed' })] }, undefined, {
      mode: 'resume',
      events: prior({ type: 'turn/start' }, assistant('half'), turnEnd({ kind: 'aborted', reason: { kind: 'disposed' } })),
    })
    const result = await node(host).execute(executionContext({ prompt: 'go' }, VALID_CONFIG, undefined, memoryNotepad(saved)))
    assert.deepEqual(result, { status: 'completed', outputs: { output: 'finished now', sessionId: EXISTING_ID } })
    assert.deepEqual(recorder.prompts.map(prompt => prompt.content), [[{ type: 'text', text: CONTINUE_PROMPT }]])
  })

  it('sends the original prompt when the restart came before it was sent', async () => {
    const { host, recorder } = scriptedHost({ kind: 'events', events: [assistant('answer'), turnEnd({ kind: 'completed' })] }, undefined, {
      mode: 'resume',
      events: prior(),
    })
    const result = await node(host).execute(executionContext({ prompt: 'go' }, VALID_CONFIG, undefined, memoryNotepad(saved)))
    assert.equal(result.status, 'completed')
    assert.deepEqual(recorder.prompts.map(prompt => prompt.content), [[{ type: 'text', text: 'go' }]])
  })

  it('uses a Session that is already open without disposing it', async () => {
    const { host, recorder } = scriptedHost({ kind: 'hang' }, undefined, {
      mode: 'live',
      events: prior({ type: 'turn/start' }, assistant('live answer'), turnEnd({ kind: 'completed' })),
    })
    const result = await node(host).execute(executionContext({ prompt: 'go' }, VALID_CONFIG, undefined, memoryNotepad(saved)))
    assert.deepEqual(result, { status: 'completed', outputs: { output: 'live answer', sessionId: EXISTING_ID } })
    assert.deepEqual(recorder.resumed, [])
    assert.equal(recorder.disposed, 0)
  })

  it('starts a new Session when the saved one cannot be reopened', async () => {
    const { host, recorder } = scriptedHost({ kind: 'events', events: [assistant('fresh'), turnEnd({ kind: 'completed' })] }, undefined, {
      mode: 'missing',
      events: [],
    })
    const notepad = memoryNotepad(saved)
    const result = await node(host).execute(executionContext({ prompt: 'go' }, VALID_CONFIG, undefined, notepad))
    assert.equal(result.status, 'completed')
    assert.equal(recorder.created.length, 1)
    assert.equal((notepad.value as { sessionId: string }).sessionId, recorder.created[0]?.sessionId)
  })
})
