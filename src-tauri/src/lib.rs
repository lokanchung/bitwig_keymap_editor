mod keymap;

use keymap::{load_default_keymap, load_keymap as load_keymap_file, save_keymap as save_keymap_file, BinaryTemplate, EditableDocument, KeymapError};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};
use tauri::{Manager, State};

#[derive(Default)]
struct AppState {
    template: Mutex<Option<BinaryTemplate>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    path: String,
}

#[tauri::command]
fn load_keymap(path: Option<String>, state: State<'_, AppState>) -> Result<EditableDocument, String> {
    let (document, template) = match path {
        Some(path) => load_keymap_file(&PathBuf::from(path)).map_err(render_error)?,
        None => load_default_keymap().map_err(render_error)?,
    };
    *lock_template(&state)? = Some(template);
    Ok(document)
}

#[tauri::command]
fn save_keymap(path: String, document: EditableDocument, state: State<'_, AppState>) -> Result<SaveResult, String> {
    let template = lock_template(&state)?
        .clone()
        .ok_or_else(|| "no keymap template loaded. Open a keymap before saving.".to_string())?;

    let output_path = PathBuf::from(path);
    save_keymap_file(&output_path, &document, &template).map_err(render_error)?;

    Ok(SaveResult {
        path: output_path.to_string_lossy().into_owned(),
    })
}

fn lock_template<'a>(state: &'a State<'_, AppState>) -> Result<MutexGuard<'a, Option<BinaryTemplate>>, String> {
    state
        .template
        .lock()
        .map_err(|_| "application state is poisoned".to_string())
}

fn render_error(error: KeymapError) -> String {
    error.to_string()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![load_keymap, save_keymap])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Bitwig Keymap Editor");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Bitwig Keymap Editor");
}
