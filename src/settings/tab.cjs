"use strict";
const { PluginSettingTab, Setting, Notice, parseYaml } = require("obsidian");
const { PRESETS, compileSettings } = require("./store.cjs");
const { discover } = require("../kanban/native-adapter.cjs");

const keyOf = (view) =>
  JSON.stringify([view.basePath, view.viewName, view.groupBy]);
const labels = {
  gray: "グレー",
  red: "レッド",
  orange: "オレンジ",
  yellow: "イエロー",
  green: "グリーン",
  blue: "ブルー",
  purple: "パープル",
  pink: "ピンク",
};
const copy = (value) => JSON.parse(JSON.stringify(value));

class KanbanSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.draft = null;
    this.dirty = false;
    this.busy = false;
    this.catalog = new Map();
    this.selectedKey = null;
    this.renderGeneration = 0;
  }
  async display() {
    const generation = ++this.renderGeneration;
    if (!this.draft || !this.dirty) this.resetDraft();
    this.render();
    const catalog = new Map();
    for (const file of this.app.vault
      .getFiles()
      .filter((file) => file.extension === "base")) {
      try {
        const definition = parseYaml(await this.app.vault.cachedRead(file));
        for (const view of definition?.views ?? []) {
          const property = view.groupBy?.property;
          if (
            view.type !== "kanban" ||
            typeof view.name !== "string" ||
            typeof property !== "string" ||
            !property
          )
            continue;
          const item = {
            basePath: file.path,
            viewName: view.name,
            groupBy: /^(note|file|formula)\./.test(property)
              ? property
              : `note.${property}`,
          };
          catalog.set(keyOf(item), item);
        }
      } catch {
        /* An invalid Base is omitted; its saved rule remains editable. */
      }
    }
    if (generation !== this.renderGeneration || this.plugin.stopped) return;
    this.catalog = catalog;
    this.render();
  }
  resetDraft() {
    this.draft = copy(this.plugin.settings.data);
    this.expectedText = this.plugin.settingsText;
    this.dirty = false;
    this.message = "";
    this.messageError = false;
  }
  views() {
    const views = new Map(this.catalog);
    for (const view of this.draft.views) views.set(keyOf(view), view);
    return views;
  }
  rule(create = false) {
    let rule = this.draft.views.find(
      (view) => keyOf(view) === this.selectedKey,
    );
    if (!rule && create) {
      const view = this.views().get(this.selectedKey);
      if (!view) throw new Error("配色するビューを選択してください");
      rule = {
        basePath: view.basePath,
        viewName: view.viewName,
        groupBy: view.groupBy,
        colors: {},
      };
      this.draft.views.push(rule);
    }
    return rule;
  }
  knownStatuses() {
    const statuses = new Set(Object.keys(this.rule()?.colors ?? {}));
    const { controllers } = discover(
      this.app.workspace,
      this.containerEl.ownerDocument,
    );
    for (const c of controllers.values()) {
      const key = JSON.stringify([
        c.query?.file?.path,
        c.viewName,
        c.view.config?.groupBy?.property,
      ]);
      if (key !== this.selectedKey || !Array.isArray(c.view.columns)) continue;
      for (const col of c.view.columns) {
        const value = col.group?.key;
        if (
          (value?.type?.type ?? value?.constructor?.type) === "String" &&
          typeof value.data === "string" &&
          value.data.length
        )
          statuses.add(value.data);
      }
    }
    return [...statuses].sort((a, b) => a.localeCompare(b));
  }
  setColor(status, value) {
    const rule = this.rule(value !== null);
    if (value === null) {
      if (rule) delete rule.colors[status];
    } else
      Object.defineProperty(rule.colors, status, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    this.dirty = true;
    this.message = "";
    this.messageError = false;
    this.updateState();
  }
  validationError() {
    try {
      compileSettings(this.draft);
      return null;
    } catch (error) {
      return error.message;
    }
  }
  updateState() {
    const error = this.validationError();
    const loadError = this.plugin.settingsLoadError;
    this.saveButton?.setDisabled(
      this.busy || !this.dirty || !!error || !!loadError,
    );
    if (this.statusEl) {
      this.statusEl.textContent = loadError
        ? `設定ファイルを読み込めません。ファイルを修正して「保存済み設定に戻す」を押してください。${loadError}`
        : this.message ||
          error ||
          (this.busy
            ? "保存中…"
            : this.dirty
              ? "未保存の変更があります。保存するとボードへ反映します。"
              : "保存済みの設定を表示しています。");
      this.statusEl.classList.toggle(
        "bka-setting-error",
        !!loadError || !!error || !!this.messageError,
      );
    }
  }
  async save() {
    if (
      this.busy ||
      !this.dirty ||
      this.validationError() ||
      this.plugin.settingsLoadError
    )
      return false;
    this.busy = true;
    this.render();
    try {
      if (
        !(await this.plugin.saveSettingsFromEditor(
          this.draft,
          this.expectedText,
        ))
      )
        return false;
      this.resetDraft();
      this.message = "保存してボードへ反映しました。";
      this.messageError = false;
      new Notice(this.message);
      return true;
    } catch (error) {
      this.message = error.message;
      this.messageError = true;
      new Notice(`設定を保存できません。${error.message}`, 8000);
      return false;
    } finally {
      this.busy = false;
      this.render();
    }
  }
  applyTodoToggle(showTodos, previousText, text) {
    const visible = this.containerEl.isConnected;
    if (!this.draft || !this.dirty) {
      if (visible) this.display();
      return;
    }
    // Rebase only drafts whose base contains all saved changes before the toggle.
    if (this.expectedText !== previousText) return;
    this.draft.showTodos = showTodos;
    this.expectedText = text;
    this.message = "";
    this.messageError = false;
    if (visible) this.render();
  }
  render() {
    const container = this.containerEl;
    container.empty();
    container.addClass("bka-settings");
    container.createEl("h2", { text: "Bases Kanban Appearance" });
    container.createEl("p", {
      text: "本文Todoの表示と、ビューごとの配色（列名ラベルと列背景の基準色）を設定します。変更は「保存して反映」を押すまでボードへ反映されません。",
    });
    this.statusEl = container.createEl("p", {
      cls: "bka-setting-status",
      attr: { role: "status", "aria-live": "polite" },
    });
    new Setting(container)
      .setName("設定の保存")
      .addButton((button) => {
        this.saveButton = button;
        button
          .setButtonText("保存して反映")
          .setCta()
          .onClick(() => this.save());
        button.buttonEl.dataset.bkaSave = "";
      })
      .addButton((button) =>
        button
          .setButtonText("保存済み設定に戻す")
          .setDisabled(this.busy)
          .onClick(async () => {
            if (this.busy) return;
            this.busy = true;
            this.render();
            try {
              if (await this.plugin.reloadSettings(false)) this.resetDraft();
            } finally {
              this.busy = false;
              await this.display();
            }
          }),
      );
    const form = container.createEl("fieldset", { cls: "bka-settings-form" });
    form.disabled = this.busy || !!this.plugin.settingsLoadError;
    new Setting(form)
      .setName("本文Todoを表示")
      .setDesc(
        "オフにするとカードのTodoパネルと下余白を外し、本文の読み込みも止めます。コマンド「本文Todoの表示を切り替え」は保存を待たずに即時反映します。",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.showTodos ?? true)
          .setDisabled(form.disabled)
          .onChange((value) => {
            this.draft.showTodos = value;
            this.dirty = true;
            this.message = "";
            this.messageError = false;
            this.updateState();
          });
        toggle.toggleEl.setAttribute("aria-label", "本文Todoを表示");
      });
    new Setting(form)
      .setName("完了済みTodoを隠す")
      .setDesc(
        "[ ] 以外（[x] [-] [<] [/] など）のTodoを完了とみなし、カードに表示しません。件数は（完了数 / 全体）で表示します。",
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.draft.hideCompletedTodos ?? true)
          .setDisabled(form.disabled)
          .onChange((value) => {
            this.draft.hideCompletedTodos = value;
            this.dirty = true;
            this.message = "";
            this.messageError = false;
            this.updateState();
          });
        toggle.toggleEl.setAttribute("aria-label", "完了済みTodoを隠す");
      });
    new Setting(form).setName("ビューごとの配色").setHeading();
    const views = this.views();
    if (!views.has(this.selectedKey))
      this.selectedKey = views.keys().next().value ?? null;
    if (!views.size) {
      form.createEl("p", {
        text: "グループ化した標準KanbanビューをBaseに作成し、この設定画面を開き直してください。",
      });
      this.updateState();
      return;
    }
    new Setting(form).setName("配色するビュー").addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute("aria-label", "配色するビュー");
      for (const [key, view] of views)
        dropdown.addOption(
          key,
          `${view.basePath} › ${view.viewName} (${view.groupBy})`,
        );
      dropdown.setValue(this.selectedKey).onChange((key) => {
        this.selectedKey = key;
        this.message = "";
        this.render();
      });
    });
    form.createEl("p", {
      cls: "setting-item-description",
      text: "未指定のステータスはグレーになります。「削除」は色設定だけを削除します。ボードにあるステータスは未指定の候補として残ります。候補にない値は下から追加できます。",
    });
    for (const status of this.knownStatuses()) this.renderColor(form, status);
    let newStatus = "";
    new Setting(form)
      .setName("ステータスを追加")
      .addText((text) => {
        text.setPlaceholder("例：Doing").onChange((value) => {
          newStatus = value;
        });
        text.inputEl.setAttribute("aria-label", "追加するステータス名");
      })
      .addButton((button) =>
        button.setButtonText("追加").onClick(() => {
          if (!newStatus.length) {
            new Notice("ステータス名を入力してください");
            return;
          }
          if (Object.hasOwn(this.rule()?.colors ?? {}, newStatus)) {
            new Notice("同じステータスが登録されています");
            return;
          }
          this.setColor(newStatus, { preset: "gray" });
          this.render();
        }),
      );
    new Setting(form)
      .setName("このビューの配色を解除")
      .setDesc("保存すると、このビューのすべてのステータスがグレーに戻ります。")
      .addButton((button) =>
        button
          .setButtonText("配色を解除")
          .setDisabled(!this.rule())
          .onClick(() => {
            this.draft.views = this.draft.views.filter(
              (view) => keyOf(view) !== this.selectedKey,
            );
            this.dirty = true;
            this.message = "";
            this.render();
          }),
      );
    this.updateState();
  }
  renderColor(container, status) {
    const colors = this.rule()?.colors ?? {};
    const color = Object.hasOwn(colors, status) ? colors[status] : undefined;
    const hex = color?.hex ?? PRESETS[color?.preset] ?? PRESETS.gray;
    const row = new Setting(container)
      .setName(status)
      .setClass("bka-color-row");
    row.settingEl.dataset.bkaStatus = status;
    let mode,
      picker,
      text,
      removeButton,
      syncing = false;
    const updateRemoveButton = () =>
      removeButton?.setDisabled(
        !Object.hasOwn(this.rule()?.colors ?? {}, status),
      );
    const sync = (operation) => {
      syncing = true;
      try {
        operation();
      } finally {
        syncing = false;
      }
    };
    const choose = (value) => {
      if (syncing) return;
      this.setColor(status, value);
      const newHex = value?.hex ?? PRESETS[value?.preset] ?? PRESETS.gray;
      // ColorComponent.setValue invokes onChange in this Obsidian version.
      // Synchronizing the picker must not replace a preset or an unspecified value.
      sync(() => {
        mode.setValue(value?.preset ?? (value?.hex ? "custom" : "default"));
        text.setValue(newHex);
        text.inputEl.setAttribute("aria-invalid", "false");
        picker.setValue(newHex);
      });
      updateRemoveButton();
    };
    row.addDropdown((dropdown) => {
      mode = dropdown;
      dropdown.selectEl.setAttribute("aria-label", `${status} の色指定`);
      dropdown.addOption("default", "未指定（グレー）");
      for (const preset of Object.keys(PRESETS))
        dropdown.addOption(preset, labels[preset]);
      dropdown
        .addOption("custom", "自由色")
        .setValue(color?.preset ?? (color?.hex ? "custom" : "default"))
        .onChange((value) => {
          if (syncing) return;
          if (value === "default") choose(null);
          else if (value === "custom")
            choose({
              hex: /^#[0-9a-fA-F]{6}$/.test(text.getValue())
                ? text.getValue()
                : PRESETS.gray,
            });
          else choose({ preset: value });
        });
    });
    row.addColorPicker((component) => {
      picker = component;
      component
        .setValue(/^#[0-9a-fA-F]{6}$/.test(hex) ? hex : PRESETS.gray)
        .onChange((value) => choose({ hex: value }));
      component.colorPickerEl.setAttribute("aria-label", `${status} の自由色`);
    });
    row.addText((component) => {
      text = component;
      component
        .setValue(hex)
        .setPlaceholder("#RRGGBB")
        .onChange((value) => {
          if (syncing) return;
          this.setColor(status, { hex: value });
          mode.setValue("custom");
          const valid = /^#[0-9a-fA-F]{6}$/.test(value);
          component.inputEl.setAttribute("aria-invalid", String(!valid));
          if (valid) sync(() => picker.setValue(value));
          updateRemoveButton();
        });
      component.inputEl.setAttribute("aria-label", `${status} の色コード`);
      component.inputEl.setAttribute(
        "aria-invalid",
        String(!/^#[0-9a-fA-F]{6}$/.test(hex)),
      );
      component.inputEl.classList.add("bka-color-hex");
    });
    row.addButton((button) => {
      removeButton = button;
      button
        .setButtonText("削除")
        .setDisabled(!Object.hasOwn(colors, status))
        .onClick(() => {
          this.setColor(status, null);
          this.render();
        });
      button.buttonEl.setAttribute("aria-label", `${status} の色設定を削除`);
      button.buttonEl.dataset.bkaDeleteColor = "";
    });
  }
}
module.exports = { KanbanSettingTab };
