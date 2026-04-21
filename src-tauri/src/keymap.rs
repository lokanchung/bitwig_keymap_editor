use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use thiserror::Error;

const FIRST_COMMAND_PREAMBLE: &[u8] = &[0x00, 0x00, 0x06, 0x19, 0x00, 0x00, 0x16, 0x32, 0x12, 0x00, 0x00, 0x06, 0x1B];
const COMMAND_PREAMBLE: &[u8] = &[0x00, 0x00, 0x06, 0x1B];
const BINDING_PREAMBLE: &[u8] = &[0x00, 0x00, 0x06, 0x17];
const COMMAND_SEPARATOR: &[u8] = &[0x00, 0x00, 0x00, 0x03];
const DEFAULT_KEYMAP_NAME: &str = "DefaultKeymap";
const DEFAULT_KEYMAP_BYTES: &[u8] = include_bytes!("../resources/DefaultKeymap.bwkeymap");

#[derive(Debug, Error)]
pub enum KeymapError {
    #[error("failed to read keymap: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid keymap data: {0}")]
    InvalidFormat(String),
}

#[derive(Clone, Debug)]
pub struct BinaryTemplate {
    prefix: Vec<u8>,
    suffix: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableBinding {
    pub id: String,
    pub key: String,
    pub primary_modifier: u8,
    pub mask: u8,
    pub tail_flag: u8,
    pub context: Option<String>,
    pub has_context_hint: bool,
    pub display: String,
    pub normalized: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableCommand {
    pub id: String,
    pub name: String,
    pub primary_binding_id: Option<String>,
    pub known_contexts: Vec<String>,
    pub shortcuts: Vec<EditableBinding>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableDocument {
    pub path: Option<String>,
    pub commands: Vec<EditableCommand>,
    pub global_contexts: Vec<String>,
}

#[derive(Clone, Debug)]
struct ParsedDocument {
    template: BinaryTemplate,
    commands: Vec<RawCommand>,
}

#[derive(Clone, Debug)]
struct RawCommand {
    name: String,
    primary_binding_index: Option<usize>,
    shortcuts: Vec<RawBinding>,
}

#[derive(Clone, Debug)]
struct RawBinding {
    key: String,
    primary_modifier: u8,
    mask: u8,
    tail_flag: u8,
    context: Option<String>,
}

pub fn load_keymap(path: &Path) -> Result<(EditableDocument, BinaryTemplate), KeymapError> {
    let bytes = fs::read(path)?;
    let parsed = parse_keymap(&bytes)?;
    let document = to_editable_document(path.to_path_buf(), &parsed.commands);
    Ok((document, parsed.template))
}

pub fn load_default_keymap() -> Result<(EditableDocument, BinaryTemplate), KeymapError> {
    let parsed = parse_keymap(DEFAULT_KEYMAP_BYTES)?;
    let mut document = to_editable_document(PathBuf::from(DEFAULT_KEYMAP_NAME), &parsed.commands);
    document.path = None;
    Ok((document, parsed.template))
}

pub fn save_keymap(path: &Path, document: &EditableDocument, template: &BinaryTemplate) -> Result<(), KeymapError> {
    let commands = document
        .commands
        .iter()
        .map(|command| RawCommand {
            name: command.name.clone(),
            primary_binding_index: command
                .primary_binding_id
                .as_ref()
                .and_then(|binding_id| command.shortcuts.iter().position(|binding| binding.id == *binding_id))
                .or_else(|| (!command.shortcuts.is_empty()).then_some(0)),
            shortcuts: command
                .shortcuts
                .iter()
                .map(|binding| RawBinding {
                    key: binding.key.clone(),
                    primary_modifier: binding.primary_modifier,
                    mask: binding.mask,
                    tail_flag: binding.tail_flag,
                    context: binding.context.clone().filter(|value| !value.is_empty()),
                })
                .collect(),
        })
        .collect::<Vec<_>>();

    let bytes = serialize_keymap(template, &commands);
    fs::write(path, bytes)?;
    Ok(())
}

fn parse_keymap(bytes: &[u8]) -> Result<ParsedDocument, KeymapError> {
    let start = find_sequence(bytes, FIRST_COMMAND_PREAMBLE)
        .ok_or_else(|| KeymapError::InvalidFormat("could not locate command section".to_string()))?;

    let prefix = bytes[..start].to_vec();
    let mut cursor = Cursor::new(bytes, start);

    cursor.expect_bytes(FIRST_COMMAND_PREAMBLE)?;

    let mut commands = Vec::new();
    let suffix = loop {
        let name = cursor.read_string_field(0x1633)?;
        cursor.read_empty_field(0x1634, 0x12)?;

        let mut shortcuts = Vec::new();
        while cursor.peek_bytes(BINDING_PREAMBLE) {
            cursor.expect_bytes(BINDING_PREAMBLE)?;
            let context = cursor.read_string_field(0x1636)?;
            let primary_modifier = cursor.read_u8_field(0x162D, 0x05)?;
            let mask = cursor.read_u8_field(0x162E, 0x01)?;
            let key = cursor.read_string_field(0x162F)?;
            let tail_flag = cursor.read_reserved_binding_tail()?;

            shortcuts.push(RawBinding {
                key,
                primary_modifier,
                mask,
                tail_flag,
                context: (!context.is_empty()).then_some(context),
            });
        }

        cursor.expect_bytes(COMMAND_SEPARATOR)?;

        let primary_binding_index = if cursor.peek_tag_with_type(0x1635, 0x0B) {
            let (primary_binding_value, _) = cursor.read_u32_pair_field(0x1635, 0x0B)?;
            let next_value = next_binding_value(&commands);
            let primary_binding_offset = primary_binding_value
                .checked_sub(next_value)
                .ok_or_else(|| {
                    KeymapError::InvalidFormat(format!(
                        "primary binding reference {primary_binding_value} precedes command base {next_value} for command '{name}'"
                    ))
                })? as usize;

            if primary_binding_offset >= shortcuts.len() {
                return Err(KeymapError::InvalidFormat(format!(
                    "primary binding reference {primary_binding_value} is out of range for command '{name}'"
                )));
            }

            Some(primary_binding_offset)
        } else if cursor.peek_tag_with_type(0x1635, 0x0A) {
            cursor.read_u32_field(0x1635, 0x0A)?;
            None
        } else {
            return Err(KeymapError::InvalidFormat("missing command terminator field".to_string()));
        };

        commands.push(RawCommand {
            name,
            primary_binding_index,
            shortcuts,
        });

        if cursor.peek_bytes(COMMAND_PREAMBLE) {
            cursor.expect_bytes(COMMAND_PREAMBLE)?;
            continue;
        }

        break bytes[cursor.position()..].to_vec();
    };

    Ok(ParsedDocument {
        template: BinaryTemplate { prefix, suffix },
        commands,
    })
}

fn serialize_keymap(template: &BinaryTemplate, commands: &[RawCommand]) -> Vec<u8> {
    let mut out = template.prefix.clone();
    out.extend_from_slice(FIRST_COMMAND_PREAMBLE);

    let mut next_value = 3_u32;

    for (index, command) in commands.iter().enumerate() {
        if index > 0 {
            out.extend_from_slice(COMMAND_PREAMBLE);
        }

        write_string_field(&mut out, 0x1633, &command.name);
        write_empty_field(&mut out, 0x1634, 0x12);

        for binding in &command.shortcuts {
            out.extend_from_slice(BINDING_PREAMBLE);
            write_string_field(&mut out, 0x1636, binding.context.as_deref().unwrap_or_default());
            write_u8_field(&mut out, 0x162D, 0x05, binding.primary_modifier);
            write_u8_field(&mut out, 0x162E, 0x01, binding.mask);
            write_string_field(&mut out, 0x162F, &binding.key);
            write_reserved_binding_tail(&mut out, binding.tail_flag);
        }

        out.extend_from_slice(COMMAND_SEPARATOR);

        if command.shortcuts.is_empty() {
            write_u32_field(&mut out, 0x1635, 0x0A, 0);
        } else {
            let primary_binding_offset = command
                .primary_binding_index
                .filter(|index| *index < command.shortcuts.len())
                .unwrap_or(0) as u32;
            let primary_binding_value = next_value + primary_binding_offset;
            write_u32_pair_field(&mut out, 0x1635, 0x0B, primary_binding_value, 0);
            next_value += command.shortcuts.len() as u32 + 1;
        }
    }

    out.extend_from_slice(&template.suffix);
    out
}

fn to_editable_document(path: PathBuf, commands: &[RawCommand]) -> EditableDocument {
    let mut global_contexts = BTreeSet::new();
    let commands = commands
        .iter()
        .enumerate()
        .map(|(command_index, command)| {
            let mut known_contexts = BTreeSet::new();
            let primary_binding_id = command
                .primary_binding_index
                .map(|binding_index| format!("{command_index}:{binding_index}"));
            let shortcuts = command
                .shortcuts
                .iter()
                .enumerate()
                .map(|(binding_index, binding)| {
                    if let Some(context) = binding.context.as_ref() {
                        known_contexts.insert(context.clone());
                        global_contexts.insert(context.clone());
                    }

                    EditableBinding {
                        id: format!("{command_index}:{binding_index}"),
                        key: binding.key.clone(),
                        primary_modifier: binding.primary_modifier,
                        mask: binding.mask,
                        tail_flag: binding.tail_flag,
                        context: binding.context.clone(),
                        has_context_hint: binding.context.is_some(),
                        display: display_shortcut(binding),
                        normalized: normalize_shortcut(binding),
                    }
                })
                .collect::<Vec<_>>();

            EditableCommand {
                id: command_index.to_string(),
                name: command.name.clone(),
                primary_binding_id,
                known_contexts: known_contexts.into_iter().collect(),
                shortcuts,
            }
        })
        .collect::<Vec<_>>();

    EditableDocument {
        path: Some(path.to_string_lossy().into_owned()),
        commands,
        global_contexts: global_contexts.into_iter().collect(),
    }
}

fn normalize_shortcut(binding: &RawBinding) -> String {
    let mut parts = Vec::new();

    if binding.primary_modifier == 1 {
        parts.push("ctrl".to_string());
    }

    if binding.mask & 4 != 0 {
        parts.push("meta".to_string());
    }

    if binding.mask & 1 != 0 {
        parts.push("shift".to_string());
    }

    if binding.mask & 8 != 0 {
        parts.push("alt".to_string());
    }

    parts.push(binding.key.to_lowercase());
    format!("{}::{}", parts.join("+"), binding.context.as_deref().unwrap_or("").to_lowercase())
}

fn display_shortcut(binding: &RawBinding) -> String {
    let mut parts = Vec::new();

    if binding.primary_modifier == 1 {
        parts.push("Ctrl".to_string());
    }

    if binding.mask & 4 != 0 {
        parts.push("Meta".to_string());
    }

    if binding.mask & 1 != 0 {
        parts.push("Shift".to_string());
    }

    if binding.mask & 8 != 0 {
        parts.push("Alt".to_string());
    }

    parts.push(display_key_label(&binding.key));

    if let Some(context) = binding.context.as_ref() {
        format!("{} [{}]", parts.join("+"), context)
    } else {
        parts.join("+")
    }
}

fn display_key_label(key: &str) -> String {
    match key {
        "backspace" => "Backspace".to_string(),
        "delete" => "Delete".to_string(),
        "down" => "Down".to_string(),
        "end" => "End".to_string(),
        "enter" => "Enter".to_string(),
        "escape" => "Escape".to_string(),
        "home" => "Home".to_string(),
        "insert" => "Insert".to_string(),
        "keypad_enter" => "Numpad Enter".to_string(),
        "left" => "Left".to_string(),
        "pagedown" => "Page Down".to_string(),
        "pageup" => "Page Up".to_string(),
        "right" => "Right".to_string(),
        "space" => "Space".to_string(),
        "tab" => "Tab".to_string(),
        "up" => "Up".to_string(),
        _ if key.len() == 1 || key.starts_with('F') => key.to_uppercase(),
        _ => key
            .split('_')
            .map(|segment| {
                let mut chars = segment.chars();
                match chars.next() {
                    Some(first) => {
                        let mut title = String::new();
                        title.extend(first.to_uppercase());
                        title.push_str(&chars.as_str().to_lowercase());
                        title
                    }
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn find_sequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn next_binding_value(commands: &[RawCommand]) -> u32 {
    let mut next_value = 3_u32;

    for command in commands {
        if !command.shortcuts.is_empty() {
            next_value += command.shortcuts.len() as u32 + 1;
        }
    }

    next_value
}

fn write_tag(out: &mut Vec<u8>, tag: u32, field_type: u8) {
    out.extend_from_slice(&tag.to_be_bytes());
    out.push(field_type);
}

fn write_string_field(out: &mut Vec<u8>, tag: u32, value: &str) {
    write_tag(out, tag, 0x08);
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value.as_bytes());
}

fn write_empty_field(out: &mut Vec<u8>, tag: u32, field_type: u8) {
    write_tag(out, tag, field_type);
}

fn write_reserved_binding_tail(out: &mut Vec<u8>, tail_flag: u8) {
    write_tag(out, 0x1630, 0x05);
    out.push(tail_flag);
    out.extend_from_slice(&[0, 0, 0, 0]);
}

fn write_u8_field(out: &mut Vec<u8>, tag: u32, field_type: u8, value: u8) {
    write_tag(out, tag, field_type);
    out.push(value);
}

fn write_u32_field(out: &mut Vec<u8>, tag: u32, field_type: u8, value: u32) {
    write_tag(out, tag, field_type);
    out.extend_from_slice(&value.to_be_bytes());
}

fn write_u32_pair_field(out: &mut Vec<u8>, tag: u32, field_type: u8, first: u32, second: u32) {
    write_tag(out, tag, field_type);
    out.extend_from_slice(&first.to_be_bytes());
    out.extend_from_slice(&second.to_be_bytes());
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8], position: usize) -> Self {
        Self { bytes, position }
    }

    fn position(&self) -> usize {
        self.position
    }

    fn expect_bytes(&mut self, expected: &[u8]) -> Result<(), KeymapError> {
        if self.bytes.get(self.position..self.position + expected.len()) == Some(expected) {
            self.position += expected.len();
            Ok(())
        } else {
            Err(KeymapError::InvalidFormat(format!(
                "expected byte sequence {:02X?} at offset {}",
                expected, self.position
            )))
        }
    }

    fn peek_bytes(&self, expected: &[u8]) -> bool {
        self.bytes.get(self.position..self.position + expected.len()) == Some(expected)
    }

    fn peek_tag_with_type(&self, tag: u32, field_type: u8) -> bool {
        let Some(slice) = self.bytes.get(self.position..self.position + 5) else {
            return false;
        };

        slice[..4] == tag.to_be_bytes() && slice[4] == field_type
    }

    fn read_string_field(&mut self, tag: u32) -> Result<String, KeymapError> {
        self.expect_tag(tag, 0x08)?;
        let length = self.read_u32()? as usize;
        let slice = self
            .bytes
            .get(self.position..self.position + length)
            .ok_or_else(|| KeymapError::InvalidFormat("string field exceeded file length".to_string()))?;
        self.position += length;
        Ok(String::from_utf8_lossy(slice).into_owned())
    }

    fn read_u8_field(&mut self, tag: u32, field_type: u8) -> Result<u8, KeymapError> {
        self.expect_tag(tag, field_type)?;
        let value = *self
            .bytes
            .get(self.position)
            .ok_or_else(|| KeymapError::InvalidFormat("expected u8 field payload".to_string()))?;
        self.position += 1;
        Ok(value)
    }

    fn read_u32_field(&mut self, tag: u32, field_type: u8) -> Result<u32, KeymapError> {
        self.expect_tag(tag, field_type)?;
        self.read_u32()
    }

    fn read_u32_pair_field(&mut self, tag: u32, field_type: u8) -> Result<(u32, u32), KeymapError> {
        self.expect_tag(tag, field_type)?;
        let first = self.read_u32()?;
        let second = self.read_u32()?;
        Ok((first, second))
    }

    fn read_empty_field(&mut self, tag: u32, field_type: u8) -> Result<(), KeymapError> {
        self.expect_tag(tag, field_type)
    }

    fn read_reserved_binding_tail(&mut self) -> Result<u8, KeymapError> {
        self.expect_tag(0x1630, 0x05)?;
        let Some(slice) = self.bytes.get(self.position..self.position + 5) else {
            return Err(KeymapError::InvalidFormat("expected reserved binding tail".to_string()));
        };

        if slice[1..] != [0, 0, 0, 0] {
            return Err(KeymapError::InvalidFormat(format!(
                "unexpected reserved binding tail at offset {}",
                self.position
            )));
        }

        let flag = slice[0];
        self.position += 5;
        Ok(flag)
    }

    fn expect_tag(&mut self, tag: u32, field_type: u8) -> Result<(), KeymapError> {
        let Some(slice) = self.bytes.get(self.position..self.position + 5) else {
            return Err(KeymapError::InvalidFormat("unexpected end of file".to_string()));
        };

        if slice[..4] != tag.to_be_bytes() || slice[4] != field_type {
            return Err(KeymapError::InvalidFormat(format!(
                "expected tag {tag:04X} type {field_type:02X} at offset {}",
                self.position
            )));
        }

        self.position += 5;
        Ok(())
    }

    fn read_u32(&mut self) -> Result<u32, KeymapError> {
        let Some(slice) = self.bytes.get(self.position..self.position + 4) else {
            return Err(KeymapError::InvalidFormat("expected 4-byte payload".to_string()));
        };

        self.position += 4;
        Ok(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("DefaultKeymap.bwkeymap")
    }

    #[test]
    fn parses_sample_keymap() {
        let sample = fs::read(sample_path()).unwrap();
        let parsed = parse_keymap(&sample).unwrap();
        assert_eq!(parsed.commands.len(), 781);
        assert_eq!(parsed.commands[0].name, "New");
        assert_eq!(parsed.commands[0].shortcuts[0].key, "N");
        assert!(parsed.commands.iter().any(|command| command.name == "Quit"));
    }

    #[test]
    fn round_trips_sample_keymap() {
        let sample = fs::read(sample_path()).unwrap();
        let parsed = parse_keymap(&sample).unwrap();
        let rebuilt = serialize_keymap(&parsed.template, &parsed.commands);
        let reparsed = parse_keymap(&rebuilt).unwrap();

        assert_eq!(parsed.commands.len(), reparsed.commands.len());

        for (left, right) in parsed.commands.iter().zip(reparsed.commands.iter()) {
            assert_eq!(left.name, right.name);
            assert_eq!(left.shortcuts.len(), right.shortcuts.len());

            for (left_binding, right_binding) in left.shortcuts.iter().zip(right.shortcuts.iter()) {
                assert_eq!(left_binding.key, right_binding.key);
                assert_eq!(left_binding.primary_modifier, right_binding.primary_modifier);
                assert_eq!(left_binding.mask, right_binding.mask);
                assert_eq!(left_binding.tail_flag, right_binding.tail_flag);
                assert_eq!(left_binding.context, right_binding.context);
            }
        }
    }

    #[test]
    fn preserves_sample_bytes_exactly() {
        let sample = fs::read(sample_path()).unwrap();
        let parsed = parse_keymap(&sample).unwrap();
        let rebuilt = serialize_keymap(&parsed.template, &parsed.commands);

        let first_diff = sample
            .iter()
            .zip(rebuilt.iter())
            .position(|(left, right)| left != right)
            .or_else(|| (sample.len() != rebuilt.len()).then_some(sample.len().min(rebuilt.len())));

        if let Some(offset) = first_diff {
            panic!(
                "bytes differ at offset {offset}: original={:02X?} rebuilt={:02X?}",
                &sample[offset.saturating_sub(8)..sample.len().min(offset + 16)],
                &rebuilt[offset.saturating_sub(8)..rebuilt.len().min(offset + 16)]
            );
        }

        assert_eq!(parsed.commands[266].name, "focus_browser_search_field");
        assert_eq!(parsed.commands[266].primary_binding_index, Some(5));
    }
}
