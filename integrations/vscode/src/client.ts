import { checkCancelled, Completion, Connection, Message, ToolCall, ToolSpec } from './protocol';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function normalizeEndpoint(raw: string, allowRemote: boolean): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Enter a valid OpenJarvis server URL.'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Server URLs cannot contain credentials, query strings or fragments.');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use HTTP or HTTPS.');
  if (!local && (!allowRemote || url.protocol !== 'https:')) {
    throw new Error('Remote servers require HTTPS and the Allow Remote Server user setting.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1') ? pathname : pathname + '/v1';
  return url.toString().replace(/\/$/, '');
}

export class OpenJarvisClient {
  readonly baseUrl: string;
  constructor(private readonly config: Connection) {
    this.baseUrl = normalizeEndpoint(config.baseUrl, config.allowRemote);
  }

  private async request(route: string, signal: AbortSignal, body?: unknown): Promise<any> {
    checkCancelled(signal);
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await fetch(`${this.baseUrl}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const hint = response.status === 401 ? ' Check the server API key.' : '';
        throw new Error(`OpenJarvis returned HTTP ${response.status}.${hint}`);
      }
      if (!response.body) throw new Error('OpenJarvis returned an empty response.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error('OpenJarvis response exceeded 4 MB.');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      checkCancelled(signal);
      if (timeout.aborted) throw new Error('OpenJarvis timed out. Check that the model is loaded, or increase the request timeout.');
      if (error instanceof TypeError) throw new Error('Could not connect to OpenJarvis. Check the server URL and that jarvis serve is running. Redirects are blocked.');
      if (error instanceof SyntaxError) throw new Error('OpenJarvis returned invalid JSON. Check the API base URL.');
      throw error;
    }
  }

  async models(signal: AbortSignal): Promise<string[]> {
    const result = await this.request('/models', signal);
    if (!Array.isArray(result.data)) throw new Error('Unexpected model list from OpenJarvis.');
    return result.data.map((m: any) => m?.id).filter((s: unknown): s is string => typeof s === 'string' && s.length > 0);
  }

  async complete(messages: Message[], tools: ToolSpec[], model: string, maxTokens: number, signal: AbortSignal): Promise<Completion> {
    // A non-empty tool list selects the raw engine path in OpenJarvis. The editor,
    // rather than the server's agent, owns tool execution and user approvals.
    if (!tools.length) throw new Error('Client-owned tools are required.');
    const result = await this.request('/chat/completions', signal, {
      model, messages, tools, stream: false, temperature: 0.2, max_tokens: maxTokens,
    });
    const choice = result.choices?.[0];
    const message = choice?.message;
    if (!message || (message.content != null && typeof message.content !== 'string')) {
      throw new Error('OpenJarvis returned an invalid completion.');
    }
    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 8 || calls.some((t: any) =>
      !t || typeof t.id !== 'string' || !t.id || t.type !== 'function' ||
      typeof t.function?.name !== 'string' || typeof t.function?.arguments !== 'string')) {
      throw new Error('OpenJarvis returned invalid tool calls.');
    }
    if (new Set(calls.map((t: ToolCall) => t.id)).size !== calls.length) throw new Error('Duplicate tool-call IDs in response.');
    return { content: message.content ?? '', toolCalls: calls, finishReason: choice.finish_reason ?? 'stop' };
  }
}
