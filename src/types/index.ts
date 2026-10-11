export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  id: string;
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
  error?: string;
  exitCode?: number;
}

export interface ModelEntry {
  model: string;
  provider: string;
  intelligence: number;
  costRank: number;
  routable: boolean;
  tools: boolean;
  aliases: string[];
}

export interface TaskClassification {
  category: string;
  domain?: string;
  planDepth: number;
  ambiguity: number;
  confidence?: number;
}

export interface RouterOptions {
  model?: string;
  mode?: 'auto' | 'cheap' | 'smart' | 'delegate';
  needTools?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Free-form bucket (e.g. 'recon', 'codegen') used to scope routing lessons. Defaults to 'general'. */
  taskCategory?: string;
  sessionId?: string;
  classification?: TaskClassification;
}

export interface StreamChunk {
  delta?: string;
  toolCall?: ToolCall;
  finishReason?: string;
  modelUsed?: string;
  providerUsed?: string;
  error?: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  metadata?: Record<string, any>;
}

export interface MissionGoal {
  id: string;
  title: string;
  prompt: string;
  maxSteps?: number;
}

export interface MissionStep {
  stepNumber: number;
  role: 'planner' | 'executor' | 'judge';
  action: string;
  result: string;
  passed: boolean;
}

export interface MissionReport {
  missionId: string;
  goal: string;
  success: boolean;
  steps: MissionStep[];
  summary: string;
}

export interface ToolAdapter {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (args: Record<string, any>, context?: any) => Promise<string>;
}

// --- Autonomous ReAct agent loop ---

export type AgentEventType =
  | 'turn_start'
  | 'delta'
  | 'tool_call'
  | 'tool_result'
  | 'final'
  | 'error'
  | 'max_turns';

export interface AgentEvent {
  type: AgentEventType;
  turn: number;
  delta?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  final?: string;
  error?: string;
  modelUsed?: string;
  providerUsed?: string;
}

export interface AgentRunOptions extends RouterOptions {
  /** Hard cap on model<->tool round trips. Default 8. */
  maxTurns?: number;
  /** Prepended as a system message; defaults to the built-in ReAct instructions. */
  systemPrompt?: string;
  /** Tool-name whitelist. Omit for every tool registered in the ToolBelt. */
  tools?: string[];
}

export type AgentFinishReason = 'final' | 'max_turns' | 'aborted' | 'error';

export interface AgentRunResult {
  finalAnswer: string;
  turns: number;
  transcript: Message[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  finishReason: AgentFinishReason;
}

// --- Adaptive mission pipeline (writer -> executor -> judge, with retries) ---

export interface MissionOptions {
  /** Judge-triggered retries of a failed task before the mission gives up. Default 2. */
  maxRetries?: number;
  /** Turn cap handed to the executor's AgentLoop per attempt. Default 6. */
  maxStepsPerTask?: number;
  model?: RouterOptions['model'];
  mode?: RouterOptions['mode'];
}

export interface JudgeVerdict {
  passed: boolean;
  reason: string;
  guidance?: string;
}

// --- Multi-model debate & consensus ---

export interface DebateParticipant {
  model: string;
  provider: string;
  argument: string;
  error?: string;
}

export interface DebateResult {
  question: string;
  participants: DebateParticipant[];
  agreements: string[];
  dissents: string[];
  synthesis: string;
}

export interface DebateOptions {
  /** Explicit model picks to seat at the table. Defaults to [smart-tier, cheap-tier, a 3rd distinct provider]. */
  seats?: string[];
  signal?: AbortSignal;
}

// --- Routing & distillation (lesson store) ---

export interface RouteLesson {
  provider: string;
  model: string;
  taskCategory: string;
  success: boolean;
  latencyMs: number;
  timestamp: number;
}

export interface RouteStat {
  provider: string;
  model: string;
  taskCategory: string;
  attempts: number;
  successes: number;
  avgLatencyMs: number;
  lastUsed: number;
}
