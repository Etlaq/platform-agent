import {
  BUILD_PHASE_PROMPT_APPENDIX,
  PLAN_PHASE_PROMPT_APPENDIX,
} from './runtime/config'

export interface PlanTodoItem {
  id: string
  title: string
  details?: string
  acceptanceCriteria?: string[]
}

export interface PlanSnapshot {
  summary: string
  todos: PlanTodoItem[]
  raw: string
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed) out.push(trimmed)
  }
  return out
}

export function parseJsonCandidates(raw: string) {
  const candidates: string[] = []
  const fenced = /```json\s*([\s\S]*?)```/gi
  for (let match = fenced.exec(raw); match; match = fenced.exec(raw)) {
    candidates.push(match[1] ?? '')
  }
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    candidates.push(trimmed)
  }
  return candidates
}

export function normalizeTodo(value: unknown, index: number): PlanTodoItem | null {
  const obj = asRecord(value)
  if (!obj) return null
  const title =
    toNonEmptyString(obj.title) ??
    toNonEmptyString(obj.task) ??
    toNonEmptyString(obj.todo) ??
    toNonEmptyString(obj.name)
  if (!title) return null
  const id = toNonEmptyString(obj.id) ?? String(index + 1)
  const details = toNonEmptyString(obj.details) ?? toNonEmptyString(obj.description) ?? undefined
  const acceptanceCriteria = toStringArray(obj.acceptanceCriteria)
  return {
    id,
    title,
    ...(details ? { details } : {}),
    ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
  }
}

export function parseMarkdownTodos(raw: string): PlanTodoItem[] {
  const lines = raw.split(/\r?\n/)
  const todos: PlanTodoItem[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = /^[-*]\s+(?:\[\s?\]\s+)?(.+)$/.exec(trimmed) ?? /^(\d+)\.\s+(.+)$/.exec(trimmed)
    if (!match) continue

    const title = (match[2] ?? match[1] ?? '').trim()
    if (!title) continue
    todos.push({
      id: String(todos.length + 1),
      title,
    })
  }

  return todos
}

export function firstSentence(raw: string) {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) continue
    return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed
  }
  return ''
}

export function buildFallbackPlan(raw: string, prompt: string): PlanSnapshot {
  const parsedTodos = parseMarkdownTodos(raw)
  if (parsedTodos.length > 0) {
    return {
      summary: firstSentence(raw) || `Execution plan for: ${prompt.slice(0, 120)}`,
      todos: parsedTodos,
      raw,
    }
  }

  return {
    summary: firstSentence(raw) || `Execution plan for: ${prompt.slice(0, 120)}`,
    todos: [
      {
        id: '1',
        title: 'Implement requested change',
        details: 'No structured todos were parsed from phase 1 output; proceed with best effort.',
      },
    ],
    raw,
  }
}

export function parsePlanSnapshot(raw: string): PlanSnapshot | null {
  const candidates = parseJsonCandidates(raw)

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      const obj = asRecord(parsed)
      if (!obj) continue

      const todosSource = Array.isArray(obj.todos)
        ? obj.todos
        : Array.isArray(obj.tasks)
          ? obj.tasks
          : Array.isArray(obj.steps)
            ? obj.steps
            : []
      const todos = todosSource
        .map((item, index) => normalizeTodo(item, index))
        .filter((item): item is PlanTodoItem => item != null)

      const summary =
        toNonEmptyString(obj.summary) ??
        toNonEmptyString(obj.plan) ??
        toNonEmptyString(obj.overview) ??
        null

      if (!summary && todos.length === 0) continue

      return {
        summary: summary ?? `Plan with ${todos.length} todo${todos.length === 1 ? '' : 's'}.`,
        todos,
        raw,
      }
    } catch {
      continue
    }
  }

  const markdownTodos = parseMarkdownTodos(raw)
  if (markdownTodos.length === 0) return null

  return {
    summary: firstSentence(raw) || `Plan with ${markdownTodos.length} todos.`,
    todos: markdownTodos,
    raw,
  }
}

export function buildPlanPhaseMessage(prompt: string, input?: unknown) {
  const userMsg = input === undefined ? prompt : `${prompt}\n\nAdditional input:\n${JSON.stringify(input, null, 2)}`
  return `${userMsg}\n\n${PLAN_PHASE_PROMPT_APPENDIX}`
}

export function buildBuildPhaseMessage(plan: PlanSnapshot) {
  return [
    BUILD_PHASE_PROMPT_APPENDIX,
    'Approved plan summary:',
    plan.summary,
    'Approved todos (JSON):',
    JSON.stringify(plan.todos, null, 2),
  ].join('\n\n')
}
