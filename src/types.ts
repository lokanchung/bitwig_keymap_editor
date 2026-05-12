export interface ShortcutBinding {
  id: string;
  key: string;
  primaryModifier: number;
  mask: number;
  tailFlag: number;
  context: string | null;
  hasContextHint: boolean;
  display: string;
  normalized: string;
}

export interface CommandEntry {
  id: string;
  name: string;
  primaryBindingId: string | null;
  knownContexts: string[];
  shortcuts: ShortcutBinding[];
}

export interface KeymapDocument {
  path: string | null;
  commands: CommandEntry[];
  globalContexts: string[];
}

export interface SaveResult {
  path: string;
}

export interface DefaultKeymap {
  id: string;
  label: string;
  fileName: string;
}

export interface ShortcutDraft {
  key: string;
  primaryModifier: number;
  mask: number;
  tailFlag: number;
  context: string | null;
}
