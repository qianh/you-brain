use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

pub const DEFAULT_SHORTCUT: &str = "CmdOrCtrl+Shift+Y";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedShortcut {
    pub modifiers: Vec<NamedModifier>,
    pub key: Hotkey,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedModifier {
    CmdOrCtrl,
    Command,
    Control,
    Alt,
    Shift,
    Super,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hotkey {
    Letter(char),
    Digit(u8),
    Function(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutError {
    Empty,
    MissingKey,
    UnknownToken,
}

pub fn effective_shortcut(shared: Option<&str>, local: Option<&str>) -> String {
    for candidate in [shared, local] {
        if let Some(value) = nonempty(candidate) {
            if parse_shortcut(value).is_ok() {
                return value.to_string();
            }
        }
    }
    DEFAULT_SHORTCUT.to_string()
}

pub fn parse_shortcut(input: &str) -> Result<ParsedShortcut, ShortcutError> {
    let tokens: Vec<&str> = input
        .split('+')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return Err(ShortcutError::Empty);
    }
    let mut modifiers = Vec::new();
    let mut key = None;
    for token in tokens {
        if let Some(modifier) = parse_modifier(token) {
            modifiers.push(modifier);
            continue;
        }
        if key.is_some() {
            return Err(ShortcutError::UnknownToken);
        }
        key = Some(parse_key(token).ok_or(ShortcutError::UnknownToken)?);
    }
    Ok(ParsedShortcut {
        modifiers,
        key: key.ok_or(ShortcutError::MissingKey)?,
    })
}

pub fn to_shortcut(parsed: &ParsedShortcut, macos: bool) -> Shortcut {
    let mut modifiers = Modifiers::empty();
    for modifier in &parsed.modifiers {
        modifiers |= match modifier {
            NamedModifier::CmdOrCtrl => {
                if macos {
                    Modifiers::SUPER
                } else {
                    Modifiers::CONTROL
                }
            }
            NamedModifier::Command | NamedModifier::Super => Modifiers::SUPER,
            NamedModifier::Control => Modifiers::CONTROL,
            NamedModifier::Alt => Modifiers::ALT,
            NamedModifier::Shift => Modifiers::SHIFT,
        };
    }
    let code = match parsed.key {
        Hotkey::Letter(letter) => letter_code(letter),
        Hotkey::Digit(digit) => digit_code(digit),
        Hotkey::Function(number) => function_code(number),
    };
    let modifiers = if modifiers.is_empty() {
        None
    } else {
        Some(modifiers)
    };
    Shortcut::new(modifiers, code)
}

fn parse_modifier(token: &str) -> Option<NamedModifier> {
    match token.to_ascii_lowercase().as_str() {
        "cmdorctrl" | "commandorcontrol" => Some(NamedModifier::CmdOrCtrl),
        "cmd" | "command" => Some(NamedModifier::Command),
        "super" | "meta" => Some(NamedModifier::Super),
        "ctrl" | "control" => Some(NamedModifier::Control),
        "alt" | "option" => Some(NamedModifier::Alt),
        "shift" => Some(NamedModifier::Shift),
        _ => None,
    }
}

fn parse_key(token: &str) -> Option<Hotkey> {
    let token = token.trim();
    if token.len() == 1 {
        let ch = token.chars().next()?;
        if ch.is_ascii_alphabetic() {
            return Some(Hotkey::Letter(ch.to_ascii_uppercase()));
        }
        if ch.is_ascii_digit() {
            return Some(Hotkey::Digit(ch.to_digit(10)? as u8));
        }
        return None;
    }
    let lower = token.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("key") {
        let mut chars = rest.chars();
        let letter = chars.next()?;
        if chars.next().is_none() && letter.is_ascii_alphabetic() {
            return Some(Hotkey::Letter(letter.to_ascii_uppercase()));
        }
    }
    if let Some(rest) = lower.strip_prefix("digit") {
        if rest.len() == 1 {
            return Some(Hotkey::Digit(rest.chars().next()?.to_digit(10)? as u8));
        }
    }
    if let Some(rest) = lower.strip_prefix('f') {
        let number: u8 = rest.parse().ok()?;
        if (1..=12).contains(&number) {
            return Some(Hotkey::Function(number));
        }
    }
    None
}

fn letter_code(letter: char) -> Code {
    match letter.to_ascii_uppercase() {
        'A' => Code::KeyA,
        'B' => Code::KeyB,
        'C' => Code::KeyC,
        'D' => Code::KeyD,
        'E' => Code::KeyE,
        'F' => Code::KeyF,
        'G' => Code::KeyG,
        'H' => Code::KeyH,
        'I' => Code::KeyI,
        'J' => Code::KeyJ,
        'K' => Code::KeyK,
        'L' => Code::KeyL,
        'M' => Code::KeyM,
        'N' => Code::KeyN,
        'O' => Code::KeyO,
        'P' => Code::KeyP,
        'Q' => Code::KeyQ,
        'R' => Code::KeyR,
        'S' => Code::KeyS,
        'T' => Code::KeyT,
        'U' => Code::KeyU,
        'V' => Code::KeyV,
        'W' => Code::KeyW,
        'X' => Code::KeyX,
        'Y' => Code::KeyY,
        'Z' => Code::KeyZ,
        _ => Code::KeyY,
    }
}

fn digit_code(digit: u8) -> Code {
    match digit {
        0 => Code::Digit0,
        1 => Code::Digit1,
        2 => Code::Digit2,
        3 => Code::Digit3,
        4 => Code::Digit4,
        5 => Code::Digit5,
        6 => Code::Digit6,
        7 => Code::Digit7,
        8 => Code::Digit8,
        _ => Code::Digit9,
    }
}

fn function_code(number: u8) -> Code {
    match number {
        1 => Code::F1,
        2 => Code::F2,
        3 => Code::F3,
        4 => Code::F4,
        5 => Code::F5,
        6 => Code::F6,
        7 => Code::F7,
        8 => Code::F8,
        9 => Code::F9,
        10 => Code::F10,
        11 => Code::F11,
        _ => Code::F12,
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_default_shortcut() {
        let parsed = parse_shortcut(DEFAULT_SHORTCUT).unwrap();
        assert_eq!(
            parsed.modifiers,
            vec![NamedModifier::CmdOrCtrl, NamedModifier::Shift]
        );
        assert_eq!(parsed.key, Hotkey::Letter('Y'));
    }

    #[test]
    fn accepts_tauri_and_compact_spellings() {
        let tauri = parse_shortcut("CommandOrControl+Shift+KeyY").unwrap();
        assert_eq!(tauri.key, Hotkey::Letter('Y'));
        let compact = parse_shortcut("ctrl+alt+F5").unwrap();
        assert_eq!(
            compact.modifiers,
            vec![NamedModifier::Control, NamedModifier::Alt]
        );
        assert_eq!(compact.key, Hotkey::Function(5));
        let digit = parse_shortcut("Super+Digit1").unwrap();
        assert_eq!(digit.key, Hotkey::Digit(1));
    }

    #[test]
    fn rejects_incomplete_shortcuts() {
        assert_eq!(parse_shortcut("   ").unwrap_err(), ShortcutError::Empty);
        assert_eq!(
            parse_shortcut("Shift").unwrap_err(),
            ShortcutError::MissingKey
        );
        assert!(parse_shortcut("Ctrl+Nope").is_err());
    }

    #[test]
    fn shared_config_wins_when_it_is_usable() {
        assert_eq!(
            effective_shortcut(Some("Ctrl+Alt+Y"), Some("Alt+KeyK")),
            "Ctrl+Alt+Y"
        );
        assert_eq!(effective_shortcut(Some(""), Some("Alt+KeyK")), "Alt+KeyK");
        assert_eq!(
            effective_shortcut(Some("not a shortcut"), Some("")),
            DEFAULT_SHORTCUT
        );
    }

    #[test]
    fn cmd_or_ctrl_follows_the_platform() {
        let parsed = parse_shortcut(DEFAULT_SHORTCUT).unwrap();
        let macos = to_shortcut(&parsed, true);
        let other = to_shortcut(&parsed, false);
        assert_eq!(macos.mods, Modifiers::SUPER | Modifiers::SHIFT);
        assert_eq!(other.mods, Modifiers::CONTROL | Modifiers::SHIFT);
        assert_eq!(macos.key, Code::KeyY);
    }
}
