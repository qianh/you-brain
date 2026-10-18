use std::env;
use std::path::PathBuf;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    println!("cargo:rustc-env=YOU_BRAIN_TARGET_TRIPLE={target}");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=binaries");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let sidecar = manifest_dir
        .join("binaries")
        .join(format!("you-brain-{target}"));
    let require = env::var_os("CARGO_FEATURE_REQUIRE_SIDECAR").is_some();
    println!("cargo:rustc-check-cfg=cfg(you_brain_sidecar_present)");
    if sidecar.is_file() {
        println!("cargo:rustc-cfg=you_brain_sidecar_present");
    } else if require {
        panic!(
            "you-brain sidecar is required but missing: {}",
            sidecar.display()
        );
    } else {
        // tauri.conf.json still declares externalBin. Clearing it for this compile lets
        // `cargo check` and dev builds succeed before the real daemon binary is dropped in.
        clear_external_bin_overlay();
        println!(
            "cargo:warning=you-brain sidecar missing ({}); compiling without externalBin",
            sidecar.display()
        );
    }

    tauri_build::build()
}

fn clear_external_bin_overlay() {
    let mut config = env::var("TAURI_CONFIG")
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let bundle = config
        .as_object_mut()
        .expect("TAURI_CONFIG must be a JSON object")
        .entry("bundle")
        .or_insert_with(|| serde_json::json!({}));
    bundle
        .as_object_mut()
        .expect("bundle overlay must be a JSON object")
        .insert("externalBin".to_string(), serde_json::json!([]));
    env::set_var("TAURI_CONFIG", config.to_string());
}
