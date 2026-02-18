import { describe, expect, it } from 'bun:test'

import {
  asRecord,
  buildFallbackPlan,
  firstSentence,
  normalizeTodo,
  parseJsonCandidates,
  parseMarkdownTodos,
  parsePlanSnapshot,
  toNonEmptyString,
  toStringArray,
} from '../../agent/planParser'

describe('asRecord', () => {
  it('returns object for plain objects', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
  })

  it('returns null for arrays', () => {
    expect(asRecord([1, 2])).toBeNull()
  })

  it('returns null for primitives and null', () => {
    expect(asRecord(null)).toBeNull()
    expect(asRecord(undefined)).toBeNull()
    expect(asRecord(42)).toBeNull()
    expect(asRecord('str')).toBeNull()
  })
})

describe('toNonEmptyString', () => {
  it('returns trimmed string for non-empty input', () => {
    expect(toNonEmptyString('  hello  ')).toBe('hello')
  })

  it('returns null for empty/whitespace strings', () => {
    expect(toNonEmptyString('')).toBeNull()
    expect(toNonEmptyString('   ')).toBeNull()
  })

  it('returns null for non-strings', () => {
    expect(toNonEmptyString(42)).toBeNull()
    expect(toNonEmptyString(null)).toBeNull()
  })
})

describe('toStringArray', () => {
  it('filters non-string and empty items', () => {
    expect(toStringArray(['a', 42, '', '  ', 'b'])).toEqual(['a', 'b'])
  })

  it('returns empty array for non-arrays', () => {
    expect(toStringArray('not array')).toEqual([])
    expect(toStringArray(null)).toEqual([])
  })
})

describe('parseJsonCandidates', () => {
  it('extracts fenced json blocks', () => {
    const raw = 'text\n```json\n{"a":1}\n```\nmore\n```json\n{"b":2}\n```'
    expect(parseJsonCandidates(raw)).toEqual(['{"a":1}\n', '{"b":2}\n'])
  })

  it('detects bare JSON object', () => {
    const raw = '{"summary":"test"}'
    const candidates = parseJsonCandidates(raw)
    expect(candidates).toContain('{"summary":"test"}')
  })

  it('returns empty for plain text', () => {
    expect(parseJsonCandidates('no json here')).toEqual([])
  })
})

describe('normalizeTodo', () => {
  it('normalizes a well-formed todo', () => {
    expect(normalizeTodo({ id: '1', title: 'Do thing', details: 'Some details' }, 0)).toEqual({
      id: '1',
      title: 'Do thing',
      details: 'Some details',
    })
  })

  it('falls back to task/todo/name fields for title', () => {
    expect(normalizeTodo({ task: 'From task' }, 5)?.title).toBe('From task')
    expect(normalizeTodo({ todo: 'From todo' }, 0)?.title).toBe('From todo')
    expect(normalizeTodo({ name: 'From name' }, 0)?.title).toBe('From name')
  })

  it('auto-generates id from index when missing', () => {
    expect(normalizeTodo({ title: 'X' }, 4)?.id).toBe('5')
  })

  it('includes acceptanceCriteria when present', () => {
    const todo = normalizeTodo({ title: 'X', acceptanceCriteria: ['works', 42, 'passes'] }, 0)
    expect(todo?.acceptanceCriteria).toEqual(['works', 'passes'])
  })

  it('returns null for non-objects or missing title', () => {
    expect(normalizeTodo('string', 0)).toBeNull()
    expect(normalizeTodo({ noTitle: true }, 0)).toBeNull()
    expect(normalizeTodo(null, 0)).toBeNull()
  })
})

describe('parseMarkdownTodos', () => {
  it('parses bullet lists', () => {
    const raw = '- add endpoint\n- wire worker\n- write tests'
    const todos = parseMarkdownTodos(raw)
    expect(todos).toHaveLength(3)
    expect(todos[0]?.title).toBe('add endpoint')
    expect(todos[2]?.title).toBe('write tests')
  })

  it('parses numbered lists', () => {
    const raw = '1. first\n2. second'
    const todos = parseMarkdownTodos(raw)
    expect(todos).toHaveLength(2)
    expect(todos[0]?.title).toBe('first')
  })

  it('parses checkbox items', () => {
    const raw = '- [ ] incomplete task\n- [x] complete task'
    const todos = parseMarkdownTodos(raw)
    expect(todos).toHaveLength(2)
    expect(todos[0]?.title).toBe('incomplete task')
  })

  it('assigns sequential IDs', () => {
    const todos = parseMarkdownTodos('- a\n- b\n- c')
    expect(todos.map((t) => t.id)).toEqual(['1', '2', '3'])
  })

  it('returns empty for plain prose', () => {
    expect(parseMarkdownTodos('This is just a paragraph of text.')).toEqual([])
  })
})

describe('firstSentence', () => {
  it('returns first non-empty non-heading line', () => {
    expect(firstSentence('# Heading\n\nThe plan is ready.')).toBe('The plan is ready.')
  })

  it('skips fenced code markers but not their content', () => {
    // firstSentence skips lines starting with ``` but not inner content
    expect(firstSentence('```json\n{"a":1}\n```\nActual sentence.')).toBe('{"a":1}')
    // When fenced block is absent, returns first prose line
    expect(firstSentence('```\n```\nActual sentence.')).toBe('Actual sentence.')
  })

  it('truncates long lines', () => {
    const long = 'A'.repeat(300)
    const result = firstSentence(long)
    expect(result.length).toBeLessThanOrEqual(240)
    expect(result).toContain('...')
  })

  it('returns empty for blank input', () => {
    expect(firstSentence('')).toBe('')
    expect(firstSentence('# Only heading')).toBe('')
  })
})

describe('parsePlanSnapshot', () => {
  it('parses fenced JSON plan with summary and todos', () => {
    const raw = [
      'Here is the plan:',
      '```json',
      '{"summary":"Ship feature","todos":[{"id":"1","title":"Add API"},{"id":"2","title":"Add tests"}]}',
      '```',
    ].join('\n')

    const plan = parsePlanSnapshot(raw)
    expect(plan).not.toBeNull()
    expect(plan?.summary).toBe('Ship feature')
    expect(plan?.todos).toHaveLength(2)
    expect(plan?.todos[0]?.title).toBe('Add API')
  })

  it('accepts "tasks" key as alias for "todos"', () => {
    const raw = '```json\n{"summary":"Plan","tasks":[{"title":"Task A"}]}\n```'
    const plan = parsePlanSnapshot(raw)
    expect(plan?.todos).toHaveLength(1)
    expect(plan?.todos[0]?.title).toBe('Task A')
  })

  it('accepts "steps" key as alias for "todos"', () => {
    const raw = '```json\n{"summary":"Plan","steps":[{"title":"Step A"}]}\n```'
    const plan = parsePlanSnapshot(raw)
    expect(plan?.todos).toHaveLength(1)
  })

  it('falls back to markdown todo parsing when no JSON', () => {
    const raw = 'Implementation plan\n- add schema\n- wire worker\n1. add tests'
    const plan = parsePlanSnapshot(raw)
    expect(plan).not.toBeNull()
    expect(plan?.todos).toHaveLength(3)
  })

  it('returns null for empty/prose text with no structure', () => {
    expect(parsePlanSnapshot('Just thinking about the implementation.')).toBeNull()
  })

  it('generates summary from todo count when missing', () => {
    const raw = '```json\n{"todos":[{"title":"Do X"},{"title":"Do Y"}]}\n```'
    const plan = parsePlanSnapshot(raw)
    expect(plan?.summary).toBe('Plan with 2 todos.')
  })

  it('uses "plan" and "overview" as summary fallbacks', () => {
    const raw = '```json\n{"plan":"The overview text","todos":[{"title":"A"}]}\n```'
    expect(parsePlanSnapshot(raw)?.summary).toBe('The overview text')

    const raw2 = '```json\n{"overview":"Alt overview","todos":[{"title":"B"}]}\n```'
    expect(parsePlanSnapshot(raw2)?.summary).toBe('Alt overview')
  })

  it('skips malformed JSON and tries next candidate', () => {
    const raw = '```json\nnot valid json\n```\n```json\n{"summary":"Good","todos":[{"title":"A"}]}\n```'
    const plan = parsePlanSnapshot(raw)
    expect(plan?.summary).toBe('Good')
  })

  it('preserves raw text on output', () => {
    const raw = '```json\n{"summary":"S","todos":[{"title":"T"}]}\n```'
    expect(parsePlanSnapshot(raw)?.raw).toBe(raw)
  })
})

describe('buildFallbackPlan', () => {
  it('extracts markdown todos when present', () => {
    const raw = 'Here is the plan:\n- Do A\n- Do B'
    const plan = buildFallbackPlan(raw, 'some prompt')
    expect(plan.todos).toHaveLength(2)
    expect(plan.todos[0]?.title).toBe('Do A')
  })

  it('creates a synthetic single todo when no structure found', () => {
    const raw = 'I will work on the implementation now.'
    const plan = buildFallbackPlan(raw, 'Build the feature')
    expect(plan.todos).toHaveLength(1)
    expect(plan.todos[0]?.title).toBe('Implement requested change')
    expect(plan.todos[0]?.details).toContain('No structured todos')
  })

  it('uses first sentence as summary', () => {
    const raw = 'The refactor plan is ready.\n- Step 1\n- Step 2'
    const plan = buildFallbackPlan(raw, 'Refactor')
    expect(plan.summary).toBe('The refactor plan is ready.')
  })

  it('falls back to prompt-based summary', () => {
    const raw = ''
    const plan = buildFallbackPlan(raw, 'Build auth system')
    expect(plan.summary).toContain('Build auth system')
  })
})
