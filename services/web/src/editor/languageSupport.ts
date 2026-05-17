import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { vue } from "@codemirror/lang-vue";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { go } from "@codemirror/lang-go";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { gas } from "@codemirror/legacy-modes/mode/gas";
import type { Extension } from "@codemirror/state";

function legacy(mode: Parameters<typeof StreamLanguage.define>[0]): Extension {
  return StreamLanguage.define(mode);
}

/**
 * Returns a CodeMirror language extension for the given file path, or empty for plain text.
 */
export function languageSupportForPath(path: string): Extension[] {
  const file = path.split("/").pop() ?? path;
  const lower = file.toLowerCase();
  const ext = lower.includes(".") ? (lower.split(".").pop() ?? "") : "";

  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) {
    return [legacy(dockerFile)];
  }
  if (lower === "makefile" || lower === "gnumakefile") {
    return [legacy(shell)];
  }

  switch (ext) {
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "jsx":
      return [javascript({ jsx: true })];
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "json":
    case "jsonc":
      return [json()];
    case "py":
    case "pyw":
    case "pyi":
      return [python()];
    case "css":
      return [css()];
    case "scss":
    case "sass":
      return [css()];
    case "html":
    case "htm":
      return [html()];
    case "vue":
      return [vue()];
    case "md":
    case "mdx":
      return [markdown()];
    case "yml":
    case "yaml":
      return [yaml()];
    case "xml":
    case "svg":
      return [xml()];
    case "sql":
      return [sql()];
    case "rs":
      return [rust()];
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hh":
    case "ino":
      return [cpp()];
    case "java":
      return [java()];
    case "go":
      return [go()];
    case "php":
      return [php()];
    case "rb":
    case "rake":
    case "gemspec":
      return [legacy(ruby)];
    case "sh":
    case "bash":
    case "zsh":
    case "ksh":
      return [legacy(shell)];
    case "swift":
      return [legacy(swift)];
    case "toml":
      return [legacy(toml)];
    case "env":
      return [legacy(properties)];
    case "gitignore":
      return [legacy(properties)];
    case "s":
    case "asm":
      return [legacy(gas)];
    default:
      return [];
  }
}
