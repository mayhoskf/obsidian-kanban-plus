"use strict";

class Appearance {
  constructor(css) {
    this.css = css;
    this.roots = new Set();
    this.columns = new Set();
    this.styles = new Map();
  }
  update(boards, documents, settings) {
    for (const [doc, style] of this.styles) {
      if (!documents.has(doc) || doc.defaultView?.closed) {
        style.remove();
        this.styles.delete(doc);
      }
    }
    for (const doc of documents) {
      if (!this.styles.has(doc) && doc.head && !doc.defaultView?.closed) {
        const style = doc.createElement("style");
        style.dataset.bkaStyle = "";
        style.textContent = this.css;
        doc.head.appendChild(style);
        this.styles.set(doc, style);
      }
    }
    const roots = new Set(),
      columns = new Set();
    let geometryChanged = false;
    for (const board of boards) {
      roots.add(board.root);
      if (!board.root.classList.contains("bka-board")) {
        board.root.classList.add("bka-board");
        geometryChanged = true;
      }
      for (const col of board.columns) {
        columns.add(col.element);
        const color = settings.colorFor(
          board.source,
          board.viewName,
          board.groupBy,
          col.status,
        );
        if (col.element.style.getPropertyValue("--bka-accent") !== color)
          col.element.style.setProperty("--bka-accent", color);
      }
    }
    for (const col of this.columns)
      if (!columns.has(col)) col.style.removeProperty("--bka-accent");
    for (const root of this.roots)
      if (!roots.has(root)) {
        root.classList.remove("bka-board");
        geometryChanged = true;
      }
    this.roots = roots;
    this.columns = columns;
    return geometryChanged;
  }
  dispose() {
    for (const root of this.roots) root.classList.remove("bka-board");
    for (const col of this.columns) col.style.removeProperty("--bka-accent");
    for (const style of this.styles.values()) style.remove();
    this.roots.clear();
    this.columns.clear();
    this.styles.clear();
  }
}
module.exports = { Appearance };
