import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { OpenJarvisClient, normalizeEndpoint } from './client';
import { runAgent, SYSTEM_PROMPT } from './agent';
import { AgentEvent, checkCancelled, Message } from './protocol';
import { MAX_FILE_BYTES, replacementText, WorkspaceFiles } from './workspace';

interface Settings {
  serverUrl: string; allowRemoteServer: boolean; model: string; maxTurns: number;
  maxOutputTokens: number; requestTimeoutSeconds: number; allowCommands: boolean;
}
function settings(): Settings {
  const config = vscode.workspace.getConfiguration('openjarvis');
  const value = <T>(key: string, fallback: T): T => {
    const setting = config.inspect<T>(key);
    // Connection and execution controls are user-owned, never repo-controlled.
    return setting?.globalValue ?? setting?.defaultValue ?? fallback;
  };
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const v = value(key, fallback);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : fallback;
  };
  return {
    serverUrl: value('serverUrl', 'http://127.0.0.1:8000/v1'),
    allowRemoteServer: value('allowRemoteServer', false), model: value('model', ''),
    maxTurns: bounded('maxTurns', 16, 1, 40), maxOutputTokens: bounded('maxOutputTokens', 4096, 256, 16384),
    requestTimeoutSeconds: bounded('requestTimeoutSeconds', 180, 10, 600), allowCommands: value('allowCommands', false),
  };
}
const textArg = (args: Record<string, unknown>, key: string, fallback?: string): string => {
  const value = args[key] ?? fallback;
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value;
};
function assertTrusted(): void {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using the coding agent.');
}

class PreviewDocuments implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();
  add(content: string, suffix: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: 'openjarvis-preview', path: `/${randomBytes(12).toString('hex')}/${suffix}` });
    this.documents.set(uri.toString(), content);
    return uri;
  }
  provideTextDocumentContent(uri: vscode.Uri): string { return this.documents.get(uri.toString()) ?? ''; }
  remove(...uris: vscode.Uri[]): void { uris.forEach(uri => this.documents.delete(uri.toString())); }
}

class CodingAgentView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private events: AgentEvent[] = [];
  private history: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  private controller?: AbortController;
  private root?: vscode.WorkspaceFolder;
  private attachment?: { path: string; content: string };
  private status = 'Ready';
  private latestEditor = vscode.window.activeTextEditor;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly previews: PreviewDocuments) {
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor?.document.uri.scheme === 'file') this.latestEditor = editor;
    }));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('openjarvis.serverUrl') || event.affectsConfiguration('openjarvis.model') || event.affectsConfiguration('openjarvis.allowRemoteServer')) {
        this.newChat('Connection or model changed. Conversation cleared.');
      }
      this.render();
    }));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { this.root = undefined; this.newChat('Workspace changed.'); }));
  }

  dispose(): void { this.controller?.abort(); this.disposables.forEach(d => d.dispose()); }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(24).toString('hex');
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'));
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${style}"><title>OpenJarvis Coding Agent</title></head><body>
      <header><div class="brand"><span class="mark">OJ</span><div><h1>OpenJarvis</h1><span class="subtitle">Your workspace. Your model.</span></div></div>
      <button id="new" class="quiet" title="New chat" aria-label="New chat">＋</button></header>
      <section class="connection"><button id="model" title="Select a model">Choose model</button><button id="configure" class="quiet" title="Connection settings">Settings</button><div id="endpoint"></div></section>
      <main id="thread" aria-label="Conversation" aria-live="polite"><section id="welcome"><p class="eyebrow">LET’S BUILD SOMETHING</p><h2>A coding partner<br>inside your editor.</h2><p>Ask a question, find a problem or describe a change. Review each edit in a diff before it is applied.</p><div class="starters"><button data-prompt="Explore this project and explain its structure.">Explore this project <span>↗</span></button><button data-prompt="Review the attached code for bugs. Explain your findings before making any changes.">Review selected code <span>↗</span></button><button data-prompt="Help me add a focused test for the attached code.">Add a test <span>↗</span></button></div></section><div id="messages"></div></main>
      <footer><div id="status" role="status">Ready</div><div id="attachment" hidden><span></span><button id="remove" class="quiet" aria-label="Remove attachment">×</button></div>
      <form id="composer"><label class="sr-only" for="prompt">Task for OpenJarvis</label><textarea id="prompt" placeholder="Describe a task…" rows="3" maxlength="20000"></textarea><div class="actions"><button type="button" id="attach" class="quiet">＋ Editor context</button><button type="button" id="stop" hidden>Stop</button><button type="submit" id="send">Send ↑</button></div></form>
      <label class="commands"><input id="commands" type="checkbox"> Offer terminal commands <span>(approval required)</span></label><p class="note">No extension analytics. Your OpenJarvis server controls model routing and retention.</p></footer>
      <script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.disposables.push(view.webview.onDidReceiveMessage(message => { void this.receive(message).catch(error => this.emit({ kind: 'error', text: error.message ?? String(error) })); }));
    this.disposables.push(view.onDidDispose(() => { this.view = undefined; }));
    this.render();
  }

  private render(): void {
    const cfg = settings();
    void this.view?.webview.postMessage({ type: 'state', events: this.events, busy: !!this.controller,
      status: this.status, endpoint: cfg.serverUrl, model: cfg.model, allowCommands: cfg.allowCommands,
      attachment: this.attachment?.path ?? '', root: this.root?.name ?? '' });
  }
  private emit(event: AgentEvent): void {
    if (event.kind === 'status') this.status = event.text;
    else { this.events.push(event); if (this.events.length > 400) this.events.shift(); }
    this.render();
  }
  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    const m = message as { type: string; text?: unknown; enabled?: unknown };
    switch (m.type) {
      case 'ready': this.render(); break;
      case 'send': if (typeof m.text === 'string') await this.send(m.text); break;
      case 'stop': this.controller?.abort(); break;
      case 'new': this.newChat(); break;
      case 'attach': await this.attach(); break;
      case 'remove': if (!this.controller) { this.attachment = undefined; this.render(); } break;
      case 'configure': await this.configure(); break;
      case 'model': await this.selectModel(); break;
      case 'commands':
        if (!this.controller && typeof m.enabled === 'boolean') await vscode.workspace.getConfiguration('openjarvis').update('allowCommands', m.enabled, vscode.ConfigurationTarget.Global);
        break;
    }
  }

  newChat(status = 'Ready'): void {
    this.controller?.abort();
    this.controller = undefined;
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
    this.events = [];
    this.attachment = undefined;
    this.status = status;
    this.render();
  }
  private async client(cfg = settings()): Promise<OpenJarvisClient> {
    const baseUrl = normalizeEndpoint(cfg.serverUrl, cfg.allowRemoteServer);
    const apiKey = await this.context.secrets.get(`openjarvis.apiKey:${baseUrl}`);
    return new OpenJarvisClient({ baseUrl, allowRemote: cfg.allowRemoteServer, apiKey, timeoutMs: cfg.requestTimeoutSeconds * 1000 });
  }
  async configure(): Promise<void> {
    if (this.controller) throw new Error('Stop the current task before changing the connection.');
    const cfg = settings();
    const endpoint = await vscode.window.showInputBox({ title: 'OpenJarvis server', prompt: 'API base URL. Remote servers require HTTPS and Allow Remote Server in user settings.', value: cfg.serverUrl,
      validateInput: value => { try { normalizeEndpoint(value, cfg.allowRemoteServer); return undefined; } catch (error) { return (error as Error).message; } } });
    if (endpoint === undefined) return;
    await vscode.workspace.getConfiguration('openjarvis').update('serverUrl', normalizeEndpoint(endpoint, cfg.allowRemoteServer), vscode.ConfigurationTarget.Global);
    await this.selectModel();
  }
  async selectModel(): Promise<void> {
    if (this.controller) throw new Error('Stop the current task before selecting a model.');
    const client = await this.client();
    const models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OpenJarvis: Loading models', cancellable: true }, async (_, token) => {
      const controller = new AbortController();
      const disposable = token.onCancellationRequested(() => controller.abort());
      try { return await client.models(controller.signal); } finally { disposable.dispose(); }
    });
    if (!models.length) throw new Error('No models are available. Start your local engine and install a model with tool-calling support.');
    const chosen = await vscode.window.showQuickPick(models, { title: 'OpenJarvis model', placeHolder: 'Choose a model with function/tool-calling support' });
    if (chosen) await vscode.workspace.getConfiguration('openjarvis').update('model', chosen, vscode.ConfigurationTarget.Global);
  }
  async apiKey(clear = false): Promise<void> {
    if (this.controller) throw new Error('Stop the current task before changing the API key.');
    const cfg = settings();
    const baseUrl = normalizeEndpoint(cfg.serverUrl, cfg.allowRemoteServer);
    const key = `openjarvis.apiKey:${baseUrl}`;
    if (clear) { await this.context.secrets.delete(key); return; }
    const value = await vscode.window.showInputBox({ title: 'OpenJarvis server API key', password: true, prompt: `Stored in VS Code SecretStorage for ${baseUrl}. This is the server key, not a model-provider key.`, ignoreFocusOut: true });
    if (value === undefined) return;
    if (value.trim()) await this.context.secrets.store(key, value.trim()); else await this.context.secrets.delete(key);
  }

  private async workspace(): Promise<{ folder: vscode.WorkspaceFolder; files: WorkspaceFiles }> {
    assertTrusted();
    const folders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'file') ?? [];
    if (!folders.length) throw new Error('Open a local filesystem workspace first.');
    if (!this.root || !folders.some(f => f.uri.toString() === this.root!.uri.toString())) {
      this.root = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: 'Choose the workspace for this chat' }))?.folder;
    }
    if (!this.root) throw new Error('No workspace selected.');
    const files = await WorkspaceFiles.open(this.root.uri.fsPath, absolute => vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === absolute)?.getText());
    return { folder: this.root, files };
  }
  async attach(): Promise<void> {
    if (this.controller) throw new Error('Wait for the current task before changing context.');
    const editor = this.latestEditor;
    if (!editor || editor.document.uri.scheme !== 'file') throw new Error('Open a workspace text file first.');
    const { files } = await this.workspace();
    const relative = path.relative(files.root, editor.document.uri.fsPath).split(path.sep).join('/');
    await files.read(relative); // Enforce the same path, ignore and size rules as tools.
    const content = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
    if (content.length > 20000) throw new Error('Select a smaller region (up to 20,000 characters).');
    this.attachment = { path: relative + (editor.selection.isEmpty ? '' : `:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`), content };
    this.render();
    await vscode.commands.executeCommand('openjarvis.chat.focus');
  }

  private async send(prompt: string): Promise<void> {
    if (this.controller || !prompt.trim()) return;
    if (prompt.length > 20000) throw new Error('Keep each request below 20,000 characters.');
    const cfg = settings();
    if (!cfg.model) throw new Error('Choose a model before sending a task. Your editor attachment is still available.');
    const controller = new AbortController();
    this.controller = controller;
    let started = false;
    this.emit({ kind: 'status', text: 'Preparing task' });
    try {
      const { folder, files } = await this.workspace();
      const client = await this.client(cfg);
      checkCancelled(controller.signal);
      const attachment = this.attachment;
      this.attachment = undefined;
      const userContent = `Workspace: ${folder.name}\n\n${prompt.trim()}` + (attachment ? `\n\nAttached task data (${attachment.path}):\n${attachment.content}` : '');
      const history: Message[] = [...this.history, { role: 'user', content: userContent }];
      void this.view?.webview.postMessage({ type: 'accepted', text: prompt });
      this.emit({ kind: 'user', text: prompt.trim() + (attachment ? `\n\nContext: ${attachment.path}` : '') });
      started = true;
      await runAgent(client, history, (name, args, signal) => this.execute(name, args, files, folder, signal), cfg,
        event => { if (this.controller === controller) this.emit(event); }, controller.signal);
      if (this.controller === controller) { this.history = history; this.status = 'Complete'; }
    } catch (error) {
      if (this.controller === controller) {
        this.emit({ kind: 'error', text: (error as Error).message });
        this.status = controller.signal.aborted ? 'Stopped' : 'Task interrupted';
        // Avoid retaining incomplete tool-call sequences after interruption.
        if (started) this.history = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'A previous task was interrupted. Some user-approved edits or commands may already have completed. Re-read relevant files before continuing.' }];
      }
    } finally {
      if (this.controller === controller) { this.controller = undefined; this.render(); }
    }
  }

  private async execute(name: string, args: Record<string, unknown>, files: WorkspaceFiles, folder: vscode.WorkspaceFolder, signal: AbortSignal): Promise<unknown> {
    assertTrusted(); checkCancelled(signal);
    switch (name) {
      case 'list_files': return files.list(textArg(args, 'path', ''), textArg(args, 'filter', ''), signal);
      case 'search_text': return files.search(textArg(args, 'query'), textArg(args, 'path', ''), signal);
      case 'read_file': {
        const text = await files.read(textArg(args, 'path'));
        const lines = text.split('\n');
        const start = args.start_line ?? 1, end = args.end_line ?? lines.length;
        if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 1 || Number(end) < Number(start)) throw new Error('Invalid line range.');
        return { path: args.path, start_line: start, end_line: Math.min(Number(end), lines.length), total_lines: lines.length, content: lines.slice(Number(start) - 1, Number(end)).join('\n') };
      }
      case 'get_diagnostics': {
        const requested = textArg(args, 'path', '');
        if (requested) await files.resolve(requested);
        const result: unknown[] = [];
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
          if (uri.scheme !== 'file') continue;
          const rel = path.relative(files.root, uri.fsPath).split(path.sep).join('/');
          if (requested && rel !== requested) continue;
          try { await files.resolve(rel); } catch { continue; }
          for (const d of diagnostics) {
            result.push({ path: rel, line: d.range.start.line + 1, severity: d.severity, message: d.message.slice(0, 1500) });
            if (result.length >= 50) return { diagnostics: result, truncated: true };
          }
        }
        return { diagnostics: result, truncated: false };
      }
      case 'propose_edit': return this.edit(files, args, signal);
      case 'run_command': return this.command(folder, args, signal);
      default: throw new Error('Unknown tool.');
    }
  }

  private async edit(files: WorkspaceFiles, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const relative = textArg(args, 'path');
    const absolute = await files.resolve(relative, true);
    const snapshot = await files.snapshot(relative);
    const before = snapshot.content;
    const after = replacementText(before, textArg(args, 'original'), textArg(args, 'replacement'));
    if (Buffer.byteLength(after) > MAX_FILE_BYTES) throw new Error('Proposed file exceeds 64 KB.');
    const oldUri = this.previews.add(before ?? '', path.basename(absolute));
    const newUri = this.previews.add(after, path.basename(absolute));
    try {
      checkCancelled(signal);
      await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, `OpenJarvis proposal: ${relative}`, { preview: true });
      checkCancelled(signal);
      // Non-modal: the user must be able to scroll and inspect the diff first.
      const approval = await vscode.window.showInformationMessage(`Review the diff for ${relative}. Applying also saves any existing unsaved content in this file.`, 'Apply and Save', 'Decline');
      checkCancelled(signal); assertTrusted();
      if (approval !== 'Apply and Save') return { applied: false, reason: 'User declined the edit. Do not request it again.' };
      if (await files.resolve(relative, true) !== absolute || !await files.unchanged(relative, snapshot)) throw new Error('The file changed during review. No edit was applied; read it again.');
      const uri = vscode.Uri.file(absolute);
      let document: vscode.TextDocument | undefined;
      if (before !== undefined) {
        document = await vscode.workspace.openTextDocument(uri);
        if (document.getText() !== before) throw new Error('The editor changed during review. No edit was applied.');
      } else {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(absolute)));
        await files.resolve(relative, true);
      }
      checkCancelled(signal);
      const edit = new vscode.WorkspaceEdit();
      if (!document) { edit.createFile(uri, { overwrite: false, ignoreIfExists: false }); edit.insert(uri, new vscode.Position(0, 0), after); }
      else edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(before!.length)), after);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the edit.');
      document = await vscode.workspace.openTextDocument(uri);
      const saved = await document.save();
      this.emit({ kind: 'tool', text: `${saved ? 'Applied and saved' : 'Applied, not saved'} · ${relative}` });
      return { applied: true, saved, path: relative, note: saved ? 'Save-time formatters may have changed the file; read it again before another edit.' : 'The edit is in the editor but saving failed. Ask the user to save it.' };
    } finally { this.previews.remove(oldUri, newUri); }
  }

  private async command(folder: vscode.WorkspaceFolder, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!settings().allowCommands) return { executed: false, reason: 'Terminal commands are disabled. Ask the user to enable them if needed.' };
    const command = textArg(args, 'command'), reason = textArg(args, 'reason');
    if (!command.trim() || command.length > 2000 || /[\r\n\0]/.test(command)) throw new Error('Use one command line of up to 2,000 characters.');
    const approval = await vscode.window.showWarningMessage('Run this command?', { modal: true, detail: `${command}\n\n${reason}\n\nFolder: ${folder.uri.fsPath}\nA shell command can access other files and the network. Output will appear in the VS Code terminal.` }, 'Run Command');
    checkCancelled(signal); assertTrusted();
    if (approval !== 'Run Command' || !settings().allowCommands) return { executed: false, reason: 'User declined the command. Do not request it again.' };
    if (vscode.workspace.textDocuments.some(d => d.isDirty && vscode.workspace.getWorkspaceFolder(d.uri)?.uri.toString() === folder.uri.toString())) {
      return { executed: false, reason: 'There are unsaved workspace documents. Ask the user to save or discard them before running commands.' };
    }
    const task = new vscode.Task({ type: 'openjarvis' }, folder, 'Approved command', 'OpenJarvis', new vscode.ShellExecution(command, { cwd: folder.uri.fsPath }));
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    return new Promise((resolve, reject) => {
      let execution: vscode.TaskExecution | undefined;
      let settled = false;
      const finish = (error?: Error, code?: number) => {
        if (settled) return;
        settled = true; clearTimeout(timer); processEnd.dispose(); taskEnd.dispose(); signal.removeEventListener('abort', abort);
        if (error) { execution?.terminate(); reject(error); }
        else resolve({ executed: true, exitCode: code ?? null, output: 'See the VS Code terminal. Output was not captured or sent to the model.' });
      };
      const processEnd = vscode.tasks.onDidEndTaskProcess(event => { if (event.execution === execution) finish(undefined, event.exitCode); });
      const taskEnd = vscode.tasks.onDidEndTask(event => { if (event.execution === execution) setTimeout(() => finish(), 100); });
      const abort = () => finish(new Error('Command cancelled. Check the terminal for any work already completed.'));
      const timer = setTimeout(() => finish(new Error('Command exceeded the two-minute limit and was terminated.')), 120000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void vscode.tasks.executeTask(task).then(result => { execution = result; if (settled) execution.terminate(); }, error => finish(error));
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const previews = new PreviewDocuments();
  const provider = new CodingAgentView(context, previews);
  context.subscriptions.push(provider, vscode.workspace.registerTextDocumentContentProvider('openjarvis-preview', previews),
    vscode.window.registerWebviewViewProvider('openjarvis.chat', provider));
  const commands: Record<string, () => unknown> = {
    'openjarvis.open': () => vscode.commands.executeCommand('openjarvis.chat.focus'),
    'openjarvis.configure': () => provider.configure(),
    'openjarvis.selectModel': () => provider.selectModel(),
    'openjarvis.setApiKey': () => provider.apiKey(),
    'openjarvis.clearApiKey': () => provider.apiKey(true),
    'openjarvis.attachSelection': () => provider.attach(),
    'openjarvis.newChat': () => provider.newChat(),
  };
  for (const [name, callback] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
    try { assertTrusted(); await callback(); } catch (error) { void vscode.window.showErrorMessage((error as Error).message); }
  }));
}
export function deactivate(): void {}
