import { parseKeymap, serializeKeymap, type ParsedKeymap } from "./keymapBinary";
import type { DefaultKeymap, KeymapDocument, SaveResult } from "./types";

const fileFilters = [
  {
    name: "Bitwig keymap",
    extensions: ["bwkeymap"]
  }
];

let browserTemplate: ParsedKeymap["template"] | null = null;
let activeDefaultKeymapId: string | null = null;

const defaultKeymapUrls = import.meta.glob("../src-tauri/resources/*.bwkeymap", {
  eager: true,
  import: "default",
  query: "?url"
}) as Record<string, string>;

export const DEFAULT_KEYMAPS: DefaultKeymap[] = Object.keys(defaultKeymapUrls)
  .map((path) => {
    const fileName = path.split("/").pop() ?? path;
    const id = fileName.replace(/\.bwkeymap$/i, "");
    return {
      id,
      label: `Bitwig ${id}`,
      fileName
    };
  })
  .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function listDefaultKeymaps(): Promise<DefaultKeymap[]> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<DefaultKeymap[]>("list_default_keymaps");
  }

  return DEFAULT_KEYMAPS;
}

export async function loadKeymap(path?: string, defaultKeymapId?: string): Promise<KeymapDocument> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const document = await invoke<KeymapDocument>("load_keymap", path ? { path } : { defaultKeymap: defaultKeymapId });
    activeDefaultKeymapId = path ? null : defaultKeymapId ?? DEFAULT_KEYMAPS[0]?.id ?? null;
    return document;
  }

  if (path) {
    throw new Error("browser keymap loading uses File objects, not filesystem paths");
  }

  const defaultKeymap = selectDefaultKeymap(defaultKeymapId);
  const response = await fetch(defaultKeymapUrls[`../src-tauri/resources/${defaultKeymap.fileName}`]);
  if (!response.ok) {
    throw new Error(`failed to load ${defaultKeymap.fileName}: ${response.status} ${response.statusText}`);
  }

  const parsed = parseKeymap(new Uint8Array(await response.arrayBuffer()), null);
  browserTemplate = parsed.template;
  activeDefaultKeymapId = defaultKeymap.id;
  return parsed.document;
}

export async function openKeymapFile(): Promise<KeymapDocument | null> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      filters: fileFilters,
      multiple: false
    });

    if (typeof selected !== "string") {
      return null;
    }

    return loadKeymap(selected);
  }

  const file = await pickBrowserFile();
  if (!file) {
    return null;
  }

  const parsed = parseKeymap(new Uint8Array(await file.arrayBuffer()), file.name);
  browserTemplate = parsed.template;
  activeDefaultKeymapId = null;
  return parsed.document;
}

export async function saveKeymapFile(document: KeymapDocument, saveAs: boolean): Promise<SaveResult | null> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { save } = await import("@tauri-apps/plugin-dialog");
    let targetPath = document.path;

    if (saveAs || !targetPath) {
      const selected = await save({
        defaultPath: targetPath ?? getActiveDefaultKeymapFileName(),
        filters: fileFilters
      });

      if (!selected) {
        return null;
      }

      targetPath = selected.endsWith(".bwkeymap") ? selected : `${selected}.bwkeymap`;
    }

    return invoke<SaveResult>("save_keymap", {
      path: targetPath,
      document
    });
  }

  if (!browserTemplate) {
    throw new Error("no keymap template loaded. Open a keymap before saving.");
  }

  const fileName = ensureKeymapExtension(document.path ?? getActiveDefaultKeymapFileName());
  const bytes = serializeKeymap(document, browserTemplate);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  const url = URL.createObjectURL(new Blob([body], { type: "application/octet-stream" }));
  const anchor = documentNode().createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);

  return {
    path: fileName
  };
}

function pickBrowserFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = documentNode().createElement("input");
    input.type = "file";
    input.accept = ".bwkeymap";
    input.style.display = "none";
    input.addEventListener(
      "change",
      () => {
        resolve(input.files?.[0] ?? null);
        input.remove();
      },
      { once: true }
    );

    documentNode().body.appendChild(input);
    input.click();
  });
}

function ensureKeymapExtension(path: string): string {
  return path.endsWith(".bwkeymap") ? path : `${path}.bwkeymap`;
}

function selectDefaultKeymap(defaultKeymapId?: string): DefaultKeymap {
  const selected = DEFAULT_KEYMAPS.find((keymap) => keymap.id === defaultKeymapId) ?? DEFAULT_KEYMAPS[0];

  if (!selected) {
    throw new Error("no bundled default keymaps were found");
  }

  return selected;
}

function getActiveDefaultKeymapFileName(): string {
  return selectDefaultKeymap(activeDefaultKeymapId ?? undefined).fileName;
}

function documentNode(): Document {
  return window.document;
}
