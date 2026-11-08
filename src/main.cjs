"use strict";
const { Plugin, Notice, normalizePath } = require("obsidian");
const { emptySettings, SettingsStore } = require("./settings/store.cjs");
const { NativeKanbanAdapter } = require("./kanban/native-adapter.cjs");
const { Appearance } = require("./appearance/appearance.cjs");
const { KanbanSettingTab } = require("./settings/tab.cjs");
const { TodoStore, TodoPanels } = require("./todos/todos.cjs");

const CSS = [
  require("./appearance/board.css"),
  require("./settings/tab.css"),
  require("./todos/panel.css"),
].join("\n");

module.exports = class BasesKanbanAppearance extends Plugin {
  async onload() {
    this.settings = new SettingsStore();
    this.appearance = new Appearance(CSS);
    this.stopped = false;
    this.settingsQueue = Promise.resolve();
    this.settingsText = null;
    this.settingsLoadError = null;
    this.todoStore = new TodoStore(this.app, () => this.adapter.schedule());
    this.todos = new TodoPanels(
      this.todoStore,
      (message) => new Notice(message, 8000),
    );
    this.adapter = new NativeKanbanAdapter(
      this.app,
      document,
      (boards, documents) => {
        const appearanceChanged = this.appearance.update(
          boards,
          documents,
          this.settings.current,
        );
        const { showTodos, hideCompletedTodos } = this.settings.current;
        // Hidden Todos release every panel, the reserved card space, and the cached note bodies.
        const todosChanged = this.todos.update(
          showTodos ? boards : [],
          hideCompletedTodos,
        );
        if (appearanceChanged || todosChanged)
          this.app.workspace.trigger("css-change");
      },
      (message) => console.warn(`[Bases Kanban Appearance] ${message}`),
    );
    this.addCommand({
      id: "reload-settings",
      name: "設定を再読み込み",
      callback: () => this.reloadSettings(true),
    });
    this.addCommand({
      id: "toggle-todos",
      name: "本文Todoの表示を切り替え",
      callback: () => this.toggleTodos(),
    });
    for (const name of [
      "layout-change",
      "active-leaf-change",
      "css-change",
      "window-open",
      "window-close",
    ]) {
      this.registerEvent(
        this.app.workspace.on(name, () => this.adapter.schedule()),
      );
    }
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.todoStore.invalidate(file);
        this.adapter.schedule();
      }),
    );
    for (const name of ["rename", "modify", "delete"]) {
      this.registerEvent(
        this.app.vault.on(name, (file) => {
          if (name === "rename" || name === "delete")
            this.todoStore.invalidate(file);
          if (
            file.extension === "base" ||
            name === "rename" ||
            name === "delete"
          )
            this.adapter.schedule();
        }),
      );
    }
    await this.reloadSettings(false);
    this.settingsTab = new KanbanSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.app.workspace.onLayoutReady(() => {
      if (!this.stopped) this.adapter.refresh();
    });
  }
  settingsPath() {
    const dir =
      this.manifest.dir ??
      `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(`${dir}/data.json`);
  }
  queueSettings(operation) {
    const result = this.settingsQueue.then(operation);
    this.settingsQueue = result.catch(() => {});
    return result;
  }
  reloadSettings(notify) {
    return this.queueSettings(() => this.readSettings(notify));
  }
  async readSettings(notify) {
    const path = this.settingsPath();
    try {
      let text;
      const result = await this.settings.reload(async () => {
        // loadData() returns null for multiple conditions. An explicit existence check
        // distinguishes an absent file from an existing invalid/null document.
        if (!(await this.app.vault.adapter.exists(path))) {
          const initial = emptySettings();
          await this.saveData(initial);
        }
        text = await this.app.vault.adapter.read(path);
        return JSON.parse(text);
      });
      if (result.stale || this.stopped) return false;
      this.settingsText = text;
      this.settingsLoadError = null;
      this.adapter.schedule();
      if (notify)
        new Notice(
          `Kanbanの設定を再読み込みしました（${result.viewCount}ビュー）`,
        );
      return true;
    } catch (error) {
      if (this.stopped) return false;
      this.settingsLoadError = error.message;
      console.warn(
        "[Bases Kanban Appearance] Settings rejected:",
        error.message,
      );
      new Notice(
        `Kanbanの設定を読み込めません。直前の設定を維持します。\n${path}\n${error.message}`,
        10000,
      );
      return false;
    }
  }
  saveSettingsFromEditor(input, expectedText) {
    return this.queueSettings(async () => {
      if (this.stopped) throw new Error("プラグインは無効です");
      let savedText;
      const result = await this.settings.save(input, async (data) => {
        const path = this.settingsPath();
        const exists = await this.app.vault.adapter.exists(path);
        const actual = exists ? await this.app.vault.adapter.read(path) : null;
        if (this.settingsLoadError || actual !== expectedText)
          throw new Error(
            "設定ファイルが別の場所で変更されました。保存済み設定を読み直してから編集してください。",
          );
        savedText = JSON.stringify(data, null, 2) + "\n";
        await this.app.vault.adapter.write(path, savedText);
      });
      if (result.stale || this.stopped) return false;
      this.settingsText = savedText;
      this.settingsLoadError = null;
      this.adapter.schedule();
      return true;
    });
  }
  // Saves immediately through the same compare-and-swap as the settings tab, then rebases its draft.
  async toggleTodos() {
    if (this.settingsLoadError) {
      new Notice(
        "設定ファイルを読み込めないため切り替えできません。設定画面を確認してください",
        8000,
      );
      return false;
    }
    const showTodos = !this.settings.current.showTodos;
    try {
      if (
        !(await this.saveSettingsFromEditor(
          { ...this.settings.data, showTodos },
          this.settingsText,
        ))
      )
        return false;
      this.settingsTab?.applyExternalChange(
        this.settings.data,
        this.settingsText,
      );
      new Notice(
        showTodos ? "本文Todoを表示します" : "本文Todoを非表示にします",
      );
      return true;
    } catch (error) {
      if (!this.stopped)
        new Notice(`Todo表示を切り替えられません。${error.message}`, 8000);
      return false;
    }
  }
  onunload() {
    this.stopped = true;
    this.settings?.dispose();
    this.adapter?.dispose();
    this.todoStore?.dispose();
    this.todos?.dispose();
    this.appearance?.dispose();
    this.app.workspace.trigger("css-change");
  }
};
