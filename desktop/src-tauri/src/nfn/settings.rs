use super::NfnSettings;
use serde_yml::Value;
use std::path::{Path, PathBuf};

pub fn path() -> Result<PathBuf, String> {
    crate::config::config_dir()
        .map(|directory| directory.join("notifications.yaml"))
        .ok_or_else(|| "Could not determine config directory".into())
}

pub fn parse(yaml: &str, current: &NfnSettings) -> Result<NfnSettings, String> {
    if yaml.len() > 64 * 1024 {
        return Err("Notification settings exceed 64 KiB".into());
    }
    let patch: Value = serde_yml::from_str(yaml).map_err(|error| error.to_string())?;
    let patch = patch
        .as_mapping()
        .ok_or("Notification settings must be a YAML mapping")?;
    let mut value = serde_yml::to_value(current).map_err(|error| error.to_string())?;
    let fields = value.as_mapping_mut().unwrap();
    for (key, setting) in patch {
        if !fields.contains_key(key) {
            return Err(format!(
                "Unknown notification setting: {}",
                key.as_str().unwrap_or("non-text key")
            ));
        }
        fields.insert(key.clone(), setting.clone());
    }
    let settings: NfnSettings = serde_yml::from_value(value).map_err(|error| error.to_string())?;
    settings.validate()?;
    Ok(settings)
}

fn load_at(path: &Path, fallback: &NfnSettings) -> Result<NfnSettings, String> {
    match std::fs::read_to_string(path) {
        Ok(yaml) => parse(&yaml, fallback),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(fallback.clone()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn load(fallback: &NfnSettings) -> Result<NfnSettings, String> {
    load_at(&path()?, fallback)
}

fn save_at(path: &Path, settings: &NfnSettings) -> Result<(), String> {
    settings.validate()?;
    let directory = path.parent().ok_or("Missing config directory")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let yaml = serde_yml::to_string(settings).map_err(|error| error.to_string())?;
    let staged = directory.join(format!(".notifications-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&staged, yaml).map_err(|error| error.to_string())?;
    if let Err(error) = std::fs::rename(&staged, path) {
        let _ = std::fs::remove_file(staged);
        return Err(error.to_string());
    }
    Ok(())
}

pub fn save(settings: &NfnSettings) -> Result<(), String> {
    save_at(&path()?, settings)
}

pub fn ensure(fallback: &NfnSettings) -> Result<NfnSettings, String> {
    let path = path()?;
    let settings = load_at(&path, fallback)?;
    if !path.exists() {
        save_at(&path, &settings)?;
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_yaml_preserves_preferences_and_rejects_mistakes() {
        let current = NfnSettings {
            sound: false,
            preview_seconds: 30,
            ..Default::default()
        };
        let parsed = parse(
            "placement: right\ndisplay: built_in\nmenu_bar_icon: false\n",
            &current,
        )
        .unwrap();
        assert_eq!(parsed.placement, "right");
        assert_eq!(parsed.display, "built_in");
        assert!(!parsed.sound);
        assert_eq!(parsed.preview_seconds, 30);
        assert!(!parsed.menu_bar_icon);
        assert!(
            parse("sound: false", &NfnSettings::default())
                .unwrap()
                .menu_bar_icon
        );
        for yaml in [
            "postion: right",
            "placement: bottom",
            "preview_seconds: 0",
            "sound: perhaps",
            "menu_bar_icon: perhaps",
            "- right",
        ] {
            assert!(parse(yaml, &current).is_err(), "{yaml}");
        }
    }

    #[test]
    fn settings_round_trip_without_the_desktop_or_other_app_config() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notifications.yaml");
        let fallback = NfnSettings {
            sound: false,
            ..Default::default()
        };
        assert_eq!(load_at(&path, &fallback).unwrap(), fallback);
        save_at(&path, &fallback).unwrap();
        assert_eq!(load_at(&path, &NfnSettings::default()).unwrap(), fallback);
        let mut invalid = fallback.clone();
        invalid.placement = "invalid".into();
        assert!(save_at(&path, &invalid).is_err());
        assert_eq!(load_at(&path, &NfnSettings::default()).unwrap(), fallback);
        std::fs::write(&path, "sound: [").unwrap();
        assert!(load_at(&path, &fallback).is_err());
    }

    #[test]
    fn dragged_position_round_trips_and_requires_valid_coordinates() {
        let settings = parse(
            "placement: custom\nposition: {right: 100.5, top: 40}\n",
            &NfnSettings::default(),
        )
        .unwrap();
        assert_eq!(settings.position.as_ref().unwrap().right, 100.5);
        assert_eq!(
            parse(
                &serde_yml::to_string(&settings).unwrap(),
                &NfnSettings::default()
            )
            .unwrap(),
            settings
        );
        for yaml in [
            "placement: custom",
            "position: {right: -1, top: 0}",
            "position: {right: 0, top: .nan}",
            "position: {right: 0, top: 0, typo: 1}",
        ] {
            assert!(parse(yaml, &NfnSettings::default()).is_err(), "{yaml}");
        }
    }
}
