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

export interface ShortcutDraft {
  key: string;
  primaryModifier: number;
  mask: number;
  tailFlag: number;
  context: string | null;
}
