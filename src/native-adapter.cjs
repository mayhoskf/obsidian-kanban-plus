'use strict';

const ROOT = '.bases-view[data-view-type="kanban"]';
const element = value => value?.nodeType === 1 && typeof value.matches === 'function';

// These are the only internal object edges inspected. Never traverse the whole app.
function discover(workspace, mainDocument) {
  const queue = [], seen = new Set(), controllers = new Map();
  const documents = new Set([mainDocument]);
  workspace.iterateAllLeaves(leaf => {
    if (leaf.view) queue.push(leaf.view);
    const doc = leaf.view?.containerEl?.ownerDocument;
    if (doc) documents.add(doc);
  });
  for (let index = 0; index < queue.length && index < 12000; index++) {
    const item = queue[index];
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const root = item.viewContainerEl;
    if (element(root) && root.isConnected && root.matches(ROOT) && element(item.view?.containerEl) && root.contains(item.view.containerEl)) {
      controllers.set(root, item);
      documents.add(root.ownerDocument);
    }
    for (const name of ['controller', 'previewMode', 'editMode']) {
      if (item[name] && typeof item[name] === 'object') queue.push(item[name]);
    }
    if (Array.isArray(item._children)) queue.push(...item._children);
  }
  return { controllers, documents };
}

function todoSnapshot(root, view) {
  const tester = view.testers?.card;
  if (!element(tester) || !root.contains(tester) || !Number.isFinite(view.measurements?.cardHeight) || view.measurements.cardHeight <= 0) return null;
  const paddingBottom = root.ownerDocument.defaultView.getComputedStyle(tester).paddingBottom;
  if (!/^\d+(?:\.\d+)?px$/.test(paddingBottom)) return null;
  const cards = [];
  for (const column of view.columns) {
    if (!Array.isArray(column.items)) return null;
    for (const card of column.items) {
      if (!element(card.el) || !card.el.matches('.bases-kanban-card')) return null;
      if (!card.el.isConnected || !root.contains(card.el)) continue;
      const file = card.entry?.file;
      if (!file || typeof file.path !== 'string' || typeof file.extension !== 'string' || !file.stat) return null;
      if (file.extension === 'md') cards.push({ element: card.el, file });
    }
  }
  return { cards, paddingBottom };
}

function snapshot(root, controller) {
  const result = { root, source: null, viewName: null, groupBy: null, columns: [], todos: null, compatible: false };
  // Guard all private structure before using any of it. Unknown roots keep neutral styling.
  if (!controller || !root.isConnected || root.getClientRects().length === 0 ||
      !Array.isArray(controller.view?.columns) || controller.viewContainerEl !== root ||
      !element(controller.view.containerEl) || !root.contains(controller.view.containerEl) || typeof controller.viewName !== 'string' ||
      controller.viewName !== root.getAttribute('data-view-name')) return result;
  const groupBy = controller.view.config?.groupBy?.property;
  if (typeof groupBy !== 'string' || !/^(note|file|formula)\..+$/.test(groupBy)) return result;
  const columns = [];
  for (const col of controller.view.columns) {
    if (!element(col.containerEl) || !col.containerEl.matches('.bases-kanban-column') ||
        !element(col.headerEl) || !col.containerEl.contains(col.headerEl)) return result;
    if (!col.containerEl.isConnected || !root.contains(col.containerEl)) continue;
    const key = col.group?.key;
    const kind = key?.type?.type ?? key?.constructor?.type;
    // Never use rendered header text: null and the literal string "None" can collide.
    const status = kind === 'String' && typeof key.data === 'string' ? key.data : null;
    columns.push({ element: col.containerEl, status });
  }
  const path = controller.query?.file?.path;
  return {
    root, source: typeof path === 'string' && path.endsWith('.base') ? path : null,
    viewName: controller.viewName, groupBy, columns, todos: todoSnapshot(root, controller.view), compatible: true,
  };
}

class NativeKanbanAdapter {
  constructor(app, mainDocument, paint, warn) {
    this.app = app; this.mainDocument = mainDocument; this.paint = paint; this.warn = warn;
    this.documents = new Map(); this.disposed = false; this.timer = null; this.warned = false;
  }
  schedule() {
    if (this.disposed || this.timer !== null) return;
    // One frame-sized batch across documents, including popouts whose main window is hidden.
    this.timer = this.mainDocument.defaultView.setTimeout(() => { this.timer = null; this.refresh(); }, 16);
  }
  observe(doc) {
    if (this.documents.has(doc) || !doc.body || !doc.defaultView) return;
    const win = doc.defaultView;
    const relevant = node => element(node) && (node.matches(ROOT) || node.closest(ROOT) || node.querySelector(ROOT));
    const observer = new win.MutationObserver(records => {
      if (records.some(record => !record.target.closest?.('.bka-todo-panel') && (record.type === 'attributes' || relevant(record.target) ||
          [...record.addedNodes, ...record.removedNodes].some(relevant)))) this.schedule();
    });
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-view-name', 'data-view-type'] });
    const theme = new win.MutationObserver(() => this.schedule());
    theme.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    const schedule = () => this.schedule();
    win.addEventListener('resize', schedule);
    win.addEventListener('focus', schedule);
    this.documents.set(doc, () => {
      observer.disconnect(); theme.disconnect();
      win.removeEventListener('resize', schedule); win.removeEventListener('focus', schedule);
    });
  }
  refresh() {
    if (this.disposed) return;
    try {
      const { controllers, documents } = discover(this.app.workspace, this.mainDocument);
      for (const [doc, dispose] of this.documents) {
        if (!documents.has(doc) || doc.defaultView?.closed) { dispose(); this.documents.delete(doc); }
      }
      const boards = [];
      for (const doc of documents) {
        if (doc.defaultView?.closed) continue;
        this.observe(doc);
        if (!doc.body?.classList.contains('theme-dark')) continue;
        for (const root of doc.querySelectorAll(ROOT)) boards.push(snapshot(root, controllers.get(root)));
      }
      if (boards.some(board => !board.compatible && board.root.getClientRects().length) && !this.warned) {
        this.warned = true;
        this.warn('標準Kanbanの内部構造を取得できないビューはグレーで表示します。');
      }
      this.paint(boards, documents);
    } catch (error) {
      // Remove old colors if an unexpected private-API change prevents discovery.
      this.paint([], new Set([this.mainDocument]));
      if (!this.warned) { this.warned = true; this.warn(error.message); }
    }
  }
  dispose() {
    this.disposed = true;
    if (this.timer !== null) this.mainDocument.defaultView.clearTimeout(this.timer);
    this.timer = null;
    for (const dispose of this.documents.values()) dispose();
    this.documents.clear();
  }
}

module.exports = { discover, snapshot, NativeKanbanAdapter };
