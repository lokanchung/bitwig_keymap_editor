import defaultKeymapUrl from "../src-tauri/resources/DefaultKeymap.bwkeymap?url";
import { parseKeymap, serializeKeymap, type ParsedKeymap } from "./keymapBinary";
import type { KeymapDocument, SaveResult } from "./types";

const fileFilters = [
  {
    name: "Bitwig keymap",
    extensions: ["bwkeymap"]
  }
];

let browserTemplate: ParsedKeymap["template"] | null = null;

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function loadKeymap(path?: string): Promise<KeymapDocument> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<KeymapDocument>("load_keymap", path ? { path } : {});
  }

  if (path) {
    throw new Error("browser keymap loading uses File objects, not filesystem paths");
  }

  const response = await fetch(defaultKeymapUrl);
  if (!response.ok) {
    throw new Error(`failed to load DefaultKeymap: ${response.status} ${response.statusText}`);
  }

  const parsed = parseKeymap(new Uint8Array(await response.arrayBuffer()), null);
  browserTemplate = parsed.template;
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
  return parsed.document;
}

export async function saveKeymapFile(document: KeymapDocument, saveAs: boolean): Promise<SaveResult | null> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { save } = await import("@tauri-apps/plugin-dialog");
    let targetPath = document.path;

    if (saveAs || !targetPath) {
      const selected = await save({
        defaultPath: targetPath ?? "DefaultKeymap.bwkeymap",
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

  const fileName = ensureKeymapExtension(document.path ?? "DefaultKeymap.bwkeymap");
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

function documentNode(): Document {
  return window.document;
}
