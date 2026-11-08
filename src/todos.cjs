'use strict';
const { insertTodo } = require('./todo-insertion.cjs');

// The metadata cache selects real Markdown tasks, so fenced examples are never scanned.
function extractTasks(text, listItems) {
  const items = listItems ?? [];
  const byLine = new Map(items.map(item => [item.position.start.line, item]));
  return items.filter(item => typeof item.task === 'string').map(item => {
    const { offset, line } = item.position.start;
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new Error('Todoの位置を確認できません');
    const firstLine = text.slice(offset).split(/\r?\n/, 1)[0];
    const match = firstLine.match(/^(?:[-+*]|\d{1,9}[.)])[ \t]+\[([^\]\r\n])\](?:[ \t]+|$)(.*)$/u);
    if (!match || match[1] !== item.task) throw new Error('本文の解析更新を待っています');
    let depth = 0, parent = item.parent;
    const visited = new Set([line]);
    while (parent >= 0 && byLine.has(parent)) {
      if (visited.has(parent)) throw new Error('Todoの階層を確認できません');
      visited.add(parent); depth++; parent = byLine.get(parent).parent;
    }
    return { text: match[2], status: item.task, line, depth, statusOffset: offset + firstLine.indexOf('[') + 1 };
  });
}

const isChecked = status => /^[xX]$/.test(status);
const isEditable = status => status === ' ' || isChecked(status);
// Any status other than a blank ([x], [-], [<], [/] ...) counts as done.
const isDone = status => status !== ' ';
const staleMessage = '表示後にノートが変更されたため保存しませんでした。更新されたTodoを確認して、もう一度操作してください';

function replaceTaskState(source, task, checked) {
  if (typeof checked !== 'boolean' || !isEditable(task.status)) throw new Error('このTodoの状態はチェック欄から変更できません');
  const at = task.statusOffset;
  if (!Number.isInteger(at) || at < 1 || source[at - 1] !== '[' || source[at + 1] !== ']' || source[at] !== task.status) throw new Error(staleMessage);
  if (isChecked(task.status) === checked) return source;
  return source.slice(0, at) + (checked ? 'x' : ' ') + source.slice(at + 1);
}

// Cache only visible notes. Replaced records and unloaded instances cannot publish late reads.
class TodoStore {
  constructor(app, changed) { this.app = app; this.changed = changed; this.records = new Map(); this.writes = new Map(); this.disposed = false; }
  get(file) {
    if (this.disposed) return { state: 'pending', tasks: [] };
    if (this.records.has(file)) return this.records.get(file);
    const record = { state: 'pending', tasks: [] };
    this.records.set(file, record);
    this.load(file, record);
    return record;
  }
  async load(file, pending) {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return; // The metadata changed event will retry after parsing finishes.
    const path = file.path, mtime = file.stat.mtime, size = file.stat.size;
    let next;
    try {
      const text = await this.app.vault.cachedRead(file);
      if (cache !== this.app.metadataCache.getFileCache(file) || path !== file.path || mtime !== file.stat.mtime || size !== file.stat.size) {
        next = { state: 'error', tasks: [], message: '本文の解析更新を待っています' };
      } else next = { state: 'ready', tasks: extractTasks(text, cache.listItems), source: text, path,
        headings: cache.headings ?? [], sections: cache.sections ?? [] };
    } catch {
      next = { state: 'error', tasks: [], message: 'Todoを取得できません。ノート本文を確認してください' };
    }
    if (this.disposed || this.records.get(file) !== pending) return;
    this.records.set(file, next); this.changed();
  }
  isSaving(file) { return this.writes.has(file); }
  setChecked(file, record, task, checked) {
    return this.writeSource(file, record, () => {
      if (!record.tasks.includes(task)) throw new Error(staleMessage);
      return replaceTaskState(record.source, task, checked);
    });
  }
  addTask(file, record, text) {
    return this.writeSource(file, record, () => insertTodo(record.source, record.headings, record.sections, text));
  }
  async writeSource(file, record, update) {
    if (this.disposed) throw new Error('プラグインは無効です');
    if (this.writes.has(file)) throw new Error('このノートのTodoを保存中です。完了後に操作してください');
    if (record.state !== 'ready' || this.records.get(file) !== record) throw new Error(staleMessage);
    const replacement = update();
    if (replacement === record.source) return false;
    const operation = {};
    this.writes.set(file, operation); this.changed();
    let saved = false;
    try {
      await this.app.vault.process(file, current => {
        if (this.disposed) throw new Error('プラグインが無効になったため保存を中止しました');
        if (file.path !== record.path || this.app.vault.getFileByPath(record.path) !== file || current !== record.source) throw new Error(staleMessage);
        // A source editor may contain changes which have not reached the vault yet.
        this.app.workspace?.iterateAllLeaves(leaf => {
          const view = leaf.view;
          if (view?.file === file && view.getMode?.() === 'source' && view.editor?.getValue() !== current) throw new Error(staleMessage);
        });
        return replacement;
      });
      saved = true;
      return true;
    } finally {
      if (this.writes.get(file) === operation) this.writes.delete(file);
      if (!saved || this.records.get(file) === record) this.invalidate(file);
      if (!this.disposed) this.changed();
    }
  }
  invalidate(file) { this.records.delete(file); }
  retain(files) { for (const file of this.records.keys()) if (!files.has(file)) this.records.delete(file); }
  dispose() { this.disposed = true; this.records.clear(); this.writes.clear(); }
}

class TodoPanels {
  constructor(store, reportError = () => {}) {
    this.store = store; this.reportError = reportError; this.roots = new Set(); this.cards = new Map(); this.disposed = false;
    this.drafts = new Map(); this.focusRequests = new Map(); this.selections = new WeakMap(); this.focusDocuments = new Map();
  }
  observeFocus(doc) {
    if (this.focusDocuments.has(doc)) return;
    const clear = event => {
      for (const [file, panel] of this.focusRequests) if (panel.ownerDocument === doc) {
        const inside = panel.contains(event.target);
        if (!inside || (event.type === 'focusin' && !event.target.matches?.('.bka-todo-new, .bka-todo-add'))) this.focusRequests.delete(file);
      }
    };
    doc.addEventListener('pointerdown', clear, true); doc.addEventListener('focusin', clear);
    this.focusDocuments.set(doc, () => { doc.removeEventListener('pointerdown', clear, true); doc.removeEventListener('focusin', clear); });
  }
  lockControls(file) {
    for (const binding of this.cards.values()) if (binding.file === file) {
      for (const control of binding.panel.querySelectorAll('input, button')) control.disabled = true;
    }
  }
  finishControls(file) {
    if (this.disposed) return;
    for (const binding of this.cards.values()) if (binding.file === file) binding.record = null;
    this.store.changed();
  }
  setDraft(file, text) {
    const draft = { text };
    if (text) this.drafts.set(file, draft); else this.drafts.delete(file);
    this.syncDraft(file);
    return draft;
  }
  syncDraft(file) {
    for (const binding of this.cards.values()) if (binding.file === file) {
      const input = binding.panel.querySelector('.bka-todo-new'), button = binding.panel.querySelector('.bka-todo-add');
      if (input && input.value !== (this.drafts.get(file)?.text ?? '')) input.value = this.drafts.get(file)?.text ?? '';
      if (button) button.disabled = this.store.isSaving(file) || binding.record?.state !== 'ready' || !input?.value.trim();
    }
  }
  update(boards, hideCompleted) {
    if (this.disposed) return false;
    const roots = new Set(), cards = new Map(), files = new Set();
    let geometryChanged = false;
    for (const board of boards) {
      if (!board.compatible || !board.todos) continue;
      const root = board.root;
      roots.add(root);
      if (!this.roots.has(root)) {
        root.style.setProperty('--bka-todo-native-bottom', board.todos.paddingBottom);
        root.classList.add('bka-todos'); geometryChanged = true;
      }
      for (const card of board.todos.cards) { cards.set(card.element, card.file); files.add(card.file); }
    }
    this.store.retain(files);
    for (const root of this.roots) if (!roots.has(root)) {
      root.classList.remove('bka-todos'); root.style.removeProperty('--bka-todo-native-bottom'); geometryChanged = true;
    }
    for (const [element, binding] of this.cards) if (!cards.has(element)) { binding.panel.remove(); this.cards.delete(element); }
    for (const [element, file] of cards) {
      const record = this.store.get(file);
      let binding = this.cards.get(element);
      if (binding?.file !== file) {
        binding?.panel.remove();
        const doc = element.ownerDocument, panel = doc.createElement('div');
        this.observeFocus(doc);
        panel.className = 'bka-todo-panel'; panel.tabIndex = 0;
        panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', '本文のTodo');
        for (const name of ['click', 'dblclick', 'auxclick', 'pointerdown', 'mousedown', 'touchstart']) panel.addEventListener(name, event => event.stopPropagation());
        panel.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation(); });
        panel.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation(); });
        binding = { file, panel, record: null };
        this.cards.set(element, binding);
      }
      binding.panel.dataset.source = file.path;
      if (binding.panel.parentElement !== element) element.appendChild(binding.panel);
      const saving = this.store.isSaving(file);
      if (binding.record !== record || binding.saving !== saving || binding.hideCompleted !== hideCompleted) {
        this.render(binding.panel, record, file, saving, hideCompleted);
        binding.record = record; binding.saving = saving; binding.hideCompleted = hideCompleted;
      }
      // Native rendering may detach and reattach an unchanged panel, dropping focus.
      const input = binding.panel.querySelector('.bka-todo-new');
      if (this.focusRequests.get(file) === binding.panel && input && !input.disabled && input.ownerDocument.activeElement !== input) {
        const selection = this.selections.get(binding.panel);
        input.focus({ preventScroll: true });
        if (selection) input.setSelectionRange(...selection);
      }
    }
    this.roots = roots;
    return geometryChanged;
  }
  render(panel, record, file, saving, hideCompleted) {
    const scroll = panel.scrollTop, doc = panel.ownerDocument;
    const activeInput = doc.activeElement;
    const editing = panel.contains(activeInput) && activeInput.matches?.('.bka-todo-new');
    const selection = editing ? [activeInput.selectionStart, activeInput.selectionEnd, activeInput.selectionDirection] : null;
    const fragment = doc.createDocumentFragment();
    const heading = fragment.appendChild(doc.createElement('div'));
    heading.className = 'bka-todo-heading';
    heading.textContent = record.state === 'ready'
      ? `Todo (${record.tasks.filter(task => isDone(task.status)).length} / ${record.tasks.length})` : 'Todo';
    panel.setAttribute('aria-busy', String(saving));
    const form = fragment.appendChild(doc.createElement('form'));
    form.className = 'bka-todo-form';
    const input = form.appendChild(doc.createElement('input'));
    input.type = 'text'; input.className = 'bka-todo-new'; input.placeholder = '新しいTodo';
    input.setAttribute('aria-label', '追加するTodo'); input.autocomplete = 'off';
    input.value = this.drafts.get(file)?.text ?? ''; input.disabled = saving || record.state !== 'ready';
    if (editing) {
      this.selections.set(panel, selection);
      if (input.disabled) this.focusRequests.set(file, panel);
    }
    const button = form.appendChild(doc.createElement('button'));
    button.type = 'submit'; button.className = 'bka-todo-add'; button.textContent = '追加';
    button.disabled = input.disabled || !input.value.trim();
    const remember = () => {
      this.focusRequests.set(file, panel);
      this.selections.set(panel, [input.selectionStart, input.selectionEnd, input.selectionDirection]);
    };
    for (const name of ['focus', 'select', 'keyup']) input.addEventListener(name, remember);
    input.addEventListener('input', () => this.setDraft(file, input.value));
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); form.requestSubmit();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault(); event.stopPropagation();
      if (this.disposed || this.store.isSaving(file) || record.state !== 'ready' || !input.value.trim()) return;
      const draft = this.setDraft(file, input.value);
      this.focusRequests.set(file, panel); this.lockControls(file);
      try {
        await this.store.addTask(file, record, draft.text);
        if (this.drafts.get(file) === draft) { this.drafts.delete(file); this.syncDraft(file); }
      } catch (error) {
        if (!this.disposed) this.reportError(`Todoを追加できませんでした。${error.message}`);
      } finally { this.finishControls(file); }
    });
    if (record.state !== 'ready' || !record.tasks.length) {
      const message = fragment.appendChild(doc.createElement('div'));
      message.className = 'bka-todo-message';
      message.textContent = record.state === 'pending' ? '読み込み中…' : record.state === 'error' ? record.message : 'Todoなし';
    } else for (const task of record.tasks) {
      // A hidden parent leaves its open children in place, keeping their indentation.
      if (hideCompleted && isDone(task.status)) continue;
      const row = fragment.appendChild(doc.createElement('div'));
      row.className = 'bka-todo-row'; row.style.marginInlineStart = `${Math.min(task.depth, 6) * 12}px`;
      row.dataset.taskStatus = task.status;
      if (isEditable(task.status)) {
        const checkbox = row.appendChild(doc.createElement('input'));
        checkbox.type = 'checkbox'; checkbox.disabled = saving; checkbox.checked = isChecked(task.status);
        checkbox.setAttribute('aria-label', `${checkbox.checked ? '完了' : '未完了'}: ${task.text}`);
        checkbox.addEventListener('change', async () => {
          const checked = checkbox.checked;
          // Disable every displayed copy immediately, including before the next paint.
          this.lockControls(file);
          try { await this.store.setChecked(file, record, task, checked); }
          catch (error) {
            checkbox.checked = isChecked(task.status);
            if (!this.disposed) this.reportError(`Todoを保存できませんでした。${error.message}`);
          } finally {
            this.finishControls(file);
          }
        });
        if (checkbox.checked) row.classList.add('is-complete');
      } else {
        const marker = row.appendChild(doc.createElement('span'));
        marker.className = 'bka-todo-marker'; marker.textContent = `[${task.status}]`;
      }
      const text = row.appendChild(doc.createElement('span'));
      text.className = 'bka-todo-text'; text.textContent = task.text;
    }
    panel.replaceChildren(fragment); panel.scrollTop = scroll;
    if (!input.disabled && (editing || this.focusRequests.get(file) === panel)) {
      const restoreSelection = selection ?? this.selections.get(panel);
      input.focus({ preventScroll: true });
      if (restoreSelection) input.setSelectionRange(...restoreSelection);
    }
  }
  dispose() {
    this.disposed = true;
    for (const binding of this.cards.values()) binding.panel.remove();
    for (const root of this.roots) { root.classList.remove('bka-todos'); root.style.removeProperty('--bka-todo-native-bottom'); }
    for (const dispose of this.focusDocuments.values()) dispose();
    this.cards.clear(); this.roots.clear(); this.drafts.clear(); this.focusRequests.clear(); this.focusDocuments.clear();
  }
}

module.exports = { extractTasks, replaceTaskState, TodoStore, TodoPanels };
