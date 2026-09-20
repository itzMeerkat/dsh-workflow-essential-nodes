/**
 * `human-approval` 节点：暂停工作流中的这一步，直到有人批准或拒绝。
 * @module dsh-workflow-demo-node
 */

import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  APPROVE_LABEL, NodeFailure, REJECT_LABEL, answerComment, askUser, isApproved,
  toFailureResult, validateQuestionsSignal,
} from 'dsh-workflow-studio'
import type {
  NodeControlDefinition, NodeExecutionContext, NodeExecutionResult, PortDefinition, WorkflowNodeExecutor,
} from 'dsh-workflow-studio'

/** 审批请求的请求 ID；节点被重新调用时复用同一请求。 */
export const APPROVAL_REQUEST_ID = 'approval'

/** 审批请求中唯一问题的 ID。 */
export const APPROVAL_QUESTION_ID = 'decision'

/** 未配置问题时使用的问题文本。 */
export const DEFAULT_APPROVAL_QUESTION = '是否批准继续执行？'

/** 审批详情中输入值 JSON 的最大字符数。 */
const DETAIL_LIMIT = 4000

/** 批准后继续执行的引脚。 */
export const APPROVED_PIN = 'approved'

/** 拒绝后继续执行的引脚。 */
export const REJECTED_PIN = 'rejected'

/** 审批节点的输出；两个端口在完成时都有值，不适用的写 null。 */
type ApprovalOutputs = {
  output: unknown
  comment: string | null
} & Record<string, unknown>

function inputDetail(context: NodeExecutionContext): string | undefined {
  if (!Object.hasOwn(context.inputs, 'input')) return undefined
  const json = JSON.stringify(context.inputs.input, null, 2)
  return json.length <= DETAIL_LIMIT ? json : `${json.slice(0, DETAIL_LIMIT)}\n…`
}

/**
 * 请人批准后再继续。
 *
 * 审批结果是一次分支决定，由执行引脚表达：批准触发 {@link APPROVED_PIN} 并原样传递 `input`，
 * 拒绝触发 {@link REJECTED_PIN}。自定义文本回答视为拒绝，其文本作为 `comment`。
 * 两种结果都是节点正常完成——被拒绝的审批是流程的答案，不是流程的故障；未接线的引脚
 * 让那条路径上的节点被跳过。
 */
export class HumanApprovalNode implements WorkflowNodeExecutor {
  readonly type = 'human-approval'
  readonly label = '人工审批'
  readonly description = '等待人工批准或拒绝，并触发 approved 或 rejected 执行引脚'
  readonly inputs: readonly PortDefinition[] = [
    { name: 'input', type: 'any', description: '展示给审批人的值；批准后原样输出', required: false },
  ]
  readonly outputs: readonly PortDefinition[] = [
    { name: 'output', type: 'any', description: '批准时传递的输入值；拒绝时为 null', display: 'json' },
    { name: 'comment', type: 'string', description: '审批人填写的自定义说明', display: 'value' },
  ]
  readonly execOutputs: readonly string[] = [APPROVED_PIN, REJECTED_PIN]
  /** 审批答案必须匹配节点提出的问题；格式错误在提交时被拒绝，而不是使节点失败。 */
  readonly validateSignal = validateQuestionsSignal
  readonly controls: readonly NodeControlDefinition[] = [
    {
      name: 'question',
      label: '问题',
      kind: 'text',
      defaultValue: DEFAULT_APPROVAL_QUESTION,
      placeholder: DEFAULT_APPROVAL_QUESTION,
    },
  ]

  /**
   * 提问并按回答触发 {@link APPROVED_PIN} 或 {@link REJECTED_PIN}。
   *
   * 分支结果随本次调用一起返回，不保存在执行器实例上：注册表中每个节点类型只有一个实例，
   * 同一实例会被并发的多个运行共用。
   * @param context - 引擎提供的执行上下文。
   * @returns 完成结果及本次触发的执行引脚；配置非法时为失败结果。
   */
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    try {
      const { outputs, next } = await this.decide(context)
      return { status: 'completed', outputs, next: [next] }
    } catch (error: unknown) {
      return toFailureResult(error)
    }
  }

  private async decide(context: NodeExecutionContext): Promise<{ outputs: ApprovalOutputs; next: string }> {
    const question = context.config.question ?? DEFAULT_APPROVAL_QUESTION
    if (typeof question !== 'string' || question.trim() === '') {
      throw new NodeFailure('question 必须为非空字符串')
    }
    const detail = inputDetail(context)
    const item: AskUserQuestionItem = {
      id: APPROVAL_QUESTION_ID,
      header: '人工审批',
      question,
      ...(detail === undefined ? {} : { detail }),
      options: [{ label: APPROVE_LABEL }, { label: REJECT_LABEL }],
    }
    const answer = await askUser(context, APPROVAL_REQUEST_ID, [item])
    const text = answerComment(answer, APPROVAL_QUESTION_ID)
    // Every declared output port carries a value on completion; null marks the ones that do not apply.
    const base = { output: null, comment: text ?? null }
    return isApproved(answer, APPROVAL_QUESTION_ID)
      ? { outputs: { ...base, output: context.inputs.input ?? null }, next: APPROVED_PIN }
      : { outputs: base, next: REJECTED_PIN }
  }
}
