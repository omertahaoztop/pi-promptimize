import { test } from "node:test";
import assert from "node:assert/strict";
import { ChoiceList, type Input, TextField } from "../extensions/promptimize/widgets.ts";

// "@id" is a key, "paste:text" a paste, anything else typed characters.
const decode = (data: string): Input[] => {
	if (data.startsWith("@")) return [{ type: "key", id: data.slice(1) }];
	if (data.startsWith("paste:")) return [{ type: "paste", text: data.slice(6) }];
	return [...data].map((c) => ({ type: "key", id: c === " " ? "space" : c, text: c }));
};
const cells = (s: string) => [...s].length;
const field = () => new TextField({ decode, cells, rule: (s) => s, cursor: (s) => `<${s}>` });

test("TextField types, edits and moves the cursor", () => {
	const f = field();
	f.handleInput("helo");
	f.handleInput("@left");
	f.handleInput("l");
	assert.equal(f.getText(), "hello");
	f.handleInput("@backspace");
	f.handleInput("@delete");
	assert.equal(f.getText(), "hel");
	f.handleInput("@home");
	f.handleInput("X");
	f.handleInput("@end");
	f.handleInput(" you");
	assert.equal(f.getText(), "Xhel you");
});

test("TextField: Enter submits, Shift+Enter adds a line, paste keeps newlines", () => {
	const f = field();
	let sent: string | undefined;
	f.onSubmit = (t) => (sent = t);
	f.handleInput("a");
	f.handleInput("@shift+enter");
	f.handleInput("b");
	f.handleInput("paste:c\r\nd");
	f.handleInput("@enter");
	assert.equal(sent, "a\nbc\nd");
	assert.equal(f.getExpandedText(), "a\nbc\nd");
});

test("TextField deletes words and lines", () => {
	const f = field();
	f.setText("one two three");
	f.handleInput("@ctrl+w");
	assert.equal(f.getText(), "one two ");
	f.handleInput("@alt+left");
	f.handleInput("@ctrl+k");
	assert.equal(f.getText(), "one ");
	f.handleInput("@ctrl+u");
	assert.equal(f.getText(), "");
});

test("TextField moves between wrapped rows and keeps the column", () => {
	const f = field();
	f.focused = true;
	f.setText("ab\nabcdef\nab");
	f.render(20);
	f.handleInput("@up");
	f.handleInput("@up");
	f.handleInput("@end");
	f.handleInput("@down");
	f.handleInput("@down");
	f.handleInput("X");
	assert.equal(f.getText(), "ab\nabcdef\nabX");
});

test("TextField renders rules, word wrap and the cursor", () => {
	const f = field();
	f.focused = true;
	f.setText("alpha beta gamma");
	const rows = f.render(11);
	assert.equal(rows[0], "─".repeat(11));
	assert.equal(rows.at(-1), "─".repeat(11));
	assert.deepEqual(rows.slice(1, -1).map((r) => r.replace(/[<>]/g, "").trimEnd()), ["alpha beta", "gamma"]);
	assert.ok(rows.slice(1, -1).some((r) => r.includes("< >")));
	assert.ok(rows.every((r) => [...r.replace(/[<>]/g, "")].length === 11));
});

test("TextField handles wide graphemes without splitting them", () => {
	const f = field();
	f.setText("a👍🏽b");
	f.handleInput("@backspace");
	f.handleInput("@left");
	f.handleInput("@backspace");
	assert.equal(f.getText(), "👍🏽");
});

const listOpts = { matches: (d: string, k: string) => d === k, truncate: (s: string, w: number) => s.slice(0, w), prefix: (s: string) => s, selected: (s: string) => `[${s}]`, scrollInfo: (s: string) => s };
const items = ["a", "b", "c", "d"].map((x) => ({ value: x, label: x }));

test("ChoiceList selects, wraps around and scrolls", () => {
	const l = new ChoiceList(items, 2, listOpts);
	assert.equal(l.getSelectedItem()?.value, "a");
	l.handleInput("up");
	assert.equal(l.getSelectedItem()?.value, "d");
	l.handleInput("down");
	assert.equal(l.getSelectedItem()?.value, "a");
	l.setSelectedIndex(3);
	assert.deepEqual(l.render(20), ["  c", "→ [d]", "  (4/4)"]);
	l.handleInput("pageUp");
	assert.equal(l.getSelectedItem()?.value, "b");
});

test("ChoiceList with no items has no selection", () => {
	const l = new ChoiceList([], 3, listOpts);
	l.handleInput("down");
	assert.equal(l.getSelectedItem(), null);
	assert.deepEqual(l.render(10), []);
});
