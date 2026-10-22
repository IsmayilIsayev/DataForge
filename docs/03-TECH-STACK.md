# 03 — Texnologiya yığını (dəqiq versiyalar)

> Versiyalar 2026-cı il üçün sabit/real seçilib. Dəqiq ən son patch üçün `npm`/`crates.io`-a baxın; major versiyaları saxlayın.

## Frontend — `package.json`

```jsonc
{
  "name": "dataforge",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.1.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@monaco-editor/react": "^4.6.0",
    "zustand": "^4.5.5",
    "@tanstack/react-virtual": "^3.10.8",
    "lucide-static": "0.460.0",
    "@tauri-apps/plugin-clipboard-manager": "^2.5.0",
    "@tauri-apps/plugin-notification": "^2.7.0",
    "sql-formatter": "^15.9.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.1.0",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1"
  }
}
```

**Nə üçün bunlar:**
- `@monaco-editor/react` — VS Code redaktor mühərriki (SQL highlight, auto-complete).
- `zustand` — yüngül state (Redux-dan sadə).
- `@tanstack/react-virtual` — minlərlə sətri lag olmadan göstərmək (virtual scroll).
- `lucide-static` — v2 prototipinin 1:1 Lucide icon fontu (`icon-*` klassları); runtime CDN yoxdur.
- `@tauri-apps/plugin-clipboard-manager` — WebView clipboard məhdudiyyətini aşan OS clipboard (grid copy/TSV/CSV/JSON/INSERT). Rust tərəfi: `tauri-plugin-clipboard-manager = "2"`; `capabilities/default.json`-da `allow-read-text` + `allow-write-text`.
- `@tauri-apps/plugin-notification` — uzun sorğu bitəndə və update mövcud olduqda native OS bildirişi. Rust tərəfi: `tauri-plugin-notification = "2"`; capability: `notification:default`.
- `sql-formatter` — AI SQL və toolbar Format üçün dialect-aware (MySQL / PostgreSQL / SQLite) çoxsətirli formatlaşdırma.

## Backend — `src-tauri/Cargo.toml`

```toml
[package]
name = "dataforge"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2.0", features = [] }

[dependencies]
tauri = { version = "2.1", features = ["tray-icon"] }
tauri-plugin-shell = "2.0"

# Async runtime
tokio = { version = "1.41", features = ["full"] }

# Serializasiya
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

# DB sürücüləri (MVP: mysql + postgres + sqlite)
sqlx = { version = "0.8", default-features = false, features = [
  "runtime-tokio-rustls", "mysql", "postgres", "sqlite", "chrono", "json"
] }

# AI — Claude API üçün HTTP klienti
reqwest = { version = "0.12", default-features = false, features = [
  "json", "rustls-tls", "stream"
] }

# Sirr saxlama + şifrələmə
keyring = "3.6"
aes-gcm = "0.10"
rand = "0.8"

# Xəta idarəetmə
anyhow = "1.0"
thiserror = "2.0"

# İxrac (XLSX)
rust_xlsxwriter = "0.79"

# Clipboard (grid copy)
tauri-plugin-clipboard-manager = "2"

# Native notifications
tauri-plugin-notification = "2"

# v1/v2-də:
# tiberius = "0.12"            # SQL Server
# mongodb = "3.1"             # MongoDB
# russh = "0.45"              # SSH tunel
```

**Nə üçün bunlar:**
- `tauri` `tray-icon` feature — system tray (Show / Quit). `devtools` feature-i **qəsdən yoxdur**: inspector yalnız debug build-də işləyir, release-də bağlıdır.
- `sqlx` — compile-time yoxlanan, async SQL. Bir crate-də MySQL+PG+SQLite. `rustls` = OpenSSL asılılığı yoxdur (çarpaz-platforma asan).
- `reqwest` + `rustls-tls` — Claude API-yə HTTPS; `stream` SSE axını üçün.
- `keyring` — OS keychain (Windows Credential Manager / macOS Keychain / Linux Secret Service).
- `aes-gcm` — config faylındakı həssas sahələr üçün authenticated şifrələmə.
- `rust_xlsxwriter` — saf-Rust Excel yazıcı (libxl-in pulsuz əvəzi; Navicat-da `libxl` kommersiyadır).

## Ön şərtlər (dev maşını)

| Alət | Versiya | Qeyd |
|---|---|---|
| Node.js | 18+ | frontend |
| Rust | 1.77+ | `rustup` |
| WebView2 | — | Windows 11-də onsuz da var |
| Visual Studio Build Tools | — | Rust MSVC toolchain üçün (Windows) |

## Native desktop hardening

- Native menu bar: `File / Edit / View / Help` (Tauri 2 `MenuBuilder`), events frontend-ə `menu:*` event-ləri ilə ötürülür.
- WebView reload (F5 / Ctrl+R), zoom (Ctrl +/−/0, Ctrl+wheel) və default browser context menu bloklanır; öz grid/tree context menu-ları işləyir.
- Chrome-da text selection söndürülüb; Monaco, input/textarea və grid xanalarında saxlanılır.
- Release build-də devtools yoxdur (`devtools` Cargo feature-i çıxarılıb).
- System tray: Show / Quit. Uzun sorğu bitəndə native notification.

## Model seçimi (AI)

Default: **`claude-opus-5-5`** (ən yaxşı keyfiyyət). Yüksək həcm / ucuz üçün alternativ: `claude-sonnet-5-5` və ya `claude-haiku-5-5` (bax `05-AI-INTEGRATION.md`).
