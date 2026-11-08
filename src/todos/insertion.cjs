"use strict";

function lineStart(source, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length)
    throw new Error("追加先の見出しを確認できません");
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  if (source.slice(start, offset).trim())
    throw new Error("追加先の見出しを確認できません");
  return start;
}

function assertTailClosed(source, sections) {
  // Appending must not extend an unterminated literal block into the new Todo.
  const firstLine = source.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  if (
    firstLine === "---" &&
    !source
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .slice(1)
      .some((line) => /^(?:---|\.\.\.)[ \t]*$/.test(line))
  ) {
    throw new Error("ノート先頭のプロパティ区切りを閉じてから追加してください");
  }
  const tail = [...sections]
    .reverse()
    .find((section) => section.position?.start && section.position?.end);
  if (!tail || source.slice(tail.position.end.offset).trim()) return;
  const raw = source.slice(
    tail.position.start.offset,
    tail.position.end.offset,
  );
  if (tail.type === "comment" && (raw.match(/%%/g)?.length ?? 0) % 2) {
    throw new Error("ノート末尾のコメントを閉じてから追加してください");
  }
  if (tail.type === "code") {
    const lines = raw.trimEnd().split(/\r?\n/),
      opener = lines[0].match(/^ {0,3}(`{3,}|~{3,})/);
    if (
      opener &&
      (lines.length < 2 ||
        !new RegExp(
          `^ {0,3}${opener[1][0]}{${opener[1].length},}[ \\t]*$`,
        ).test(lines.at(-1)))
    ) {
      throw new Error("ノート末尾のコードブロックを閉じてから追加してください");
    }
  }
  if (tail.type === "html") {
    const start = raw.trimStart(),
      tag = start.match(/^<(script|pre|style|textarea)(?:\s|>)/i);
    if (
      (start.startsWith("<!--") &&
        raw.lastIndexOf("<!--") > raw.lastIndexOf("-->")) ||
      (start.startsWith("<?") && !raw.includes("?>")) ||
      (start.startsWith("<![CDATA[") && !raw.includes("]]>")) ||
      (tag && !new RegExp(`</${tag[1]}\\s*>`, "i").test(raw))
    ) {
      throw new Error("ノート末尾のHTMLやコメントを閉じてから追加してください");
    }
  }
}

function insertTodo(source, headings, sections, value) {
  if (typeof value !== "string" || /[\r\n\x00]/.test(value) || !value.trim())
    throw new Error("Todoを1行で入力してください");
  const text = value.trim(),
    eol = source.match(/\r\n|\n/)?.[0] ?? "\n";
  const matches = headings.filter(
    (heading) => heading.level === 2 && heading.heading === "Todo",
  );
  if (matches.length > 1)
    throw new Error(
      "「## Todo」が複数あるため追加できません。追加先を1つにしてください",
    );
  let at = source.length;
  if (matches.length) {
    const heading = matches[0],
      start = lineStart(source, heading.position?.start?.offset);
    if (
      !/^ {0,3}##[ \t]+Todo(?:[ \t]+#+)?[ \t]*$/.test(
        source
          .slice(start)
          .split(/\r?\n/, 1)[0]
          .replace(/^\uFEFF/, ""),
      )
    ) {
      throw new Error("追加先は「## Todo」形式の見出しにしてください");
    }
    const next = headings.find(
      (item) =>
        item.position?.start?.offset > heading.position.start.offset &&
        item.level <= 2,
    );
    if (next) at = lineStart(source, next.position.start.offset);
  }
  if (at === source.length) assertTailClosed(source, sections);
  let before = source.slice(0, at);
  if (before && !before.endsWith(eol + eol))
    before += before.endsWith("\n") ? eol : eol + eol;
  if (!matches.length) before += "## Todo" + eol + eol;
  return (
    before +
    "- [ ] " +
    text +
    eol +
    (at < source.length ? eol : "") +
    source.slice(at)
  );
}

module.exports = { insertTodo };
