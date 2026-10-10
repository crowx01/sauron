import { randomUUID } from 'crypto';
import { AgentEvent, AgentRunOptions, AgentRunResult, Message, ToolCall, ToolResult } from '../types';
import { chatRouter } from '../router';
import { toolBelt } from '../tools';

const DEFAULT_MAX_TURNS = 8;

const DEFAULT_SYSTEM_PROMPT = `You are Sauron, an autonomous agent that solves tasks by calling tools in a loop.

On every turn, respond with EXACTLY ONE of:
1. A tool call:
   <tool_call name="TOOL_NAME">{"arg": "value"}</tool_call>
2. Your final answer, once the task is complete:
   <final>your answer here</final>

Never emit both tags in the same turn. Never call a tool that is not listed below. Keep tool
arguments valid JSON matching the tool's declared parameters.`;

const TOOL_CALL_RE = /<tool_call\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>/i;
const FINAL_RE = /<final>([\s\S]*?)<\/final>/i;

function describeTools(names?: string[]): string {
  const tools = toolBelt.listTools().filter((t) => !names || names.includes(t.name));
  return tools.map((t) => `- ${t.name}(${JSON.stringify(t.parameters)}): ${t.description}`).join('\n');
}

/** Parses one turn's raw model output into either a tool call or a final answer. */
export function parseAgentTurn(
  text: string
): { kind: 'tool_call'; name: string; args: Record<string, any>; raw: string } | { kind: 'final'; answer: string } {
  const toolMatch = text.match(TOOL_CALL_RE);
  const finalMatch = text.match(FINAL_RE);

  // If both appear, honor whichever comes first in the text (the model should only emit one).
  if (toolMatch && finalMatch) {
    const useTool = (toolMatch.index ?? 0) <= (finalMatch.index ?? 0);
    if (useTool) return parseToolMatch(toolMatch);
    return { kind: 'final', answer: finalMatch[1].trim() };
  }
  if (toolMatch) return parseToolMatch(toolMatch);
  if (finalMatch) return { kind: 'final', answer: finalMatch[1].trim() };

  // No recognized tag: treat the whole reply as the final answer rather than looping forever.
  return { kind: 'final', answer: text.trim() };
}

function parseToolMatch(match: RegExpMatchArray): { kind: 'tool_call'; name: string; args: Record<string, any>; raw: string } {
  const name = match[1].trim();
  const body = match[2].trim();
  let args: Record<string, any> = {};
  if (body) {
    try {
      args = JSON.parse(body);
    } catch {
      args = { _raw: body };
    }
  }
  return { kind: 'tool_call', name, args, raw: match[0] };
}

/**
 * Autonomous ReAct loop: model decides to call a tool, the ToolBelt executes it, the result is
 * fed back as a `tool` message, and the cycle repeats (up to maxTurns) until the model emits a
 * <final> answer, the loop is aborted, or the turn budget runs out.
 */
export class AgentLoop {
  public async *run(goalPrompt: string, options: AgentRunOptions = {}): AsyncGenerator<AgentEvent, AgentRunResult, unknown> {
    const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    const signal = options.signal;

    const systemPrompt = `${options.systemPrompt || DEFAULT_SYSTEM_PROMPT}\n\nAvailable tools:\n${describeTools(options.tools)}`;
    const transcript: Message[] = [
      { id: `m_${randomUUID().slice(0, 8)}`, role: 'system', content: systemPrompt, timestamp: Date.now() },
      { id: `m_${randomUUID().slice(0, 8)}`, role: 'user', content: goalPrompt, timestamp: Date.now() }
    ];

    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    let turn = 0;

    while (turn < maxTurns) {
      if (signal?.aborted) {
        return this.finish(transcript, toolCalls, toolResults, turn, 'aborted', '');
      }
      turn++;
      yield { type: 'turn_start', turn };

      let buffer = '';
      let lastModel: string | undefined;
      let lastProvider: string | undefined;
      let streamError: string | undefined;

      for await (const chunk of chatRouter.dispatch(transcript, { ...options, signal })) {
        if (signal?.aborted) return this.finish(transcript, toolCalls, toolResults, turn, 'aborted', buffer);
        if (chunk.error) {
          streamError = chunk.error;
          continue;
        }
        if (chunk.delta) {
          buffer += chunk.delta;
          lastModel = chunk.modelUsed || lastModel;
          lastProvider = chunk.providerUsed || lastProvider;
          yield { type: 'delta', turn, delta: chunk.delta, modelUsed: lastModel, providerUsed: lastProvider };
        }
      }

      if (!buffer.trim() && streamError) {
        yield { type: 'error', turn, error: streamError };
        return this.finish(transcript, toolCalls, toolResults, turn, 'error', '');
      }

      const assistantMsg: Message = {
        id: `m_${randomUUID().slice(0, 8)}`,
        role: 'assistant',
        content: buffer,
        timestamp: Date.now()
      };
      transcript.push(assistantMsg);

      const parsed = parseAgentTurn(buffer);
      if (parsed.kind === 'final') {
        yield { type: 'final', turn, final: parsed.answer, modelUsed: lastModel, providerUsed: lastProvider };
        return this.finish(transcript, toolCalls, toolResults, turn, 'final', parsed.answer);
      }

      // tool_call
      const toolCall: ToolCall = { id: `tc_${randomUUID().slice(0, 8)}`, name: parsed.name, arguments: parsed.args };
      toolCalls.push(toolCall);
      yield { type: 'tool_call', turn, toolCall, modelUsed: lastModel, providerUsed: lastProvider };

      const execResult = await toolBelt.executeTool(parsed.name, parsed.args, { signal });
      const result: ToolResult = { ...execResult, toolCallId: toolCall.id };
      toolResults.push(result);
      yield { type: 'tool_result', turn, toolResult: result };

      transcript.push({
        id: `m_${randomUUID().slice(0, 8)}`,
        role: 'tool',
        name: parsed.name,
        content: result.error ? `Error: ${result.error}` : result.output,
        toolCallId: toolCall.id,
        timestamp: Date.now()
      });
    }

    yield { type: 'max_turns', turn };
    return this.finish(transcript, toolCalls, toolResults, turn, 'max_turns', '');
  }

  /** Drains run() for callers that just want the final result (e.g. the mission executor). */
  public async runToCompletion(goalPrompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const gen = this.run(goalPrompt, options);
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return next.value;
  }

  private finish(
    transcript: Message[],
    toolCalls: ToolCall[],
    toolResults: ToolResult[],
    turns: number,
    finishReason: AgentRunResult['finishReason'],
    finalAnswer: string
  ): AgentRunResult {
    return { finalAnswer, turns, transcript, toolCalls, toolResults, finishReason };
  }
}

export const agentLoop = new AgentLoop();
