"use strict";

const { createHash } = require("node:crypto");
const noteDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The metadata cache selects real Markdown tasks, so fenced examples are never scanned.
function extractTasks(text, listItems) {
  const items = listItems ?? [];
  const byLine = new Map(items.map((item) => [item.position.start.line, item]));
  // Obsidian's parser strips the BOM, but Vault.process receives the original text.
  const bomLength = text.startsWith("\uFEFF") ? 1 : 0;
  const tasks = [];
  for (const item of items) {
    if (typeof item.task !== "string") continue;
    const { offset, line } = item.position.start;
    if (!Number.isInteger(offset) || offset < 0) continue;
    const start = offset + bomLength;
    const firstLine = text.slice(start).split(/[\r\n]/, 1)[0];
    const match = firstLine.match(
      /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[(.)\](?:[ \t]+|$)(.*)$/su,
    );
    if (!match || match[1] !== item.task) continue;
    let depth = 0,
      parent = item.parent;
    const visited = new Set([line]);
    while (parent >= 0 && byLine.has(parent) && !visited.has(parent)) {
      visited.add(parent);
      depth++;
      parent = byLine.get(parent).parent;
    }
    tasks.push({
      text: match[2],
      status: item.task,
      line,
      depth,
      statusOffset: start + firstLine.indexOf("[") + 1,
    });
  }
  return tasks;
}

const isChecked = (status) => /^[xX]$/.test(status);
const isEditable = (status) => status === " " || isChecked(status);
// Any status other than a blank ([x], [-], [<], [/] ...) counts as done.
const isDone = (status) => status !== " ";
const staleMessage =
  "表示後にノートが変更されたため保存しませんでした。更新されたTodoを確認して、もう一度操作してください";

function replaceTaskState(source, task, checked) {
  if (typeof checked !== "boolean" || !isEditable(task.status))
    throw new Error("このTodoの状態はチェック欄から変更できません");
  const at = task.statusOffset;
  if (
    !Number.isInteger(at) ||
    at < 1 ||
    source[at - 1] !== "[" ||
    source[at + 1] !== "]" ||
    source[at] !== task.status
  )
    throw new Error(staleMessage);
  if (isChecked(task.status) === checked) return source;
  return source.slice(0, at) + (checked ? "x" : " ") + source.slice(at + 1);
}

// Cache only visible notes. Replaced records and unloaded instances cannot publish late reads.
class TodoStore {
  constructor(app, changed) {
    this.app = app;
    this.changed = changed;
    this.records = new Map();
    this.writes = new Map();
    this.disposed = false;
  }
  get(file) {
    if (this.disposed) return { state: "pending", tasks: [] };
    if (this.records.has(file)) return this.records.get(file);
    const record = { state: "pending", tasks: [] };
    this.records.set(file, record);
    this.load(file, record);
    return record;
  }
  async load(file, pending) {
    const { metadataCache, vault } = this.app;
    const cache = metadataCache.getFileCache(file);
    if (!cache) return; // The metadata changed event will retry after parsing finishes.
    const path = file.path;
    let next;
    try {
      // Obsidian's metadata index keys this cache by the SHA-256 of the raw note.
      const hash = metadataCache.getFileInfo?.(path)?.hash;
      if (!hash) throw new Error("Todoの解析元を確認できません");
      const bytes = new Uint8Array(await vault.readBinary(file));
      if (
        path !== file.path ||
        cache !== metadataCache.getFileCache(file) ||
        hash !== metadataCache.getFileInfo(path)?.hash ||
        hash !== createHash("sha256").update(bytes).digest("hex")
      ) {
        next = {
          state: "error",
          tasks: [],
          message: "本文の解析更新を待っています",
        };
      } else {
        const text = noteDecoder.decode(bytes);
        next = {
          state: "ready",
          tasks: extractTasks(text, cache.listItems),
          source: text,
          path,
        };
      }
    } catch {
      next = {
        state: "error",
        tasks: [],
        message: "Todoを取得できません。ノート本文を確認してください",
      };
    }
    if (this.disposed || this.records.get(file) !== pending) return;
    this.records.set(file, next);
    this.changed();
  }
  isSaving(file) {
    return this.writes.has(file);
  }
  async setChecked(file, record, task, checked) {
    if (this.disposed) throw new Error("プラグインは無効です");
    if (this.writes.has(file))
      throw new Error("このノートのTodoを保存中です。完了後に操作してください");
    if (record.state !== "ready" || this.records.get(file) !== record)
      throw new Error(staleMessage);
    if (!record.tasks.includes(task)) throw new Error(staleMessage);
    const replacement = replaceTaskState(record.source, task, checked);
    if (replacement === record.source) return false;
    const operation = {};
    this.writes.set(file, operation);
    this.changed();
    let saved = false;
    try {
      await this.app.vault.process(file, (current) => {
        if (this.disposed)
          throw new Error("プラグインが無効になったため保存を中止しました");
        if (
          file.path !== record.path ||
          this.app.vault.getFileByPath(record.path) !== file ||
          current !== record.source
        )
          throw new Error(staleMessage);
        // A source editor may contain changes which have not reached the vault yet.
        this.app.workspace?.iterateAllLeaves((leaf) => {
          const view = leaf.view;
          if (
            view?.file === file &&
            view.getMode?.() === "source" &&
            view.editor?.getValue() !== current
          )
            throw new Error(staleMessage);
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
  invalidate(file) {
    this.records.delete(file);
  }
  retain(files) {
    for (const file of this.records.keys())
      if (!files.has(file)) this.records.delete(file);
  }
  dispose() {
    this.disposed = true;
    this.records.clear();
    this.writes.clear();
  }
}

class TodoPanels {
  constructor(store, reportError = () => {}) {
    this.store = store;
    this.reportError = reportError;
    this.roots = new Set();
    this.cards = new Map();
    this.disposed = false;
  }
  lockControls(file) {
    for (const binding of this.cards.values())
      if (binding.file === file) {
        for (const checkbox of binding.panel.querySelectorAll(
          'input[type="checkbox"]',
        ))
          checkbox.disabled = true;
      }
  }
  finishControls(file) {
    if (this.disposed) return;
    for (const binding of this.cards.values())
      if (binding.file === file) binding.record = null;
    this.store.changed();
  }
  update(boards, hideCompleted) {
    if (this.disposed) return false;
    const roots = new Set(),
      cards = new Map(),
      files = new Set();
    let geometryChanged = false;
    for (const board of boards) {
      if (!board.compatible || !board.todos) continue;
      const root = board.root;
      roots.add(root);
      if (!this.roots.has(root)) {
        root.style.setProperty(
          "--bka-todo-native-bottom",
          board.todos.paddingBottom,
        );
        root.classList.add("bka-todos");
        geometryChanged = true;
      }
      for (const card of board.todos.cards) {
        cards.set(card.element, card.file);
        files.add(card.file);
      }
    }
    this.store.retain(files);
    for (const root of this.roots)
      if (!roots.has(root)) {
        root.classList.remove("bka-todos");
        root.style.removeProperty("--bka-todo-native-bottom");
        geometryChanged = true;
      }
    for (const [element, binding] of this.cards)
      if (!cards.has(element)) {
        binding.panel.remove();
        this.cards.delete(element);
      }
    for (const [element, file] of cards) {
      const record = this.store.get(file);
      let binding = this.cards.get(element);
      if (binding?.file !== file) {
        binding?.panel.remove();
        const doc = element.ownerDocument,
          panel = doc.createElement("div");
        panel.className = "bka-todo-panel";
        panel.tabIndex = 0;
        panel.setAttribute("role", "group");
        panel.setAttribute("aria-label", "本文のTodo");
        for (const name of [
          "click",
          "dblclick",
          "auxclick",
          "pointerdown",
          "mousedown",
          "touchstart",
        ])
          panel.addEventListener(name, (event) => event.stopPropagation());
        panel.addEventListener("keydown", (event) => {
          if (event.key === " " || event.key === "Enter")
            event.stopPropagation();
        });
        panel.addEventListener("dragstart", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        binding = { file, panel, record: null };
        this.cards.set(element, binding);
      }
      binding.panel.dataset.source = file.path;
      if (binding.panel.parentElement !== element)
        element.appendChild(binding.panel);
      const saving = this.store.isSaving(file);
      if (
        binding.record !== record ||
        binding.saving !== saving ||
        binding.hideCompleted !== hideCompleted
      ) {
        this.render(binding.panel, record, file, saving, hideCompleted);
        binding.record = record;
        binding.saving = saving;
        binding.hideCompleted = hideCompleted;
      }
    }
    this.roots = roots;
    return geometryChanged;
  }
  render(panel, record, file, saving, hideCompleted) {
    const scroll = panel.scrollTop,
      doc = panel.ownerDocument;
    const fragment = doc.createDocumentFragment();
    const heading = fragment.appendChild(doc.createElement("div"));
    heading.className = "bka-todo-heading";
    heading.textContent =
      record.state === "ready"
        ? `Todo (${record.tasks.filter((task) => isDone(task.status)).length} / ${record.tasks.length})`
        : "Todo";
    panel.setAttribute("aria-busy", String(saving));
    if (record.state !== "ready" || !record.tasks.length) {
      const message = fragment.appendChild(doc.createElement("div"));
      message.className = "bka-todo-message";
      message.textContent =
        record.state === "pending"
          ? "読み込み中…"
          : record.state === "error"
            ? record.message
            : "Todoなし";
    } else
      for (const task of record.tasks) {
        // A hidden parent leaves its open children in place, keeping their indentation.
        if (hideCompleted && isDone(task.status)) continue;
        const row = fragment.appendChild(doc.createElement("div"));
        row.className = "bka-todo-row";
        row.style.marginInlineStart = `${Math.min(task.depth, 6) * 12}px`;
        row.dataset.taskStatus = task.status;
        if (isEditable(task.status)) {
          const checkbox = row.appendChild(doc.createElement("input"));
          checkbox.type = "checkbox";
          checkbox.disabled = saving;
          checkbox.checked = isChecked(task.status);
          checkbox.setAttribute(
            "aria-label",
            `${checkbox.checked ? "完了" : "未完了"}: ${task.text}`,
          );
          checkbox.addEventListener("change", async () => {
            const checked = checkbox.checked;
            // Disable every displayed copy immediately, including before the next paint.
            this.lockControls(file);
            try {
              await this.store.setChecked(file, record, task, checked);
            } catch (error) {
              checkbox.checked = isChecked(task.status);
              if (!this.disposed)
                this.reportError(
                  `Todoを保存できませんでした。${error.message}`,
                );
            } finally {
              this.finishControls(file);
            }
          });
          if (checkbox.checked) row.classList.add("is-complete");
        } else {
          const marker = row.appendChild(doc.createElement("span"));
          marker.className = "bka-todo-marker";
          marker.textContent = `[${task.status}]`;
        }
        const text = row.appendChild(doc.createElement("span"));
        text.className = "bka-todo-text";
        text.textContent = task.text;
      }
    panel.replaceChildren(fragment);
    panel.scrollTop = scroll;
  }
  dispose() {
    this.disposed = true;
    for (const binding of this.cards.values()) binding.panel.remove();
    for (const root of this.roots) {
      root.classList.remove("bka-todos");
      root.style.removeProperty("--bka-todo-native-bottom");
    }
    this.cards.clear();
    this.roots.clear();
  }
}

module.exports = { extractTasks, replaceTaskState, TodoStore, TodoPanels };
