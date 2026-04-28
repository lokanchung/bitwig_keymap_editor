import { displayShortcut, normalizeShortcut } from "./shortcut";
import type { CommandEntry, KeymapDocument, ShortcutBinding } from "./types";

const FIRST_COMMAND_PREAMBLE = [0x00, 0x00, 0x06, 0x19, 0x00, 0x00, 0x16, 0x32, 0x12, 0x00, 0x00, 0x06, 0x1b];
const COMMAND_PREAMBLE = [0x00, 0x00, 0x06, 0x1b];
const BINDING_PREAMBLE = [0x00, 0x00, 0x06, 0x17];
const COMMAND_SEPARATOR = [0x00, 0x00, 0x00, 0x03];

interface BinaryTemplate {
  prefix: Uint8Array;
  suffix: Uint8Array;
}

interface RawBinding {
  key: string;
  primaryModifier: number;
  mask: number;
  tailFlag: number;
  context: string | null;
}

interface RawCommand {
  name: string;
  primaryBindingIndex: number | null;
  shortcuts: RawBinding[];
}

export interface ParsedKeymap {
  document: KeymapDocument;
  template: BinaryTemplate;
}

export function parseKeymap(bytes: Uint8Array, path: string | null): ParsedKeymap {
  const start = findSequence(bytes, FIRST_COMMAND_PREAMBLE);

  if (start === -1) {
    throw new Error("invalid keymap data: could not locate command section");
  }

  const cursor = new Cursor(bytes, start);
  cursor.expectBytes(FIRST_COMMAND_PREAMBLE);

  const commands: RawCommand[] = [];
  let suffix: Uint8Array | null = null;

  while (suffix === null) {
    const name = cursor.readStringField(0x1633);
    cursor.readEmptyField(0x1634, 0x12);

    const shortcuts: RawBinding[] = [];
    while (cursor.peekBytes(BINDING_PREAMBLE)) {
      cursor.expectBytes(BINDING_PREAMBLE);
      const context = cursor.readStringField(0x1636);
      const primaryModifier = cursor.readU8Field(0x162d, 0x05);
      const mask = cursor.readU8Field(0x162e, 0x01);
      const key = cursor.readStringField(0x162f);
      const tailFlag = cursor.readReservedBindingTail();

      shortcuts.push({
        key,
        primaryModifier,
        mask,
        tailFlag,
        context: context ? context : null
      });
    }

    cursor.expectBytes(COMMAND_SEPARATOR);

    let primaryBindingIndex: number | null;
    if (cursor.peekTagWithType(0x1635, 0x0b)) {
      const [primaryBindingValue] = cursor.readU32PairField(0x1635, 0x0b);
      const nextValue = nextBindingValue(commands);
      const primaryBindingOffset = primaryBindingValue - nextValue;

      if (primaryBindingOffset < 0 || primaryBindingOffset >= shortcuts.length) {
        throw new Error(`invalid keymap data: primary binding reference ${primaryBindingValue} is out of range for command '${name}'`);
      }

      primaryBindingIndex = primaryBindingOffset;
    } else if (cursor.peekTagWithType(0x1635, 0x0a)) {
      cursor.readU32Field(0x1635, 0x0a);
      primaryBindingIndex = null;
    } else {
      throw new Error("invalid keymap data: missing command terminator field");
    }

    commands.push({
      name,
      primaryBindingIndex,
      shortcuts
    });

    if (cursor.peekBytes(COMMAND_PREAMBLE)) {
      cursor.expectBytes(COMMAND_PREAMBLE);
    } else {
      suffix = bytes.slice(cursor.position);
    }
  }

  return {
    document: toEditableDocument(path, commands),
    template: {
      prefix: bytes.slice(0, start),
      suffix
    }
  };
}

export function serializeKeymap(document: KeymapDocument, template: BinaryTemplate): Uint8Array {
  const chunks: Uint8Array[] = [template.prefix, Uint8Array.from(FIRST_COMMAND_PREAMBLE)];
  let nextValue = 3;

  document.commands.forEach((command, commandIndex) => {
    if (commandIndex > 0) {
      chunks.push(Uint8Array.from(COMMAND_PREAMBLE));
    }

    writeStringField(chunks, 0x1633, command.name);
    writeEmptyField(chunks, 0x1634, 0x12);

    command.shortcuts.forEach((binding) => {
      chunks.push(Uint8Array.from(BINDING_PREAMBLE));
      writeStringField(chunks, 0x1636, binding.context ?? "");
      writeU8Field(chunks, 0x162d, 0x05, binding.primaryModifier);
      writeU8Field(chunks, 0x162e, 0x01, binding.mask);
      writeStringField(chunks, 0x162f, binding.key);
      writeReservedBindingTail(chunks, binding.tailFlag);
    });

    chunks.push(Uint8Array.from(COMMAND_SEPARATOR));

    if (command.shortcuts.length === 0) {
      writeU32Field(chunks, 0x1635, 0x0a, 0);
    } else {
      const primaryBindingOffset = Math.max(
        0,
        command.shortcuts.findIndex((binding) => binding.id === command.primaryBindingId)
      );
      writeU32PairField(chunks, 0x1635, 0x0b, nextValue + primaryBindingOffset, 0);
      nextValue += command.shortcuts.length + 1;
    }
  });

  chunks.push(template.suffix);
  return concatBytes(chunks);
}

function toEditableDocument(path: string | null, rawCommands: RawCommand[]): KeymapDocument {
  const globalContexts = new Set<string>();

  const commands: CommandEntry[] = rawCommands.map((command, commandIndex) => {
    const knownContexts = new Set<string>();
    const shortcuts: ShortcutBinding[] = command.shortcuts.map((binding, bindingIndex) => {
      if (binding.context) {
        knownContexts.add(binding.context);
        globalContexts.add(binding.context);
      }

      return {
        id: `${commandIndex}:${bindingIndex}`,
        key: binding.key,
        primaryModifier: binding.primaryModifier,
        mask: binding.mask,
        tailFlag: binding.tailFlag,
        context: binding.context,
        hasContextHint: Boolean(binding.context),
        display: displayShortcut(binding.key, binding.primaryModifier, binding.mask, binding.context),
        normalized: normalizeShortcut(binding.key, binding.primaryModifier, binding.mask, binding.context)
      };
    });

    return {
      id: commandIndex.toString(),
      name: command.name,
      primaryBindingId: command.primaryBindingIndex === null ? null : `${commandIndex}:${command.primaryBindingIndex}`,
      knownContexts: [...knownContexts].sort((left, right) => left.localeCompare(right)),
      shortcuts
    };
  });

  return {
    path,
    commands,
    globalContexts: [...globalContexts].sort((left, right) => left.localeCompare(right))
  };
}

function findSequence(haystack: Uint8Array, needle: number[]): number {
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((value, offset) => haystack[index + offset] === value)) {
      return index;
    }
  }

  return -1;
}

function nextBindingValue(commands: RawCommand[]): number {
  return commands.reduce((nextValue, command) => nextValue + (command.shortcuts.length > 0 ? command.shortcuts.length + 1 : 0), 3);
}

function writeTag(chunks: Uint8Array[], tag: number, fieldType: number) {
  const bytes = new Uint8Array(5);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, tag);
  view.setUint8(4, fieldType);
  chunks.push(bytes);
}

function writeStringField(chunks: Uint8Array[], tag: number, value: string) {
  const valueBytes = new TextEncoder().encode(value);
  writeTag(chunks, tag, 0x08);
  chunks.push(u32Bytes(valueBytes.length), valueBytes);
}

function writeEmptyField(chunks: Uint8Array[], tag: number, fieldType: number) {
  writeTag(chunks, tag, fieldType);
}

function writeReservedBindingTail(chunks: Uint8Array[], tailFlag: number) {
  writeTag(chunks, 0x1630, 0x05);
  chunks.push(Uint8Array.from([tailFlag, 0, 0, 0, 0]));
}

function writeU8Field(chunks: Uint8Array[], tag: number, fieldType: number, value: number) {
  writeTag(chunks, tag, fieldType);
  chunks.push(Uint8Array.from([value]));
}

function writeU32Field(chunks: Uint8Array[], tag: number, fieldType: number, value: number) {
  writeTag(chunks, tag, fieldType);
  chunks.push(u32Bytes(value));
}

function writeU32PairField(chunks: Uint8Array[], tag: number, fieldType: number, first: number, second: number) {
  writeTag(chunks, tag, fieldType);
  chunks.push(u32Bytes(first), u32Bytes(second));
}

function u32Bytes(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;

  chunks.forEach((chunk) => {
    out.set(chunk, offset);
    offset += chunk.length;
  });

  return out;
}

class Cursor {
  constructor(
    private readonly bytes: Uint8Array,
    public position: number
  ) {}

  expectBytes(expected: number[]) {
    if (!this.peekBytes(expected)) {
      throw new Error(`invalid keymap data: expected byte sequence at offset ${this.position}`);
    }

    this.position += expected.length;
  }

  peekBytes(expected: number[]): boolean {
    return expected.every((value, offset) => this.bytes[this.position + offset] === value);
  }

  peekTagWithType(tag: number, fieldType: number): boolean {
    if (this.position + 5 > this.bytes.length) {
      return false;
    }

    return this.readU32At(this.position) === tag && this.bytes[this.position + 4] === fieldType;
  }

  readStringField(tag: number): string {
    this.expectTag(tag, 0x08);
    const length = this.readU32();
    const end = this.position + length;

    if (end > this.bytes.length) {
      throw new Error("invalid keymap data: string field exceeded file length");
    }

    const value = new TextDecoder().decode(this.bytes.slice(this.position, end));
    this.position = end;
    return value;
  }

  readU8Field(tag: number, fieldType: number): number {
    this.expectTag(tag, fieldType);

    if (this.position >= this.bytes.length) {
      throw new Error("invalid keymap data: expected u8 field payload");
    }

    const value = this.bytes[this.position];
    this.position += 1;
    return value;
  }

  readU32Field(tag: number, fieldType: number): number {
    this.expectTag(tag, fieldType);
    return this.readU32();
  }

  readU32PairField(tag: number, fieldType: number): [number, number] {
    this.expectTag(tag, fieldType);
    return [this.readU32(), this.readU32()];
  }

  readEmptyField(tag: number, fieldType: number) {
    this.expectTag(tag, fieldType);
  }

  readReservedBindingTail(): number {
    this.expectTag(0x1630, 0x05);

    if (this.position + 5 > this.bytes.length) {
      throw new Error("invalid keymap data: expected reserved binding tail");
    }

    const flag = this.bytes[this.position];
    const reserved = this.bytes.slice(this.position + 1, this.position + 5);
    if (reserved.some((value) => value !== 0)) {
      throw new Error(`invalid keymap data: unexpected reserved binding tail at offset ${this.position}`);
    }

    this.position += 5;
    return flag;
  }

  private expectTag(tag: number, fieldType: number) {
    if (!this.peekTagWithType(tag, fieldType)) {
      throw new Error(`invalid keymap data: expected tag ${tag.toString(16)} type ${fieldType.toString(16)} at offset ${this.position}`);
    }

    this.position += 5;
  }

  private readU32(): number {
    if (this.position + 4 > this.bytes.length) {
      throw new Error("invalid keymap data: expected 4-byte payload");
    }

    const value = this.readU32At(this.position);
    this.position += 4;
    return value;
  }

  private readU32At(offset: number): number {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset + offset, 4).getUint32(0);
  }
}
