use std::{env, fs, path::PathBuf};

fn main() {
    generate_default_keymaps();
    tauri_build::build()
}

fn generate_default_keymaps() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("missing CARGO_MANIFEST_DIR"));
    let resources_dir = manifest_dir.join("resources");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("missing OUT_DIR"));
    let generated_path = out_dir.join("default_keymaps.rs");

    println!("cargo:rerun-if-changed={}", resources_dir.display());

    let mut keymaps = fs::read_dir(&resources_dir)
        .expect("failed to read resources directory")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("bwkeymap"))
        .collect::<Vec<_>>();

    keymaps.sort_by(|left, right| {
        let left_name = left
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let right_name = right
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        left_name.cmp(right_name)
    });

    let entries = keymaps
        .iter()
        .map(|path| {
            let file_name = path.file_name().and_then(|value| value.to_str()).expect("invalid keymap file name");
            let id = path.file_stem().and_then(|value| value.to_str()).expect("invalid keymap id");
            let label = format!("Bitwig {id}");
            format!(
                "    BundledKeymap {{ id: {id:?}, label: {label:?}, file_name: {file_name:?}, bytes: include_bytes!(r#\"{}\"#) }},",
                path.display()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let generated = format!("pub const DEFAULT_KEYMAPS: &[BundledKeymap] = &[\n{entries}\n];\n");
    fs::write(generated_path, generated).expect("failed to write generated default keymaps");
}
