// A multi-line text field and a scrolling choice list for hosts without such components (omp). No imports.

/** One decoded input: a key (id like "ctrl+a", text when it types something) or a bracketed paste. */
export type Input = { type: "key"; id: string; text?: string } | { type: "paste"; text: string };

export interface FieldOptions {
	/** Splits raw terminal input into keys and pastes. */
	decode(data: string): Input[];
	/** Width of a string in terminal cells. */
	cells(text: string): number;
	/** Styles a horizontal rule. */
	rule(text: string): string;
	/** Styles the character under the cursor. */
	cursor(text: string): string;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isWord = (g: string) => /^[\p{L}\p{N}_]/u.test(g);

interface Row {
	start: number;
	end: number;
}

export class TextField {
	focused = false;
	onSubmit: ((text: string) => void) | undefined;
	private text = "";
	private pos = 0;
	private want: number | undefined; // column kept across Up/Down
	private layoutWidth = 80;
	private opts: FieldOptions;

	constructor(opts: FieldOptions) {
		this.opts = opts;
	}

	setText(text: string) {
		this.text = text.replace(/\r\n?/g, "\n");
		this.pos = this.text.length;
		this.want = undefined;
	}

	getText() {
		return this.text;
	}

	getExpandedText() {
		return this.text;
	}

	invalidate() {}

	handleInput(data: string) {
		for (const input of this.opts.decode(data)) {
			if (input.type === "paste") this.insert(input.text.replace(/\r\n?/g, "\n"));
			else this.key(input.id, input.text);
		}
	}

	render(width: number): string[] {
		this.layoutWidth = Math.max(2, width);
		const rows = this.rows();
		const out = [this.opts.rule("─".repeat(width))];
		for (const row of rows) out.push(this.draw(row, width, rows));
		out.push(this.opts.rule("─".repeat(width)));
		return out;
	}

	private key(id: string, text: string | undefined) {
		if (text && !/[\x00-\x1f\x7f]/.test(text)) return this.insert(text);
		if (id === "space") return this.insert(" ");
		const keepWant = id === "up" || id === "down";
		const want = this.want;
		this.want = undefined;
		switch (id) {
			case "enter":
				return this.onSubmit?.(this.text);
			case "shift+enter":
			case "alt+enter":
			case "ctrl+enter":
			case "ctrl+j":
				return this.insert("\n");
			case "backspace":
				return this.remove(this.before(this.pos), this.pos);
			case "delete":
			case "ctrl+d":
				return this.remove(this.pos, this.after(this.pos));
			case "left":
			case "ctrl+b":
				return void (this.pos = this.before(this.pos));
			case "right":
			case "ctrl+f":
				return void (this.pos = this.after(this.pos));
			case "alt+left":
			case "ctrl+left":
			case "alt+b":
				return void (this.pos = this.wordBefore(this.pos));
			case "alt+right":
			case "ctrl+right":
			case "alt+f":
				return void (this.pos = this.wordAfter(this.pos));
			case "ctrl+w":
			case "alt+backspace":
				return this.remove(this.wordBefore(this.pos), this.pos);
			case "home":
			case "ctrl+a":
				return void (this.pos = this.lineStart(this.pos));
			case "end":
			case "ctrl+e":
				return void (this.pos = this.lineEnd(this.pos));
			case "ctrl+u": {
				const s = this.lineStart(this.pos);
				return this.remove(s === this.pos ? this.before(s) : s, this.pos);
			}
			case "ctrl+k": {
				const e = this.lineEnd(this.pos);
				return this.remove(this.pos, e === this.pos ? this.after(e) : e);
			}
		}
		if (keepWant) this.moveRow(id === "up" ? -1 : 1, want);
	}

	private insert(s: string) {
		this.text = this.text.slice(0, this.pos) + s + this.text.slice(this.pos);
		this.pos += s.length;
		this.want = undefined;
	}

	private remove(from: number, to: number) {
		if (from >= to) return;
		this.text = this.text.slice(0, from) + this.text.slice(to);
		this.pos = from;
	}

	private before(o: number) {
		let prev = 0;
		for (const g of segmenter.segment(this.text)) {
			if (g.index >= o) break;
			prev = g.index;
		}
		return o <= 0 ? 0 : prev;
	}

	private after(o: number) {
		for (const g of segmenter.segment(this.text)) if (g.index >= o) return Math.min(this.text.length, g.index + g.segment.length);
		return this.text.length;
	}

	private lineStart(o: number) {
		return this.text.lastIndexOf("\n", o - 1) + 1;
	}

	private lineEnd(o: number) {
		const i = this.text.indexOf("\n", o);
		return i < 0 ? this.text.length : i;
	}

	private wordBefore(o: number) {
		let i = o;
		while (i > 0 && !isWord(this.text.slice(this.before(i), i))) i = this.before(i);
		while (i > 0 && isWord(this.text.slice(this.before(i), i))) i = this.before(i);
		return i;
	}

	private wordAfter(o: number) {
		let i = o;
		while (i < this.text.length && !isWord(this.text.slice(i, this.after(i)))) i = this.after(i);
		while (i < this.text.length && isWord(this.text.slice(i, this.after(i)))) i = this.after(i);
		return i;
	}

	private moveRow(dir: -1 | 1, want: number | undefined) {
		const rows = this.rows();
		const at = this.rowAt(rows, this.pos);
		const col = want ?? this.pos - rows[at].start;
		const to = rows[at + dir];
		if (!to) return void (this.pos = dir < 0 ? rows[at].start : rows[at].end);
		this.pos = Math.min(to.start + col, to.end);
		this.want = col;
	}

	private rowAt(rows: Row[], o: number) {
		for (let i = 0; i < rows.length; i++) {
			const last = i === rows.length - 1 || this.text[rows[i].end] === "\n";
			if (o >= rows[i].start && (o < rows[i].end || (last && o <= rows[i].end))) return i;
		}
		return rows.length - 1;
	}

	/** Word-wrapped rows of the text at the last render width; one cell stays free for the cursor. */
	private rows(): Row[] {
		const room = Math.max(1, this.layoutWidth - 1);
		const rows: Row[] = [];
		let ls = 0;
		for (const line of this.text.split("\n")) {
			const le = ls + line.length;
			let start = ls;
			do {
				let end = start;
				let used = 0;
				let space = -1;
				for (const g of segmenter.segment(line.slice(start - ls))) {
					const w = this.opts.cells(g.segment);
					if (used + w > room && end > start) {
						if (g.segment === " ") end += 1; // a trailing space may hang past the edge
						else if (space > start) end = space;
						break;
					}
					used += w;
					end += g.segment.length;
					if (g.segment === " ") space = end;
				}
				rows.push({ start, end });
				start = end;
			} while (start < le);
			ls = le + 1;
		}
		return rows;
	}

	private draw(row: Row, width: number, rows: Row[]): string {
		const text = this.text.slice(row.start, row.end);
		const here = this.focused && rows[this.rowAt(rows, this.pos)] === row;
		let line = text;
		if (here) {
			const col = this.pos - row.start;
			const rest = text.slice(col);
			const g = rest ? [...segmenter.segment(rest)][0].segment : " ";
			line = text.slice(0, col) + this.opts.cursor(g) + rest.slice(rest ? g.length : 0);
		}
		return line + " ".repeat(Math.max(0, width - this.opts.cells(text) - (here && this.pos === row.end ? 1 : 0)));
	}
}

export interface Choice {
	value: string;
	label: string;
	description?: string;
}

export interface ListOptions {
	/** Matches raw input against a key id: "up", "down", "pageUp", "pageDown". */
	matches(data: string, key: "up" | "down" | "pageUp" | "pageDown"): boolean;
	truncate(text: string, width: number): string;
	prefix(text: string): string;
	selected(text: string): string;
	scrollInfo(text: string): string;
}

export class ChoiceList {
	private index = 0;
	private items: Choice[];
	private maxVisible: number;
	private opts: ListOptions;

	constructor(items: Choice[], maxVisible: number, opts: ListOptions) {
		this.items = items;
		this.maxVisible = maxVisible;
		this.opts = opts;
	}

	setSelectedIndex(i: number) {
		this.index = Math.max(0, Math.min(i, this.items.length - 1));
	}

	getSelectedItem(): Choice | null {
		return this.items[this.index] ?? null;
	}

	handleInput(data: string) {
		const n = this.items.length;
		if (!n) return;
		if (this.opts.matches(data, "up")) this.index = this.index === 0 ? n - 1 : this.index - 1;
		else if (this.opts.matches(data, "down")) this.index = this.index === n - 1 ? 0 : this.index + 1;
		else if (this.opts.matches(data, "pageUp")) this.index = Math.max(0, this.index - this.maxVisible);
		else if (this.opts.matches(data, "pageDown")) this.index = Math.min(n - 1, this.index + this.maxVisible);
	}

	render(width: number): string[] {
		const n = this.items.length;
		const from = Math.max(0, Math.min(this.index - Math.floor(this.maxVisible / 2), n - this.maxVisible));
		const lines = this.items.slice(from, from + this.maxVisible).map((item, i) => {
			const on = from + i === this.index;
			const text = this.opts.truncate(item.description ? `${item.label}  ${item.description}` : item.label, width - 2);
			return on ? `${this.opts.prefix("→ ")}${this.opts.selected(text)}` : `  ${text}`;
		});
		if (n > this.maxVisible) lines.push(this.opts.scrollInfo(`  (${this.index + 1}/${n})`));
		return lines;
	}
}
