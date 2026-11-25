/**
 * Promptimize for pi: /promptimize or alt+p opens the popup (popup.ts).
 *
 * Settings (settings.json): "promptimize": { "model": "provider/id", "includeContext": false }
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, fuzzyFilter, matchesKey, SelectList, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type PopupTheme, register, type Settings, type Tui } from "./popup.ts";

// alt+p only works when the terminal sends Option as Alt (Ghostty: macos-option-as-alt); ctrl+r is pi's session rename.
const SHORTCUT = "alt+p";

const tui: Tui = {
	screen: (ui) => {
		const t = ui as TUI;
		return {
			requestRender: () => t.requestRender(),
			rows: () => t.terminal?.rows ?? 40,
			newField: (theme, active) => {
				const th = theme as Theme;
				const selectList = {
					selectedPrefix: (s: string) => th.fg("accent", s),
					selectedText: (s: string) => th.fg("accent", s),
					description: (s: string) => th.fg("muted", s),
					scrollInfo: (s: string) => th.fg("dim", s),
					noMatch: (s: string) => th.fg("warning", s),
				};
				const editorTheme: EditorTheme = { borderColor: (s) => th.fg(active() ? "accent" : "dim", s), selectList };
				return new Editor(t, editorTheme);
			},
			newPicker: (theme, items, maxVisible) => {
				const th = theme as Theme;
				return new SelectList(items, maxVisible, {
					selectedPrefix: (s) => th.fg("accent", s),
					selectedText: (s) => th.fg("accent", s),
					description: (s) => th.fg("muted", s),
					scrollInfo: (s) => th.fg("dim", s),
					noMatch: (s) => th.fg("warning", s),
				});
			},
		};
	},
	matches: (data, key) => matchesKey(data, key),
	fuzzyFilter,
	truncate: (text, width) => truncateToWidth(text, width, "…", true),
	visibleWidth,
	wrap: wrapTextWithAnsi,
	panelBg: (theme: PopupTheme) => (theme as Theme).getBgAnsi("customMessageBg"),
	focusOnMount: false,
	customOptions: { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 50 } },
};

export default function (pi: ExtensionAPI) {
	register(pi, SHORTCUT, (ctx) => ({
		settings: (pi.getSettings() as { promptimize?: Settings }).promptimize ?? {},
		findModel: (id) => {
			const slash = id.indexOf("/");
			return slash > 0 ? ctx.modelRegistry.find(id.slice(0, slash), id.slice(slash + 1)) : undefined;
		},
		// Same list /model shows: the scoped models when set, else every model with auth.
		models: () => (ctx.scopedModels.length ? ctx.scopedModels.map((s) => s.model) : [...ctx.modelRegistry.getAvailable()]),
		streamSimple: (m, c, o) => ctx.modelRegistry.streamSimple(m as never, c as never, o as never),
		thinkingLevel: ctx.thinkingLevel,
		tui,
	}));
}
