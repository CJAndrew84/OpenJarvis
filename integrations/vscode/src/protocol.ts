export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface Completion { content: string; toolCalls: ToolCall[]; finishReason: string }
export interface Connection { baseUrl: string; apiKey?: string; allowRemote: boolean; timeoutMs: number }
export interface AgentOptions { model: string; maxTurns: number; maxOutputTokens: number }
export type AgentEvent = { kind: 'assistant' | 'tool' | 'status' | 'error' | 'user'; text: string };
export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Task cancelled.');
}
