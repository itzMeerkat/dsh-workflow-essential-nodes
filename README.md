---
description: "Example Workflow Studio nodes: an agent-prompt node, a human-approval node, and basic value, arithmetic, branch, merge, and output nodes."
kind: "package-bundle"
---

# dsh-workflow-demo-node

## Summary

`dsh-workflow-demo-node` supplies every node that [Workflow Studio](../dsh-workflow-studio/README.md) offers; Studio itself registers none. One Cordis plugin registers seven nodes, all built on Studio's `WorkflowNode` base class:

| Type | Label | Purpose |
|---|---|---|
| `agent-prompt` | Agent 提示词 | Run a prompt in a new agent Session under a selected agent preset and output the final reply |
| `human-approval` | 人工审批 | Pause until a person approves or rejects |
| `input` | 输入 | Output a configured number |
| `arithmetic` | 四则运算 | Add, subtract, multiply, or divide two numbers |
| `compare` | 条件判断 | Evaluate an expression over two inputs and output a boolean |
| `output` | 输出 | Collect a final value |

Execution order and branching are Studio's, not this plugin's: feed `compare`'s boolean into Studio's `branch` node and wire its `true` and `false` execution pins to the nodes each path should run. A node runs when every incoming execution edge has fired, so a node with none runs whenever the run reaches it.

## Install

The plugin requires a profile that already includes Workflow Studio and the Web app bundle. From this directory, build the package and link it into that profile:

```sh
pnpm install
dsh plugin --profile <name> add /path/to/dsh-workflow-demo-node
```

`pnpm install` runs `prepare`, which builds `lib/`. The profile loads `lib/` directly from this checkout, so after editing the source, run `pnpm build` and restart the profile.

## `agent-prompt`

When the node runs, it starts a new agent Session composed from the selected agent preset, sends the prompt, waits for the turn to end, and outputs the last non-empty assistant text. Each run leaves an ordinary persisted Session in the configured workspace, where it can be opened, inspected, and continued in the Web UI.

| Item | Name | Type | Meaning |
|---|---|---|---|
| Control | `prompt` | text | Prompt sent to the agent when the `prompt` input is not connected |
| Control | `agentPreset` | select | Agent preset that composes the new Session; defaults to the Host's effective default preset |
| Control | `permissionPreset` | select | Permission preset applied to the new Session; defaults to the Host's default permission preset |
| Input | `prompt` | `string`, optional | Prompt from an upstream node; when connected, it replaces the card's prompt text |
| Output | `output` | `string` | Last non-empty assistant text of the turn |
| Output | `sessionId` | `string` | Session that ran the prompt |

The node fails when the prompt is empty, the agent preset is broken, the permission preset is unknown, or the turn ends with any reason other than `completed`. A failed result still reports `sessionId` and any partial `output`. Cancelling the workflow run cancels the agent's active turn.

The preset and permission choices are read when the plugin starts. Restart the profile to offer presets created later.

### After a Host restart

Workflow Studio calls a node that was running when the Host stopped again. Before sending the prompt, this node saves the Session ID, the agent preset, and the Session log position in its notepad, so a repeated call reopens that Session instead of starting a new one:

| State of the reopened Session | What the node does |
|---|---|
| The prompt's turn completed | Returns that turn's reply without calling the model |
| The prompt's turn ended with a model error | Fails with that error |
| The prompt's turn was interrupted | Sends one continue message and returns the reply to it |
| The prompt was never sent | Sends the prompt |
| The Session cannot be loaded | Starts a new Session |

A Session that is already open in the Web UI is used as is and left open.

## `human-approval`

The node pauses its step of the workflow until a person decides. It asks its `question` through Studio's `askUser`, which raises a `questions` request with the options `批准` and `拒绝`, and shows the optional `input` value to the approver as JSON. The request appears in the panel's **Runs** tab, rendered by Studio's built-in question form, and survives Host restarts. The node declares `validateSignal`, so an answer that does not match its question is rejected when submitted.

| Item | Name | Type | Meaning |
|---|---|---|---|
| Control | `question` | text | Question shown to the approver; defaults to `是否批准继续执行？` |
| Input | `input` | `any`, optional | Value shown to the approver and passed through on approval |
| Output | `output` | `any` | The `input` value on approval, `null` otherwise |
| Output | `comment` | `string` | Custom text the approver entered, `null` when none |
| Execution pin | `approved` | | Fires on approval |
| Execution pin | `rejected` | | Fires on rejection |

`拒绝`, or a custom text answer, rejects, and the text becomes `comment`. Either answer completes the node: a rejected approval is the process's answer, not a malfunction. The decision reaches the graph through the execution pins, so each path runs behind its own execution edge, and leaving `rejected` unwired simply skips everything on that path.

## Basic nodes

- `input` outputs `config.defaultValue` (default `0`) and fails when it is not a finite number.
- `arithmetic` applies `config.operator` (`add`, `subtract`, `multiply`, or `divide`) to the numeric `left` and `right` inputs and outputs `result`; division by zero fails.
- `compare` evaluates `config.expression` (default `left === right`) as a JEXL expression over the required `left` and `right` inputs of type `any`, then outputs the boolean `result`. Expressions support JavaScript-style comparison, arithmetic, property access, `&&`, `||`, `!`, and ternary operators, including `===` and `!==`. The evaluator exposes no Host globals or functions, rejects statements and assignment, and requires a boolean result. Feed `result` into Studio's `branch` node to fork execution.
- `output` passes its `input` through as `output` and logs it.

## Configuration

| Field | Default in `cordis.patch.yml` | Meaning |
|---|---|---|
| `workspacePath` | `process.cwd()`, the directory `dsh` was launched from | Absolute workspace directory for every Session an `agent-prompt` node starts |

Override it in the profile's `cordis.patch.yml`:

```yaml
- id: workflow-demo-node
  config:
    workspacePath: /absolute/path/to/workspace
```

The plugin injects the Agent, agent preset, default model, permission preset, Session, and workspace services that `agent-prompt` uses, so it loads only in a composition that provides them, such as the Web app profile.

## Model Experience

A Session started by `agent-prompt` receives the prompt as its first user message, with the system prompt, tools, and skills of the selected agent preset. It sees no workflow state other than the prompt text. When a restart interrupted the prompt's turn, the reopened Session also receives this user message, sourced from `dsh-workflow-demo-node`: "The previous turn was interrupted before it finished because the workflow Host restarted. Continue the original task and give your final answer." Its model is the Host's current default model selection. Tool calls follow the selected permission preset: under a preset whose approval policy asks, the turn waits until someone answers the approval in that Session's Web view. The other nodes send nothing to a model.

## Known Limitations

- `agent-prompt` always uses the Host's default model; it has no per-node model control.
- The Harness subagent service composes a child under its parent's preset and requires a parent Agent, so `agent-prompt` starts an independent root Session instead of a subagent. The Session is not linked to the Session that ran `run_workflow`.
- `agent-prompt` returns plain text; structured output is not supported.
- A `human-approval` approver cannot approve with a comment: a custom text answer replaces the selected option and counts as rejection.

## Development

```sh
pnpm test
pnpm typecheck
pnpm build
```

The nodes extend `WorkflowNode`, so `dsh-workflow-studio` is a peer dependency; the dev dependency links `../dsh-workflow-studio`, which must be present and built. `agent-prompt` tests run against scripted Host services; `human-approval` tests run workflows through a real Studio engine with JSON storage in a temporary directory.
