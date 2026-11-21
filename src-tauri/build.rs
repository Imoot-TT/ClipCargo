fn main() {
    let manifest_dir = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is unavailable"),
    );
    let target = std::env::var("TARGET").expect("TARGET is unavailable");
    let sidecar = manifest_dir
        .join("binaries")
        .join(format!("clipcargo-native-host-{target}.exe"));

    // The native host is built by the before-dev/build hook from this same Cargo
    // package. On a clean checkout, validating externalBin before that bootstrap
    // build would create a circular dependency. Skip only the missing sidecar for
    // this bootstrap invocation; the hook copies the real executable afterward.
    if !sidecar.is_file() {
        std::env::set_var("TAURI_CONFIG", r#"{"bundle":{"externalBin":[]}}"#);
        println!("cargo:warning=Bootstrapping without the not-yet-built native host sidecar");
    }

    // Tauri CLI 2.11 still exports the deprecated compatibility variable while
    // tauri-build 2.7 warns whenever it is present. Use the typed build API as
    // the single source of truth until the CLI schema exposes build.windows.
    std::env::remove_var("STATIC_VCRUNTIME");
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new().static_vc_runtime(true));
    tauri_build::try_build(attributes).expect("failed to run tauri-build")
}
