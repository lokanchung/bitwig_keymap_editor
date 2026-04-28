import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { loadKeymap as loadPlatformKeymap, openKeymapFile, saveKeymapFile } from "./platform";
import { createBinding, displayShortcut, draftFromBinding, keyboardEventToDraft, normalizeShortcut } from "./shortcut";
import type { CommandEntry, KeymapDocument, ShortcutBinding, ShortcutDraft } from "./types";

interface EditorModalState {
  commandId: string;
  bindingId: string | null;
  draft: ShortcutDraft | null;
  existingKey: string;
  existingContext: string | null;
}

interface CollisionState {
  modal: EditorModalState;
  draft: ShortcutDraft;
  collisions: Array<{ commandName: string; bindingId: string; display: string }>;
}

function cloneDocument(document: KeymapDocument): KeymapDocument {
  return {
    path: document.path,
    globalContexts: [...document.globalContexts],
    commands: document.commands.map((command) => ({
      ...command,
      knownContexts: [...command.knownContexts],
      shortcuts: command.shortcuts.map((binding) => ({ ...binding }))
    }))
  };
}

function sortContexts(contexts: string[]): string[] {
  return [...new Set(contexts.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function mergeKnownContexts(command: CommandEntry, globalContexts: string[]): { predefined: string[]; global: string[] } {
  const predefined = sortContexts(command.knownContexts);
  const predefinedSet = new Set(predefined);
  const global = sortContexts(globalContexts).filter((context) => !predefinedSet.has(context));
  return { predefined, global };
}

function nextBindingId(command: CommandEntry): string {
  return `${command.id}:${crypto.randomUUID()}`;
}

function applyBindingEdit(document: KeymapDocument, modal: EditorModalState, draft: ShortcutDraft): KeymapDocument {
  const next = cloneDocument(document);
  const command = next.commands.find((entry) => entry.id === modal.commandId);

  if (!command) {
    return next;
  }

  const newBinding = createBinding(modal.bindingId ?? nextBindingId(command), draft);

  if (modal.bindingId) {
    command.shortcuts = command.shortcuts.map((binding) => (binding.id === modal.bindingId ? newBinding : binding));
  } else {
    command.shortcuts = [...command.shortcuts, newBinding];
  }

  command.knownContexts = sortContexts([...command.knownContexts, draft.context ?? ""]);
  next.globalContexts = sortContexts([...next.globalContexts, draft.context ?? ""]);
  return next;
}

function removeCollisions(document: KeymapDocument, collisions: CollisionState["collisions"]): KeymapDocument {
  const collisionIds = new Set(collisions.map((entry) => entry.bindingId));
  const next = cloneDocument(document);

  next.commands = next.commands.map((command) => ({
    ...command,
    shortcuts: command.shortcuts.filter((binding) => !collisionIds.has(binding.id))
  }));

  return next;
}

function removeCurrentBinding(document: KeymapDocument, commandId: string, bindingId: string): KeymapDocument {
  const next = cloneDocument(document);
  next.commands = next.commands.map((command) =>
    command.id === commandId
      ? {
          ...command,
          shortcuts: command.shortcuts.filter((binding) => binding.id !== bindingId)
        }
      : command
  );
  return next;
}

function findCollisions(document: KeymapDocument, modal: EditorModalState, draft: ShortcutDraft): CollisionState["collisions"] {
  const normalized = normalizeShortcut(draft.key, draft.primaryModifier, draft.mask, draft.context);
  const collisions: CollisionState["collisions"] = [];

  for (const command of document.commands) {
    for (const binding of command.shortcuts) {
      if (binding.id === modal.bindingId) {
        continue;
      }

      if (binding.normalized === normalized) {
        collisions.push({
          commandName: command.name,
          bindingId: binding.id,
          display: displayShortcut(binding.key, binding.primaryModifier, binding.mask, binding.context)
        });
      }
    }
  }

  return collisions;
}

export default function App() {
  const [document, setDocument] = useState<KeymapDocument | null>(null);
  const [status, setStatus] = useState("Loading keymap...");
  const [error, setError] = useState<string | null>(null);
  const [nameQuery, setNameQuery] = useState("");
  const [shortcutQuery, setShortcutQuery] = useState<ShortcutDraft | null>(null);
  const [shortcutQueryDisplay, setShortcutQueryDisplay] = useState("");
  const [editorModal, setEditorModal] = useState<EditorModalState | null>(null);
  const [collisionState, setCollisionState] = useState<CollisionState | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const deferredNameQuery = useDeferredValue(nameQuery);
  const deferredShortcutQuery = useDeferredValue(shortcutQuery);

  const displayedPath = document?.path ?? "DefaultKeymap";

  async function loadKeymap(path?: string) {
    setStatus(path ? `Loading ${path}...` : "Loading keymap...");
    setError(null);

    try {
      const loaded = await loadPlatformKeymap(path);
      setDocument(loaded);
      setIsDirty(false);
      setStatus(loaded.path ? `Loaded ${loaded.path}` : "Loaded DefaultKeymap");
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);
      setStatus("Failed to load keymap");
    }
  }

  useEffect(() => {
    void loadKeymap();
  }, []);

  const filteredCommands = useMemo(() => {
    if (!document) {
      return [];
    }

    const loweredNameQuery = deferredNameQuery.trim().toLowerCase();
    const shortcutNormalized = deferredShortcutQuery
      ? normalizeShortcut(
          deferredShortcutQuery.key,
          deferredShortcutQuery.primaryModifier,
          deferredShortcutQuery.mask,
          deferredShortcutQuery.context
        )
      : null;

    return document.commands.filter((command) => {
      const matchesName = loweredNameQuery.length === 0 || command.name.toLowerCase().includes(loweredNameQuery);
      const matchesShortcut =
        shortcutNormalized === null || command.shortcuts.some((binding) => binding.normalized === shortcutNormalized);
      return matchesName && matchesShortcut;
    });
  }, [deferredNameQuery, deferredShortcutQuery, document]);

  async function openAnyFile() {
    setError(null);
    const loaded = await openKeymapFile();

    if (loaded) {
      setDocument(loaded);
      setIsDirty(false);
      setStatus(loaded.path ? `Loaded ${loaded.path}` : "Loaded keymap");
    }
  }

  async function saveCurrent(saveAs: boolean) {
    if (!document) {
      return;
    }

    try {
      const result = await saveKeymapFile(document, saveAs);

      if (!result) {
        return;
      }

      setDocument({
        ...document,
        path: result.path
      });
      setIsDirty(false);
      setStatus(`Saved ${result.path}`);
      setError(null);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setError(message);
      setStatus("Failed to save keymap");
    }
  }

  function openEditor(command: CommandEntry, binding?: ShortcutBinding) {
    setEditorModal({
      commandId: command.id,
      bindingId: binding?.id ?? null,
      draft: binding ? draftFromBinding(binding) : null,
      existingKey: binding?.display ?? "",
      existingContext: binding?.context ?? null
    });
  }

  function applyDraft(modal: EditorModalState, draft: ShortcutDraft) {
    if (!document) {
      return;
    }

    const collisions = findCollisions(document, modal, draft);

    if (collisions.length > 0) {
      setCollisionState({
        modal,
        draft,
        collisions
      });
      return;
    }

    setDocument(applyBindingEdit(document, modal, draft));
    setIsDirty(true);
    setEditorModal(null);
  }

  function onShortcutSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const draft = keyboardEventToDraft(event);
    if (!draft) {
      return;
    }

    setShortcutQuery(draft);
    setShortcutQueryDisplay(displayShortcut(draft.key, draft.primaryModifier, draft.mask, null));
  }

  function clearShortcutSearch() {
    setShortcutQuery(null);
    setShortcutQueryDisplay("");
  }

  function removeBinding(commandId: string, bindingId: string) {
    if (!document) {
      return;
    }

    setDocument(removeCurrentBinding(document, commandId, bindingId));
    setIsDirty(true);
  }

  const currentCommand = editorModal && document ? document.commands.find((command) => command.id === editorModal.commandId) : null;
  const currentContextChoices = currentCommand && document ? mergeKnownContexts(currentCommand, document.globalContexts) : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Bitwig Keymap Editor</h1>
          <p className="app-subtitle">{displayedPath}</p>
        </div>
        <div className="toolbar">
          <button onClick={() => void openAnyFile()}>Open</button>
          <button disabled={!document} onClick={() => void saveCurrent(false)}>
            Save
          </button>
          <button disabled={!document} onClick={() => void saveCurrent(true)}>
            Save As
          </button>
        </div>
      </header>

      <div className="status-row">
        <span>{status}</span>
        <span>{isDirty ? "Unsaved changes" : "Saved"}</span>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="filters">
        <label className="filter-box">
          <input
            type="text"
            value={nameQuery}
            placeholder="Type to filter actions"
            onChange={(event) => setNameQuery(event.target.value)}
          />
          {nameQuery ? (
            <button className="clear-button" onClick={() => setNameQuery("")} type="button">
              ×
            </button>
          ) : null}
        </label>

        <label className="filter-box">
          <input
            type="text"
            readOnly
            value={shortcutQueryDisplay}
            placeholder="Press keyboard to filter"
            onKeyDown={onShortcutSearchKeyDown}
          />
          {shortcutQueryDisplay ? (
            <button className="clear-button" onClick={clearShortcutSearch} type="button">
              ×
            </button>
          ) : null}
        </label>
      </section>

      <section className="command-list">
        {filteredCommands.map((command) => (
          <div className="command-row" key={command.id}>
            <div className="command-name">{command.name}</div>
            <div className="command-shortcuts">
              {command.shortcuts.map((binding) => (
                <div className="shortcut-pill-wrap" key={binding.id}>
                  <button
                    className={`shortcut-pill ${binding.hasContextHint ? "has-context" : ""}`}
                    onClick={() => openEditor(command, binding)}
                    title={binding.context ? `Context: ${binding.context}` : binding.display}
                    type="button"
                  >
                    {displayShortcut(binding.key, binding.primaryModifier, binding.mask, null)}
                  </button>
                  <button
                    className="remove-shortcut"
                    onClick={() => removeBinding(command.id, binding.id)}
                    title="Remove shortcut"
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button className="add-shortcut" onClick={() => openEditor(command)} type="button">
                +
              </button>
            </div>
          </div>
        ))}
      </section>

      {editorModal && currentCommand && currentContextChoices ? (
        <ShortcutModal
          command={currentCommand}
          modal={editorModal}
          predefinedContexts={currentContextChoices.predefined}
          globalContexts={currentContextChoices.global}
          onCancel={() => setEditorModal(null)}
          onSubmit={(draft) => applyDraft(editorModal, draft)}
          onRemove={
            editorModal.bindingId
              ? () => {
                  removeBinding(editorModal.commandId, editorModal.bindingId!);
                  setEditorModal(null);
                }
              : null
          }
        />
      ) : null}

      {collisionState && document ? (
        <CollisionDialog
          collisions={collisionState.collisions}
          onCancel={() => setCollisionState(null)}
          onIgnore={() => {
            setDocument(applyBindingEdit(document, collisionState.modal, collisionState.draft));
            setIsDirty(true);
            setCollisionState(null);
            setEditorModal(null);
          }}
          onRemoveCollisions={() => {
            const withoutCollisions = removeCollisions(document, collisionState.collisions);
            setDocument(applyBindingEdit(withoutCollisions, collisionState.modal, collisionState.draft));
            setIsDirty(true);
            setCollisionState(null);
            setEditorModal(null);
          }}
        />
      ) : null}
    </div>
  );
}

interface ShortcutModalProps {
  command: CommandEntry;
  modal: EditorModalState;
  predefinedContexts: string[];
  globalContexts: string[];
  onCancel: () => void;
  onSubmit: (draft: ShortcutDraft) => void;
  onRemove: (() => void) | null;
}

function ShortcutModal(props: ShortcutModalProps) {
  const [draft, setDraft] = useState<ShortcutDraft | null>(props.modal.draft);
  const [display, setDisplay] = useState(
    props.modal.draft
      ? displayShortcut(
          props.modal.draft.key,
          props.modal.draft.primaryModifier,
          props.modal.draft.mask,
          null
        )
      : ""
  );
  const [context, setContext] = useState(props.modal.draft?.context ?? "");

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const nextDraft = keyboardEventToDraft(event);
    if (!nextDraft) {
      return;
    }

    setDraft({
      ...nextDraft,
      context: context || null
    });
    setDisplay(displayShortcut(nextDraft.key, nextDraft.primaryModifier, nextDraft.mask, null));
  }

  function onSubmit() {
    if (!draft) {
      return;
    }

    props.onSubmit({
      ...draft,
      context: context || null
    });
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div className="modal-header">
          <h2>Assign shortcut for {props.command.name}</h2>
        </div>

        <div className="modal-body">
          <label className="field-label">Press key to assign to shortcut</label>
          <input
            autoFocus
            className="modal-shortcut-input"
            placeholder="Press key to assign to shortcut"
            readOnly
            value={display}
            onKeyDown={onKeyDown}
          />

          <label className="field-label">Context</label>
          <select
            className="context-select"
            value={context}
            onChange={(event) => {
              const nextContext = event.target.value;
              setContext(nextContext);
              setDraft((currentDraft) =>
                currentDraft
                  ? {
                      ...currentDraft,
                      context: nextContext || null
                    }
                  : currentDraft
              );
            }}
          >
            <option value="">No context</option>
            {props.predefinedContexts.length > 0 ? <optgroup label="Predefined context">{props.predefinedContexts.map((item) => <option key={item} value={item}>{item}</option>)}</optgroup> : null}
            {props.globalContexts.length > 0 ? <optgroup label="Global context">{props.globalContexts.map((item) => <option key={item} value={item}>{item}</option>)}</optgroup> : null}
          </select>
        </div>

        <div className="modal-actions">
          {props.onRemove ? (
            <button className="danger-button" onClick={props.onRemove} type="button">
              Remove
            </button>
          ) : (
            <span />
          )}
          <div className="modal-action-group">
            <button onClick={props.onCancel} type="button">
              Cancel
            </button>
            <button className="primary-button" disabled={!draft} onClick={onSubmit} type="button">
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface CollisionDialogProps {
  collisions: Array<{ commandName: string; bindingId: string; display: string }>;
  onCancel: () => void;
  onIgnore: () => void;
  onRemoveCollisions: () => void;
}

function CollisionDialog(props: CollisionDialogProps) {
  return (
    <div className="modal-backdrop">
      <div className="modal-card collision-card">
        <div className="modal-header">
          <h2>Shortcut collision</h2>
        </div>

        <div className="modal-body">
          <p>The shortcut is already assigned to these commands:</p>
          <ul className="collision-list">
            {props.collisions.map((collision) => (
              <li key={collision.bindingId}>
                <strong>{collision.commandName}</strong>
                <span>{collision.display}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="modal-actions collision-actions">
          <button onClick={props.onCancel} type="button">
            Cancel
          </button>
          <button onClick={props.onIgnore} type="button">
            Ignore collision
          </button>
          <button className="primary-button" onClick={props.onRemoveCollisions} type="button">
            Remove colliding shortcut
          </button>
        </div>
      </div>
    </div>
  );
}
