import assert from 'node:assert/strict';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('CJAndrew84.openjarvis-coding-agent');
  assert(extension, 'extension is discoverable');
  await extension.activate();
  assert(extension.isActive, 'extension activates');
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['openjarvis.open', 'openjarvis.configure', 'openjarvis.selectModel', 'openjarvis.attachSelection', 'openjarvis.newChat']) assert(commands.includes(command), `${command} is registered`);
  assert.equal(vscode.workspace.getConfiguration('openjarvis').get('allowCommands'), false);
  assert.equal(vscode.workspace.getConfiguration('openjarvis').get('allowRemoteServer'), false);
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'sample.ts');
  await vscode.window.showTextDocument(uri);
  await vscode.commands.executeCommand('openjarvis.open');
  await vscode.commands.executeCommand('openjarvis.attachSelection');
  await vscode.commands.executeCommand('openjarvis.newChat');
  console.log('Extension host smoke tests passed: activation, commands, defaults, webview and editor context.');
}
