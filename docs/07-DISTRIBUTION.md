# 07 — Distribution & Updates

> Scope: Windows desktop builds for DataForge. The auto-updater section is completed
> in Task 2; this file documents the build/signing baseline already shipped.

## 1. Build

Prerequisites: Node.js 18+, Rust MSVC toolchain, WebView2, and the Tauri CLI from
`package.json`.

```powershell
npm install
npm run tauri build
```

Tauri writes release artifacts under `src-tauri/target/release/`:

| Artifact | Path |
|---|---|
| MSI installer | `src-tauri/target/release/bundle/msi/DataForge_<version>_x64_en-US.msi` |
| NSIS installer | `src-tauri/target/release/bundle/nsis/DataForge_<version>_x64-setup.exe` |
| Unpacked app | `src-tauri/target/release/dataforge.exe` |

The app menu, tray icon, notifications, and updater-facing release settings are
part of the packaged desktop app; a plain `vite preview` is not a release build.

Before publishing:

1. Bump `version` in `package.json` and `src-tauri/tauri.conf.json` together.
2. Run `cargo check` and `npm run build`.
3. Run the packaged `.exe`, not only the dev build.
4. Test File → New Query, Close Tab, Quit; Edit → Copy/Paste/Select All; View
   toggles; Help → About; and tray Show/Quit.
5. Confirm F5 / Ctrl+R, Ctrl +/−/0, and Ctrl+wheel do not reload or zoom the app.
6. Confirm the custom grid/tree right-click menus still work while the browser
   context menu is blocked.

## 2. Windows code signing

An unsigned installer still runs, but Windows SmartScreen shows
“Windows protected your PC”. The user must choose **More info → Run anyway**.
Expect this until the signing certificate builds reputation.

### OV vs EV certificates

| Type | SmartScreen behavior | Notes |
|---|---|---|
| Unsigned | Warning; “Run anyway” required | Fine for internal/testing builds |
| OV (Organization Validation) | Warning may persist until reputation accumulates | Lower cost; certificate on a hardware token or cloud HSM |
| EV (Extended Validation) | Generally trusted immediately | Higher cost; hardware token/HSM required by CAs |

Do not buy or embed a certificate as part of this repository. Acquire one from a
CA only when the release process is ready, and keep the private key in a hardware
token, Azure Key Vault/Managed HSM, or another approved signing service.

### Tauri signing configuration (template only)

Tauri 2 supports certificate thumbprint signing and custom signing commands.
A typical configuration lives under `bundle.windows` in `src-tauri/tauri.conf.json`:

```jsonc
{
  "bundle": {
    "windows": {
      // Option A: certificate already installed in the Windows certificate store.
      // "certificateThumbprint": "<THUMBPRINT>",
      // "digestAlgorithm": "sha256",
      // "timestampUrl": "http://timestamp.digicert.com"

      // Option B: Azure Trusted Signing / custom signer.
      // "signCommand": "trusted-signing-cli -e <endpoint> -a <account> -c <profile> %1"
    }
  }
}
```

Keep the certificate private key and any signing-service credentials out of git.
Use CI secrets/Key Vault references in the release pipeline.

### Microsoft Defender false positives

If Defender flags a correctly built installer:

1. Sign the installer and the contained executable.
2. Submit the file at Microsoft Security Intelligence:
   <https://www.microsoft.com/en-us/wdsi/filesubmission>.
3. Include build details, publisher identity, and a short explanation of the app.
4. Re-test after Microsoft updates signatures; a fresh signed build may already
   avoid generic detections.
5. Avoid packers/obfuscators and keep version metadata consistent between builds.

## 3. Auto-updater (Task 2)

The updater plugin, signing keypair, placeholder endpoint, startup check, progress
UI, and native “update available” notification are added in Task 2. The private
updater key must never be committed; release builds read it from an environment
variable (for example `TAURI_SIGNING_PRIVATE_KEY`). The public key is embedded in
`tauri.conf.json`.
