import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { normalizeEndpoint, OpenJarvisClient } from '../client';
import { MAX_FILE_BYTES, relativePath, replacementText, WorkspaceFiles } from '../workspace';
import { runAgent, SYSTEM_PROMPT, TOOLS } from '../agent';
import { Completion, Message } from '../protocol';

const signal = () => new AbortController().signal;

test('endpoint policy accepts loopback and explicitly enabled remote HTTPS', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.1:8000/', false), 'http://127.0.0.1:8000/v1');
  assert.equal(normalizeEndpoint('http://[::1]:8000/v1/', false), 'http://[::1]:8000/v1');
  assert.equal(normalizeEndpoint('https://example.test/proxy', true), 'https://example.test/proxy/v1');
  for (const url of ['http://example.test', 'https://example.test', 'file:///tmp/a', 'http://user:secret@localhost', 'http://localhost/?key=secret', 'http://localhost/#secret']) {
    assert.throws(() => normalizeEndpoint(url, false));
  }
  assert.throws(() => normalizeEndpoint('http://example.test', true));
});

test('workspace path policy rejects traversal, credentials and Windows alternate streams', () => {
  assert.equal(relativePath('./src/code.ts'), 'src/code.ts');
  for (const file of ['../outside', '/tmp/outside', 'C:/secrets', 'src\\code', '.env', '.env.local', '.git/config', 'src/key.pem', 'foo:stream', 'node_modules/a.js']) {
    assert.throws(() => relativePath(file));
  }
});

test('edit matching rejects ambiguous and stale source while supporting creation', () => {
  assert.equal(replacementText('let x = 1;', '1', '2'), 'let x = 2;');
  assert.equal(replacementText(undefined, '', 'new file'), 'new file');
  assert.equal(replacementText('', '', 'new content'), 'new content');
  assert.throws(() => replacementText('a a', 'a', 'b'), /more than once/);
  assert.throws(() => replacementText('updated', 'old', 'new'), /does not match/);
  assert.throws(() => replacementText('text', '', 'new'), /exact text/);
  assert.throws(() => replacementText('same', 'same', 'same'), /no change/);
  assert.throws(() => replacementText(undefined, 'exists', 'new'));
});

test('workspace reads, listing and search honour ignore files and link boundaries', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'openjarvis-files-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(root, '.openjarvisignore'), 'private.txt\n');
  await fs.writeFile(path.join(root, 'src/.gitignore'), 'nested.txt\n');
  for (const name of ['ignored.txt', 'private.txt', '.env', 'src/nested.txt']) await fs.writeFile(path.join(root, name), 'secret needle');
  await fs.writeFile(path.join(root, 'src/main.ts'), 'first\nneedle\nthird');
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 'a'));
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(base, 'outside.txt'), 'outside needle');
  await fs.symlink(path.join(base, 'outside.txt'), path.join(root, 'linked.txt'));
  await fs.link(path.join(base, 'outside.txt'), path.join(root, 'hard.txt'));
  const files = await WorkspaceFiles.open(root);
  assert.equal(await files.read('src/main.ts'), 'first\nneedle\nthird');
  for (const name of ['ignored.txt', 'private.txt', '.env', 'src/nested.txt', 'linked.txt', 'hard.txt', 'large.txt', 'binary.bin', '../outside.txt']) await assert.rejects(files.read(name));
  const listed = await files.list('', '', signal());
  assert(listed.files.includes('src/main.ts'));
  for (const name of ['ignored.txt', 'private.txt', 'src/nested.txt', 'linked.txt', 'hard.txt', '.env']) assert(!listed.files.includes(name));
  assert.deepEqual(await files.search('needle', '', signal()), { matches: [{ path: 'src/main.ts', line: 2, text: 'needle' }], truncated: false });
  assert.equal(await files.existing('new/deep/file.ts'), undefined);
  await fs.symlink(base, path.join(root, 'escape'));
  await assert.rejects(files.resolve('escape/new.txt', true));
  const edited = await WorkspaceFiles.open(root, file => file.endsWith('main.ts') ? 'unsaved buffer' : undefined);
  assert.equal(await edited.read('src/main.ts'), 'unsaved buffer');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(files.list('', '', controller.signal), /cancelled/);
});

test('review snapshots detect both editor changes and disk changes behind an open buffer', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openjarvis-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'code.ts'), 'disk original');
  let buffer = 'unsaved editor text';
  const files = await WorkspaceFiles.open(root, () => buffer);
  const snapshot = await files.snapshot('code.ts');
  assert(await files.unchanged('code.ts', snapshot));
  await fs.writeFile(path.join(root, 'code.ts'), 'external process change');
  assert.equal(await files.unchanged('code.ts', snapshot), false);
  await fs.writeFile(path.join(root, 'code.ts'), 'disk original');
  buffer = 'new editor text';
  assert.equal(await files.unchanged('code.ts', snapshot), false);
  const missing = await files.snapshot('new.ts');
  await fs.writeFile(path.join(root, 'new.ts'), 'another actor created this');
  assert.equal(await files.unchanged('new.ts', missing), false);
});

test('agent executes a read/propose loop and preserves tool-call IDs', async () => {
  const history: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'Fix it' }];
  const executed: string[] = [];
  const replies: Completion[] = [
    { content: '', toolCalls: [{ id: 'read1', type: 'function', function: { name: 'read_file', arguments: '{"path":"main.ts"}' } }], finishReason: 'tool_calls' },
    { content: 'I found the bug.', toolCalls: [{ id: 'edit1', type: 'function', function: { name: 'propose_edit', arguments: '{"path":"main.ts","original":"1","replacement":"2"}' } }], finishReason: 'tool_calls' },
    { content: 'Change applied.', toolCalls: [], finishReason: 'stop' },
  ];
  await runAgent({ complete: async (messages, tools) => { assert.equal(messages, history); assert.equal(tools, TOOLS); return replies.shift()!; } }, history,
    async name => { executed.push(name); return name === 'read_file' ? { content: '1' } : { applied: true }; },
    { model: 'test', maxTurns: 4, maxOutputTokens: 1024 }, () => {}, signal());
  assert.deepEqual(executed, ['read_file', 'propose_edit']);
  assert.deepEqual(history.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['read1', 'edit1']);
});

test('unknown tools and malformed arguments never reach the executor', async () => {
  let turn = 0, executions = 0;
  const history: Message[] = [];
  await runAgent({ complete: async () => ++turn === 1 ? { content: '', finishReason: 'tool_calls', toolCalls: [
    { id: 'x', type: 'function', function: { name: 'shell', arguments: '{}' } },
    { id: 'y', type: 'function', function: { name: 'read_file', arguments: 'not-json' } },
  ] } : { content: 'Stopped.', toolCalls: [], finishReason: 'stop' } }, history, async () => { executions++; },
    { model: 'test', maxTurns: 3, maxOutputTokens: 1024 }, () => {}, signal());
  assert.equal(executions, 0);
  assert(history.filter(m => m.role === 'tool').every(m => JSON.parse(m.content).error));
});

test('truncated responses and cancellation cannot execute proposed actions', async () => {
  let executed = false;
  const reply: Completion = { content: '', toolCalls: [{ id: 'x', type: 'function', function: { name: 'run_command', arguments: '{}' } }], finishReason: 'length' };
  await assert.rejects(runAgent({ complete: async () => reply }, [], async () => { executed = true; }, { model: 'test', maxTurns: 1, maxOutputTokens: 1024 }, () => {}, signal()), /cut off/);
  assert.equal(executed, false);
  const controller = new AbortController();
  await assert.rejects(runAgent({ complete: async () => { controller.abort(); return { ...reply, finishReason: 'tool_calls' }; } }, [], async () => { executed = true; }, { model: 'test', maxTurns: 1, maxOutputTokens: 1024 }, () => {}, controller.signal), /cancelled/);
  assert.equal(executed, false);
});

test('context and turn budgets terminate agent loops', async () => {
  const client = { complete: async (): Promise<Completion> => ({ content: '', toolCalls: [{ id: 'x', type: 'function', function: { name: 'list_files', arguments: '{}' } }], finishReason: 'tool_calls' }) };
  const opts = { model: 'test', maxTurns: 1, maxOutputTokens: 1024 };
  await assert.rejects(runAgent(client, [], async () => ({}), opts, () => {}, signal()), /Maximum agent steps/);
  await assert.rejects(runAgent(client, [{ role: 'user', content: 'x'.repeat(120001) }], async () => ({}), opts, () => {}, signal()), /context is full/);
});

async function server(t: { after: (fn: () => unknown) => void }, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
}

test('HTTP client sends the OpenJarvis raw-tools contract and server bearer key', async t => {
  const baseUrl = await server(t, async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-key');
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models') { response.end('{"data":[{"id":"local-coder"}]}'); return; }
    assert.equal(request.url, '/v1/chat/completions');
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, 'local-coder'); assert.equal(parsed.stream, false); assert(parsed.tools.length > 0);
    response.end(JSON.stringify({ choices: [{ message: { content: 'Done', tool_calls: [] }, finish_reason: 'stop' }] }));
  });
  const client = new OpenJarvisClient({ baseUrl, allowRemote: false, apiKey: 'test-key', timeoutMs: 1000 });
  assert.deepEqual(await client.models(signal()), ['local-coder']);
  assert.equal((await client.complete([{ role: 'user', content: 'hi' }], TOOLS, 'local-coder', 1024, signal())).content, 'Done');
  await assert.rejects(client.complete([], [], 'local-coder', 1024, signal()), /tools are required/);
});

test('HTTP redirects, malformed completions and authentication failures are contained', async t => {
  let mode = 'redirect';
  const baseUrl = await server(t, (_, response) => {
    if (mode === 'redirect') { response.writeHead(302, { Location: 'https://example.test/leak' }); response.end(); }
    else if (mode === 'auth') { response.writeHead(401); response.end('secret internal detail'); }
    else response.end('{"choices":[{"message":{"tool_calls":[{"id":"x"}]}}]}');
  });
  const client = new OpenJarvisClient({ baseUrl, allowRemote: false, timeoutMs: 1000 });
  await assert.rejects(client.models(signal()), /Redirects are blocked/);
  mode = 'auth'; await assert.rejects(client.models(signal()), /HTTP 401/);
  mode = 'bad'; await assert.rejects(client.complete([], TOOLS, 'test', 1024, signal()), /invalid tool calls/);
});

test('HTTP timeout, response size limit and user cancellation stop requests', async t => {
  let mode = 'wait';
  const baseUrl = await server(t, (_, response) => { if (mode === 'large') response.end('x'.repeat(4 * 1024 * 1024 + 1)); });
  const client = new OpenJarvisClient({ baseUrl, allowRemote: false, timeoutMs: 100 });
  await assert.rejects(client.models(signal()), /timed out/);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
  await assert.rejects(client.models(controller.signal), /cancelled/);
  mode = 'large';
  await assert.rejects(new OpenJarvisClient({ baseUrl, allowRemote: false, timeoutMs: 3000 }).models(signal()), /exceeded 4 MB/);
});
