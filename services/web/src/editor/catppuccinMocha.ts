/**
 * Catppuccin Mocha palette — https://github.com/catppuccin/catppuccin
 * CodeMirror 6 theme + syntax highlight mapping.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const base = "#1e1e2e";
const mantle = "#181825";
const surface0 = "#313244";
const overlay0 = "#6c7086";
const subtext0 = "#a6adc8";
const text = "#cdd6f4";
const rosewater = "#f5e0dc";
const flamingo = "#f2cdcd";
const mauve = "#cba6f7";
const red = "#f38ba8";
const peach = "#fab387";
const yellow = "#f9e2af";
const green = "#a6e3a1";
const teal = "#94e2d5";
const sky = "#89dceb";
const blue = "#89b4fa";
const lavender = "#b4befe";

const catppuccinHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword], color: mauve },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: flamingo },
  { tag: [t.function(t.variableName), t.labelName], color: blue },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: peach },
  { tag: [t.definition(t.name), t.separator], color: text },
  { tag: [t.typeName, t.className, t.changed], color: yellow },
  { tag: [t.annotation, t.self, t.namespace], color: yellow },
  { tag: [t.number, t.bool, t.null, t.special(t.variableName)], color: peach },
  { tag: [t.processingInstruction, t.string, t.inserted, t.special(t.string)], color: green },
  { tag: [t.literal, t.docString], color: green },
  { tag: [t.unit, t.punctuation, t.bracket], color: subtext0 },
  { tag: [t.variableName, t.propertyName], color: rosewater },
  { tag: t.definition(t.propertyName), color: lavender },
  { tag: [t.attributeName, t.attributeValue], color: teal },
  { tag: t.operator, color: sky },
  { tag: t.comment, color: overlay0 },
  { tag: t.meta, color: overlay0 },
  { tag: t.invalid, color: red },
  { tag: [t.tagName], color: mauve },
  { tag: t.angleBracket, color: subtext0 },
  { tag: t.docComment, color: overlay0, fontStyle: "italic" },
  { tag: t.monospace, color: flamingo },
]);

export const catppuccinMochaTheme: Extension[] = [
  EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: base,
        color: text,
        fontSize: "13px",
        fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
      },
      ".cm-scroller": {
        fontFamily: "inherit",
        lineHeight: "1.55",
      },
      ".cm-content": { caretColor: rosewater, paddingBlock: "8px" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: rosewater },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: `${surface0} !important`,
      },
      ".cm-activeLine": { backgroundColor: `${mantle}66` },
      ".cm-gutters": {
        backgroundColor: mantle,
        color: overlay0,
        border: "none",
        borderRight: `1px solid ${surface0}`,
      },
      ".cm-lineNumbers .cm-gutterElement": { minWidth: "2.75ch", padding: "0 0.5rem 0 0.75rem" },
      ".cm-activeLineGutter": { backgroundColor: surface0, color: subtext0 },
      ".cm-foldGutter .cm-gutterElement": { padding: "0 0.25rem" },
      ".cm-tooltip": {
        backgroundColor: surface0,
        color: text,
        border: `1px solid ${overlay0}`,
        borderRadius: "6px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        background: mauve,
        color: base,
      },
      ".cm-searchMatch": { backgroundColor: `${yellow}33` },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: `${peach}55` },
      ".cm-panels": { backgroundColor: mantle, color: text },
      ".cm-panels-bottom": { borderTop: `1px solid ${surface0}` },
      ".cm-panel.cm-search input": { backgroundColor: base, color: text, border: `1px solid ${surface0}` },
    },
    { dark: true },
  ),
  syntaxHighlighting(catppuccinHighlight),
];
