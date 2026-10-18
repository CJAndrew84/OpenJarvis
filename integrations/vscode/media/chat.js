/* No network calls or persistent storage in the webview. */
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  let busy = false;
  let previousEvents = '';
  function content(parent, text) {
    // Plain DOM text nodes only. Model output is never interpreted as HTML.
    const parts = text.split(/(```[\s\S]*?```)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith('```') && part.endsWith('```')) {
        const block = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = part.slice(3, -3).replace(/^[^\n]*\n/, '');
        block.appendChild(code); parent.appendChild(block);
      } else { const p = document.createElement('p'); p.textContent = part; parent.appendChild(p); }
    }
  }
  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'accepted') {
      if ($('prompt').value === data.text) $('prompt').value = '';
      return;
    }
    if (!data || data.type !== 'state') return;
    busy = data.busy;
    $('send').hidden = busy; $('stop').hidden = !busy;
    for (const id of ['attach', 'remove', 'commands', 'configure', 'model']) $(id).disabled = busy;
    $('model').textContent = data.model || 'Choose model';
    $('endpoint').textContent = data.endpoint;
    $('status').textContent = data.status + (data.root ? ` · ${data.root}` : '');
    $('commands').checked = data.allowCommands;
    $('attachment').hidden = !data.attachment;
    $('attachment').querySelector('span').textContent = data.attachment;
    $('welcome').hidden = data.events.length > 0;
    const serialized = JSON.stringify(data.events);
    if (serialized !== previousEvents) {
      previousEvents = serialized;
      const list = $('messages'); list.replaceChildren();
      for (const event of data.events) {
        const item = document.createElement('article'); item.className = `message ${event.kind}`;
        if (event.kind !== 'tool') { const label = document.createElement('div'); label.className = 'label'; label.textContent = event.kind === 'user' ? 'YOU' : event.kind === 'error' ? 'ATTENTION' : 'OPENJARVIS'; item.appendChild(label); }
        content(item, event.text); list.appendChild(item);
      }
      $('thread').scrollTop = $('thread').scrollHeight;
    }
  });
  $('composer').addEventListener('submit', event => {
    event.preventDefault(); if (busy || !$('prompt').value.trim()) return;
    post('send', { text: $('prompt').value });
  });
  $('prompt').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
  });
  for (const id of ['new', 'attach', 'stop', 'configure', 'model', 'remove']) $(id).addEventListener('click', () => post(id));
  $('commands').addEventListener('change', () => post('commands', { enabled: $('commands').checked }));
  for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); });
  post('ready');
})();
