import { Plugin } from "@opencode/plugin"

// 分会话隔离只依赖此前缀加 sessionID；换插件 ID 或目录都不提供隔离（实测约束）。
const PREFIX = "handoff:state:"
const INTERVAL = 3 // 第 3 次自动压缩后首次评估，后续冷却同为 3

const key = (sessionID: string) => `${PREFIX}${sessionID}`

interface Proposal {
  id: string
  promptId: string | null
  reason: "count" | "stage" | "confusion" | "checkpoint"
  stageKey: string
  causeKey: string | null
  notice: string
  counted: boolean
  finalDelivered: boolean
  retryUsed: boolean
  finalMissed: boolean
  closed: boolean
}

interface Evaluation {
  promptId: string | null
  autoCount: number
  decision: "defer" | "skip" | "remind"
  note: string
  nextCheck: "next_turn" | "next_compaction"
}

interface State {
  autoCount: number
  nextReminderAt: number
  muted: boolean
  response: string | null
  lastNotifiedAt: number | null
  reminderCount: number
  stageKeys: string[]
  confusionKeys: string[]
  proposal: Proposal | null
  deferUntil: string | null
  evaluation: Evaluation | null
  activePromptId: string | null
}

function fresh(): State {
  return {
    autoCount: 0,
    nextReminderAt: INTERVAL,
    muted: false,
    response: null,
    lastNotifiedAt: null,
    reminderCount: 0,
    stageKeys: [],
    confusionKeys: [],
    proposal: null,
    deferUntil: null,
    evaluation: null,
    activePromptId: null,
  }
}

async function load(ctx: Plugin.Context, sessionID: string): Promise<State> {
  const raw = (await ctx.storage.get(key(sessionID))) as Record<string, unknown> | undefined
  if (!raw) return fresh()
  // 兼容早期探针的 snake_case 形态，保留已计数的压缩数。
  const migrated: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    migrated[camel] = v
  }
  return { ...fresh(), ...(migrated as Partial<State>) }
}

async function save(ctx: Plugin.Context, sessionID: string, state: State) {
  await ctx.storage.set(key(sessionID), JSON.parse(JSON.stringify(state)) as never)
}

// ---------- 评估到期 ----------
function evaluationDue(s: State): boolean {
  if (s.muted || s.deferUntil || s.autoCount < s.nextReminderAt) return false
  const ev = s.evaluation
  if (!ev || ev.autoCount < s.autoCount) return true
  return ev.nextCheck === "next_turn" && ev.promptId !== s.activePromptId
}

const isOpen = (p: Proposal | null): p is Proposal => !!p && !p.closed && !p.finalDelivered

function recordReady(s: State) {
  s.evaluation = {
    promptId: s.activePromptId,
    autoCount: s.autoCount,
    decision: "remind",
    note: "已核实安全位置、后续及适用触发条件",
    nextCheck: "next_compaction",
  }
}

// ---------- 注入文本 ----------
function injection(s: State): string | null {
  if (s.autoCount === 0 && !s.proposal && !s.muted) return null
  const open = isOpen(s.proposal)
  const due = evaluationDue(s)
  if (!(s.muted || s.deferUntil || open || due)) {
    const line =
      s.autoCount < s.nextReminderAt
        ? `冷却至第${s.nextReminderAt}次压缩，期间不提醒。`
        : "本压缩点已评估；进入新的实质阶段时再按 project-handoff 评估。"
    return `project-handoff：自动压缩${s.autoCount}次；${line}`
  }
  let base = `project-handoff：自动压缩${s.autoCount}次；最终文本提醒${s.reminderCount}次；`
  if (s.lastNotifiedAt !== null) base += `提醒冷却参考第${s.lastNotifiedAt}次压缩。`
  let body: string
  if (s.muted) {
    body = "本任务主动提醒已关闭；显式交接或恢复提醒请求仍执行。"
  } else if (s.deferUntil) {
    body = `等待用户指定节点${s.deferUntil}；节点到达才评估，普通次数不催促。`
  } else if (open) {
    body =
      "存在尚未最终展示的建议。先核对最新回应：仍适用则按原标识重新 prepare，放在最终正文最前；" +
      "不适用则 evaluate 或 cancel。进度消息不算展示。"
  } else {
    body =
      "本次压缩检查点待评估：最终答复前执行 prepare 或 evaluate。prepare 成功才提醒；" +
      "不提醒须记录原因及下次检查时机。首次到三次需安全位置和后续；再次提醒还需新阶段与具体收益。"
  }
  return (
    base +
    body +
    "执行前读取 project-handoff 技能说明。新且已核实的混淆先纠正，可提前提醒；同一问题去重，静默优先。" +
    "纯问答、无后续或讨论本技能不提醒。注入不算送达，普通继续不算交接批准。"
  )
}

// ---------- 最终核验 ----------
function finalContainsNotice(message: string, notice: string): boolean {
  if (!message) return false
  const lines: string[] = []
  let fenced = false
  for (const line of message.split("\n")) {
    if (line.trimStart().startsWith("```") || line.trimStart().startsWith("~~~")) fenced = !fenced
    else if (!fenced && !line.trimStart().startsWith(">")) lines.push(line)
  }
  const norm = (v: string) => v.replace(/[\s*`_]/g, "")
  const paras = lines
    .join("\n")
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
  return paras.length > 0 && norm(paras[0]) === norm(notice)
}

function receipt(s: State, p: Proposal) {
  p.finalDelivered = true
  if (!p.counted) {
    p.counted = true
    s.reminderCount += 1
    s.lastNotifiedAt = s.autoCount
    s.nextReminderAt = Math.max(s.nextReminderAt, s.autoCount + INTERVAL)
    if (!s.stageKeys.includes(p.stageKey)) s.stageKeys.push(p.stageKey)
    if (p.reason === "confusion" && p.causeKey) s.confusionKeys.push(p.causeKey)
  }
}

// ---------- 参数校验 ----------
function str(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`missing or invalid ${label}`)
  return value.trim()
}

function proposalId(s: State, reason: string, stageKey: string, causeKey: string | null): string {
  const input = [s.activePromptId ?? "", String(s.autoCount), reason, stageKey, causeKey ?? ""].join("|")
  let h = 2166136261
  for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 16777619) >>> 0
  return h.toString(16).padStart(8, "0")
}

// ---------- 工具逻辑 ----------
function doEvaluate(s: State, input: Record<string, unknown>) {
  const decision = input.outcome as Evaluation["decision"]
  const nextCheck = input.next_check as Evaluation["nextCheck"]
  const note = str(input.note, "evaluation note")
  if (decision !== "defer" && decision !== "skip")
    throw new Error("choose defer or skip")
  if (nextCheck !== "next_turn" && nextCheck !== "next_compaction")
    throw new Error("choose next_turn or next_compaction")
  s.evaluation = { promptId: s.activePromptId, autoCount: s.autoCount, decision, note, nextCheck }
  if (isOpen(s.proposal)) s.proposal!.closed = true
  return { evaluated: true, evaluation: s.evaluation }
}

function doPrepare(s: State, input: Record<string, unknown>) {
  const reason = input.reason as Proposal["reason"]
  const stageKey = str(input.stage_key, "stage_key")
  const notice = typeof input.notice === "string" ? input.notice.trim() : ""
  const safe = input.safe === true
  const hasNext = input.has_next === true
  const benefit = input.benefit === true
  const causeKey = input.cause_key ? str(input.cause_key, "cause_key") : null
  if (!["count", "stage", "confusion", "checkpoint"].includes(reason))
    return { prepared: false, why: "invalid_reason" }
  if (!notice.startsWith("交接建议：") || notice.length < 20 || notice.length > 600 || notice.includes("\n"))
    return { prepared: false, why: "invalid_notice" }
  if (s.muted || !safe || !hasNext) return { prepared: false, why: "muted_or_not_ready" }

  const old = s.proposal
  // 复用未送达的同一建议：重贴同一 ID 与计数。
  if (
    old &&
    !old.closed &&
    !old.finalDelivered &&
    old.stageKey === stageKey &&
    old.reason === reason &&
    old.causeKey === causeKey
  ) {
    old.promptId = s.activePromptId
    old.notice = notice
    recordReady(s)
    return { prepared: true, proposal: old }
  }
  if (s.deferUntil && reason !== "checkpoint" && reason !== "confusion")
    return { prepared: false, why: "waiting_for_user_checkpoint" }

  if (reason === "confusion") {
    if (!causeKey || s.confusionKeys.includes(causeKey) || !benefit)
      return { prepared: false, why: "same_confusion_or_no_benefit" }
  } else if (reason === "checkpoint") {
    if (!s.deferUntil || input.checkpoint_key !== s.deferUntil)
      return { prepared: false, why: "checkpoint_not_matched" }
  } else {
    const hasPrior = s.lastNotifiedAt !== null || s.stageKeys.length > 0
    if (s.stageKeys.includes(stageKey)) return { prepared: false, why: "same_work_stage" }
    if (reason === "count") {
      if (hasPrior || s.autoCount < s.nextReminderAt)
        return { prepared: false, why: "count_only_is_first_reminder" }
    } else if (!benefit) {
      return { prepared: false, why: "no_switching_benefit" }
    }
    if (hasPrior && s.autoCount < s.nextReminderAt) return { prepared: false, why: "cooldown" }
  }

  const proposal: Proposal = {
    id: proposalId(s, reason, stageKey, causeKey),
    promptId: s.activePromptId,
    reason,
    stageKey,
    causeKey,
    notice,
    counted: false,
    finalDelivered: false,
    retryUsed: false,
    finalMissed: false,
    closed: false,
  }
  s.proposal = proposal
  s.response = "pending"
  recordReady(s)
  if (reason === "checkpoint") s.deferUntil = null
  return { prepared: true, proposal }
}

function doRespond(s: State, input: Record<string, unknown>) {
  const response = input.response as string
  if (!["continue", "defer", "mute", "handoff", "resume"].includes(response))
    throw new Error("invalid response")
  if (response !== "mute" && response !== "resume") {
    const p = s.proposal
    if (!p || input.proposal_id !== p.id || p.closed)
      throw new Error("response must identify the current open proposal")
  }
  if (response === "defer") {
    s.deferUntil = str(input.checkpoint_key, "checkpoint_key")
  } else if (response !== "resume") {
    s.deferUntil = null
  }
  s.response = response
  if (response === "mute" || response === "handoff") s.muted = true
  else if (response === "resume") s.muted = false
  else s.nextReminderAt = Math.max(s.nextReminderAt, s.autoCount + INTERVAL)
  if (s.proposal) {
    s.proposal.closed = true
    if (!s.stageKeys.includes(s.proposal.stageKey)) s.stageKeys.push(s.proposal.stageKey)
  }
  return { responded: true, response }
}

// ---------- 插件 ----------
// 每会话最近一次助手文本：session.idle 时用于核验首段是否等于建议。
const textAcc = new Map<string, { msgId: string; parts: Record<number, string> }>()
const subagentCache = new Map<string, boolean>()
// 开发诊断：最近观察到的事件类型与核验结果
const eventLog: string[] = []

export default Plugin.define({
  id: "project-handoff",
  async setup(ctx) {
    const dev = ctx.options.dev === true

    async function isSubagent(sessionID: string): Promise<boolean> {
      const cached = subagentCache.get(sessionID)
      if (cached !== undefined) return cached
      try {
        const info = await ctx.session.get({ sessionID })
        const flag = !!(info as { parentID?: unknown }).parentID
        subagentCache.set(sessionID, flag)
        return flag
      } catch {
        return false
      }
    }

    // 回合身份：prompt 的 messageID 由宿主注入
    await ctx.session.hook("prompt", async (event) => {
      const s = await load(ctx, event.sessionID)
      s.activePromptId = event.messageID
      await save(ctx, event.sessionID, s)
    })

    // 上下文注入：四态
    await ctx.session.hook("context", async (event) => {
      if (await isSubagent(event.sessionID)) return
      const s = await load(ctx, event.sessionID)
      const text = injection(s)
      if (text) event.system.push({ type: "text", text })
    })

    // 工具
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "project_handoff", description: "项目交接：压缩计数、评估与提醒登记" })
      editor.add({
        name: "status",
        description: "返回当前会话的 project-handoff 状态",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => {
          const s = await load(ctx, context.sessionID)
          return { content: JSON.stringify({ sessionID: context.sessionID, ...s }) }
        },
      })
      editor.add({
        name: "evaluate",
        description: "登记压缩检查点的评估结果：defer 暂缓或 skip 不适用",
        input: {
          type: "object",
          properties: {
            outcome: { type: "string", enum: ["defer", "skip"] },
            note: { type: "string", maxLength: 160 },
            next_check: { type: "string", enum: ["next_turn", "next_compaction"] },
          },
          required: ["outcome", "note", "next_check"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const s = await load(ctx, context.sessionID)
          const r = doEvaluate(s, input as Record<string, unknown>)
          await save(ctx, context.sessionID, s)
          return { content: JSON.stringify(r) }
        },
      })
      editor.add({
        name: "prepare",
        description: "准备一条交接建议；成功才可在最终答复首段展示",
        input: {
          type: "object",
          properties: {
            reason: { type: "string", enum: ["count", "stage", "confusion", "checkpoint"] },
            stage_key: { type: "string" },
            notice: { type: "string" },
            safe: { type: "boolean" },
            has_next: { type: "boolean" },
            benefit: { type: "boolean" },
            cause_key: { type: "string" },
            checkpoint_key: { type: "string" },
          },
          required: ["reason", "stage_key", "notice", "safe", "has_next"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const s = await load(ctx, context.sessionID)
          let r: unknown
          try {
            r = doPrepare(s, input as Record<string, unknown>)
          } catch (error) {
            r = { prepared: false, why: String((error as Error).message) }
          }
          await save(ctx, context.sessionID, s)
          return { content: JSON.stringify(r) }
        },
      })
      editor.add({
        name: "respond",
        description: "登记用户对交接建议的回应：continue/defer/mute/handoff/resume",
        input: {
          type: "object",
          properties: {
            response: { type: "string", enum: ["continue", "defer", "mute", "handoff", "resume"] },
            proposal_id: { type: "string" },
            checkpoint_key: { type: "string" },
          },
          required: ["response"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const s = await load(ctx, context.sessionID)
          let r: unknown
          try {
            r = doRespond(s, input as Record<string, unknown>)
          } catch (error) {
            r = { responded: false, why: String((error as Error).message) }
          }
          await save(ctx, context.sessionID, s)
          return { content: JSON.stringify(r) }
        },
      })
      if (dev) {
        editor.add({
          name: "seed",
          description: "开发用：直接写入指定状态字段，构造边界场景",
          input: {
            type: "object",
            properties: {
              autoCount: { type: "number" },
              nextReminderAt: { type: "number" },
              muted: { type: "boolean" },
              reminderCount: { type: "number" },
              lastNotifiedAt: { type: ["number", "null"] },
              stageKeys: { type: "array", items: { type: "string" } },
              confusionKeys: { type: "array", items: { type: "string" } },
              proposal: { type: ["object", "null"] },
              deferUntil: { type: ["string", "null"] },
              evaluation: { type: ["object", "null"] },
            },
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const s = { ...fresh(), ...(input as Partial<State>) }
            await save(ctx, context.sessionID, s)
            return { content: JSON.stringify({ seeded: true, state: s }) }
          },
        })
        editor.add({
          name: "preview",
          description: "开发用：直接返回当前状态会生成的注入文本，不经过模型",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async (_input, context) => {
            const s = await load(ctx, context.sessionID)
            return { content: JSON.stringify({ injection: injection(s), evaluationDue: evaluationDue(s) }) }
          },
        })
        editor.add({
          name: "eventlog",
          description: "开发用：返回最近观察到的事件与核验结果",
          input: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => ({ content: JSON.stringify(eventLog) }),
        })
      }
    })

    // 事件流
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (dev && (event.type === "session.execution.succeeded" || event.type === "session.execution.failed")) {
          eventLog.push(`EXEC ${event.type} ${event.data.sessionID}`)
          if (eventLog.length > 60) eventLog.shift()
        }
        if (event.type === "session.compaction.ended") {
          if (event.data.reason !== "auto") continue
          const sessionID = event.data.sessionID
          if (await isSubagent(sessionID)) continue
          const s = await load(ctx, sessionID)
          s.autoCount += 1
          await save(ctx, sessionID, s)
        } else if (event.type === "session.text.ended") {
          const { sessionID, assistantMessageID, ordinal, text } = event.data
          eventLog.push(`text.ended ${sessionID} msg=${assistantMessageID} ord=${ordinal} len=${text.length}`)
          if (eventLog.length > 40) eventLog.shift()
          const acc = textAcc.get(sessionID)
          if (!acc || acc.msgId !== assistantMessageID) {
            textAcc.set(sessionID, { msgId: assistantMessageID, parts: { [ordinal]: text } })
          } else {
            acc.parts[ordinal] = text
          }
        } else if (event.type === "session.execution.succeeded") {
          const sessionID = event.data.sessionID
          eventLog.push(`exec.succeeded ${sessionID} acc=${textAcc.has(sessionID)}`)
          if (eventLog.length > 60) eventLog.shift()
          const acc = textAcc.get(sessionID)
          if (!acc) continue
          textAcc.delete(sessionID)
          const s = await load(ctx, sessionID)
          const p = s.proposal
          if (!isOpen(p)) continue
          const joined = Object.keys(acc.parts)
            .sort((a, b) => Number(a) - Number(b))
            .map((k) => acc.parts[Number(k)])
            .join("")
          if (finalContainsNotice(joined, p.notice)) {
            receipt(s, p)
            p.retryUsed = false
            p.finalMissed = false
            eventLog.push(`receipt OK ${sessionID}`)
          } else if (p.retryUsed) {
            p.finalMissed = true
            p.closed = true
            eventLog.push(`target missed FINAL ${sessionID}`)
          } else {
            p.retryUsed = true
            eventLog.push(`target missed retry ${sessionID} first=${JSON.stringify(joined.slice(0, 40))}`)
          }
          if (eventLog.length > 40) eventLog.length = 40
          await save(ctx, sessionID, s)
        } else if (event.type === "session.deleted") {
          textAcc.delete(event.data.sessionID)
          subagentCache.delete(event.data.sessionID)
          await ctx.storage.remove(key(event.data.sessionID))
        }
      }
    })()

    return () => controller.abort()
  },
})
