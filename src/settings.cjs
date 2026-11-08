'use strict';

const PRESETS = Object.freeze({
  gray: '#A2A6AE', red: '#E8AAAA', orange: '#E5BC91', yellow: '#DEC887',
  green: '#A7D8BA', blue: '#A7C7E7', purple: '#C6AFE3', pink: '#E3ACC7',
});
const emptySettings = () => ({ schemaVersion: 1, views: [] });
const keyFor = (path, name, property) => JSON.stringify([path, name, property]);

function fail(at, reason) { throw new Error(`${at}: ${reason}`); }
function object(value, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(at, 'オブジェクトが必要です');
}
function fields(value, expected, at, optional = []) {
  object(value, at);
  for (const name of expected) if (!Object.hasOwn(value, name)) fail(`${at}.${name}`, '必須項目です');
  for (const name of Object.keys(value)) if (!expected.includes(name) && !optional.includes(name)) fail(`${at}.${name}`, '未知の項目です');
}
function nonempty(value, at) {
  if (typeof value !== 'string' || value.length === 0) fail(at, '空でない文字列が必要です');
}

function compileSettings(input) {
  fields(input, ['schemaVersion', 'views'], '$', ['hideCompletedTodos', 'showTodos']);
  if (input.schemaVersion !== 1) fail('$.schemaVersion', '対応する値は1です');
  if (!Array.isArray(input.views)) fail('$.views', '配列が必要です');
  if (Object.hasOwn(input, 'hideCompletedTodos') && typeof input.hideCompletedTodos !== 'boolean') {
    fail('$.hideCompletedTodos', 'true または false が必要です');
  }
  if (Object.hasOwn(input, 'showTodos') && typeof input.showTodos !== 'boolean') {
    fail('$.showTodos', 'true または false が必要です');
  }
  const rules = new Map();
  input.views.forEach((view, i) => {
    const at = `$.views[${i}]`;
    fields(view, ['basePath', 'viewName', 'groupBy', 'colors'], at);
    nonempty(view.basePath, `${at}.basePath`);
    if (!view.basePath.endsWith('.base') || view.basePath.length < 6 || /[\\:\x00-\x1F]/.test(view.basePath) ||
        view.basePath.split('/').some(part => !part || part === '.' || part === '..')) {
      fail(`${at}.basePath`, 'Vault相対パスを / 区切りで指定してください（.baseファイル）');
    }
    nonempty(view.viewName, `${at}.viewName`);
    if (typeof view.groupBy !== 'string' || !/^(note|file|formula)\..+$/.test(view.groupBy)) {
      fail(`${at}.groupBy`, 'note.status などの完全なプロパティ名が必要です');
    }
    object(view.colors, `${at}.colors`);
    const colors = new Map();
    for (const [status, color] of Object.entries(view.colors)) {
      const colorAt = `${at}.colors[${JSON.stringify(status)}]`;
      nonempty(status, colorAt);
      object(color, colorAt);
      let hex;
      if (Object.hasOwn(color, 'preset')) {
        fields(color, ['preset'], colorAt);
        if (typeof color.preset !== 'string' || !Object.hasOwn(PRESETS, color.preset)) fail(colorAt, '未知のプリセットです');
        hex = PRESETS[color.preset];
      } else {
        fields(color, ['hex'], colorAt);
        if (typeof color.hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color.hex)) fail(colorAt, '#RRGGBB形式で指定してください');
        hex = color.hex;
      }
      colors.set(status, hex);
    }
    const key = keyFor(view.basePath, view.viewName, view.groupBy);
    if (rules.has(key)) fail(at, 'basePath / viewName / groupBy の組が重複しています');
    rules.set(key, colors);
  });
  return {
    colorFor(source, name, property, status) {
      if (typeof status !== 'string' || !source) return PRESETS.gray;
      return rules.get(keyFor(source, name, property))?.get(status) ?? PRESETS.gray;
    },
    viewCount: rules.size,
    // Absent in files written before this option existed; completed Todos are hidden by default.
    hideCompletedTodos: input.hideCompletedTodos ?? true,
    // Absent in files written before this option existed; Todo panels are shown by default.
    showTodos: input.showTodos ?? true,
  };
}

// All reads must finish validation before a single active snapshot is replaced.
// The generation also invalidates outstanding reads on unload.
class SettingsStore {
  constructor() { this.data = emptySettings(); this.current = compileSettings(this.data); this.generation = 0; }
  async reload(read) {
    const generation = ++this.generation;
    try {
      const data = await read();
      const next = compileSettings(data);
      if (generation !== this.generation) return { stale: true };
      this.current = next;
      this.data = JSON.parse(JSON.stringify(data));
      return { stale: false, viewCount: next.viewCount };
    } catch (error) {
      if (generation !== this.generation) return { stale: true };
      throw error;
    }
  }
  async save(input, persist) {
    const data = JSON.parse(JSON.stringify(input));
    const next = compileSettings(data);
    const generation = ++this.generation;
    await persist(data);
    if (generation !== this.generation) return { stale: true };
    this.current = next;
    this.data = data;
    return { stale: false, viewCount: next.viewCount };
  }
  dispose() { ++this.generation; }
}

module.exports = { PRESETS, emptySettings, compileSettings, SettingsStore };
