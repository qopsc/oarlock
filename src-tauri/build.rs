fn main() {
    configure_git_client();
    configure_sidecar();
    tauri_build::build()
}

fn configure_git_client() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    for file in ["client.m", "client.h", "signature.h", "protocol.h"] {
        println!("cargo:rerun-if-changed=git-worker/{file}");
    }
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported macOS Git client target"),
    };
    let object = out.join("git-client.o");
    let status = std::process::Command::new("xcrun")
        .args([
            "clang",
            "-fobjc-arc",
            "-fblocks",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-O2",
            "-mmacosx-version-min=13.3",
            "-arch",
            arch,
            "-c",
            "git-worker/client.m",
            "-o",
        ])
        .arg(&object)
        .status()
        .expect("compile Git XPC client");
    assert!(status.success(), "Git XPC client compilation failed");
    let status = std::process::Command::new("ar")
        .arg("crs")
        .arg(out.join("liboarlock_git_client.a"))
        .arg(object)
        .status()
        .expect("archive Git XPC client");
    assert!(status.success(), "Git XPC client archive failed");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=oarlock_git_client");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=Security");
}

fn configure_sidecar() {
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let path =
        std::path::PathBuf::from("binaries").join(format!("oarlock-cli-{target}{extension}"));
    let valid =
        std::fs::metadata(&path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0);
    if valid {
        return;
    }
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        panic!(
            "release sidecar {} is missing or empty; run bun run build:cli before packaging",
            path.display()
        );
    }

    let mut config = std::env::var("TAURI_CONFIG")
        .map(|value| serde_json::from_str(&value).expect("parse TAURI_CONFIG"))
        .unwrap_or_else(|_| serde_json::json!({}));
    config["bundle"]["externalBin"] = serde_json::json!([]);
    std::env::set_var(
        "TAURI_CONFIG",
        serde_json::to_string(&config).expect("serialize TAURI_CONFIG"),
    );
}
