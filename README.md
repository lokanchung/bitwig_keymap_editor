# Bitwig Keymap Editor

A desktop and browser-based editor for Bitwig Studio `.bwkeymap` files.

The app loads Bitwig keymaps, displays commands and their assigned shortcuts, and lets you search, add, modify, remove, and save shortcut bindings.

## Features

- Open existing `.bwkeymap` files or start from the bundled `DefaultKeymap.bwkeymap`.
- Add, edit, and remove shortcut bindings.
- Preserve known shortcut contexts.
- Detect shortcut collisions before applying edits.

## Requirements

- Node.js and npm
- Rust and Cargo
- Tauri v2 system prerequisites for your operating system

For desktop development, install the platform dependencies required by Tauri before running the app.

## Install

```sh
npm install
```

## Development

Run the browser-only Vite dev server:

```sh
npm run dev
```

Run the Tauri desktop app:

```sh
npm run tauri dev
```

## Build

Build the web app:

```sh
npm run build:web
```

Build a single-file-friendly web distribution in `dist-single/`:

```sh
npm run build:web:single
```

Build the Tauri desktop app:

```sh
npm run tauri build
```

## Test

Run the Rust keymap parser and serializer tests:

```sh
cd src-tauri
cargo test
```

Run the TypeScript and Vite production build check:

```sh
npm run build
```

## Usage Notes

Bitwig keymap files are binary files. Before overwriting an existing keymap, keep a backup copy of the original `.bwkeymap`.

In the desktop app, `Save` writes back to the currently opened file and `Save As` prompts for a destination. In the browser app, saving downloads a new `.bwkeymap` file because browsers cannot write directly to arbitrary local paths.

The default keymap bundled with the app lives at `src-tauri/resources/DefaultKeymap.bwkeymap`.

## Project Structure

- `src/` - React UI, shortcut handling, browser keymap parser/serializer, and platform adapter.
- `src-tauri/` - Tauri shell, Rust keymap parser/serializer, native file commands, app resources, and capabilities.
- `scripts/` - build helper scripts, including the web single-file inliner.

