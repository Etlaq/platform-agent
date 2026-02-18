/** Token event — one chunk of LLM streaming output. */
export interface TokenPayload {
  token: string
}

/** File operation event — emitted by ObservableBackend when the agent reads/writes files. */
export interface FileOpPayload {
  op: 'read' | 'write' | 'edit' | 'ls' | 'grep' | 'glob'
  path: string
  phase: 'plan' | 'build'
  /** Number of characters written (write only). */
  sizeChars?: number
  /** Number of matches returned (grep, glob only). */
  matchCount?: number
  /** Number of directory entries returned (ls only). */
  entryCount?: number
  /** Search pattern used (grep, glob only). */
  pattern?: string
}

/** Tool invocation started. */
export interface ToolStartPayload {
  phase: 'start'
  runPhase: 'plan' | 'build'
  tool: string
  input: unknown
}

/** Tool invocation completed. */
export interface ToolEndPayload {
  phase: 'end'
  runPhase: 'plan' | 'build'
  runId: string
  output: unknown
}

/** Tool invocation errored. */
export interface ToolErrorPayload {
  phase: 'error'
  runPhase: 'plan' | 'build'
  runId: string
  error: string
}

/** Streaming chunk from a sandbox command. */
export interface ToolStreamPayload {
  phase: 'stream'
  runPhase: 'plan' | 'build'
  tool: string
  cmd: string
  stream: 'stdout' | 'stderr'
  internal: boolean
  chunk: string
}

/** Status event — phase transitions, snapshots, etc. */
export interface StatusPayload {
  status: string
  [key: string]: unknown
}

/** Discriminated union of all agent events. */
export type AgentEvent =
  | { type: 'token'; payload: TokenPayload }
  | { type: 'file_op'; payload: FileOpPayload }
  | { type: 'tool'; payload: ToolStartPayload | ToolEndPayload | ToolErrorPayload | ToolStreamPayload }
  | { type: 'status'; payload: StatusPayload }

/** Callback signature for receiving agent events. */
export type AgentEventCallback = (event: AgentEvent) => void
