# 02 — Layihə strukturu

Hər faylın vəzifəsi ilə tam qovluq ağacı. `src-tauri/` = Rust backend, `src/` = React frontend.

```
dataforge/
├─ package.json                 # frontend asılılıqları + skriptlər (bax 03-TECH-STACK)
├─ vite.config.ts               # Vite konfiq (Tauri üçün port 1420)
├─ tsconfig.json
├─ index.html                   # WebView giriş nöqtəsi
│
├─ src/                         # ───────── FRONTEND (React + TS) ─────────
│  ├─ main.tsx                  # React root
│  ├─ App.tsx                   # əsas layout (sidebar | editor | result | ai)
│  ├─ ipc.ts                    # invoke() örtükləri — hər komanda üçün tipli funksiya
│  ├─ types.ts                  # paylaşılan TS tipləri (04-IPC-CONTRACT-ə uyğun)
│  ├─ store.ts                  # vəziyyət (zustand): aktiv bağlantı, tablar
│  ├─ components/
│  │  ├─ Sidebar.tsx            # bağlantı/baza/cədvəl ağacı
│  │  ├─ SqlEditor.tsx          # Monaco redaktoru + auto-complete
│  │  ├─ DataGrid.tsx           # nəticə + table data grid (selection/copy)
│  │  ├─ TableDataView.tsx      # table data toolbar + grid
│  │  ├─ AiPanel.tsx            # "dildə yaz→SQL" çat paneli
│  │  ├─ ConnectionDialog.tsx   # yeni/redaktə bağlantı formu
│  │  └─ CommandPalette.tsx     # ⌘K sürətli əmr
│  ├─ clipboard.ts             # Tauri clipboard plugin + fallback
│  └─ styles/                   # tokens.css + base.css (v2)
│
├─ src-tauri/                   # ───────── BACKEND (Rust) ─────────
│  ├─ Cargo.toml                # Rust asılılıqları (bax 03-TECH-STACK)
│  ├─ tauri.conf.json           # Tauri konfiq (pəncərə, icazələr, bundle)
│  ├─ build.rs
│  └─ src/
│     ├─ main.rs                # tauri::Builder, komandaların qeydiyyatı, state
│     ├─ error.rs               # AppError (thiserror) — bütün nəticələr Result<_,AppError>
│     ├─ state.rs               # AppState: pool reyestri, config
│     │
│     ├─ commands/              # IPC komandaları (frontend buraları çağırır)
│     │  ├─ mod.rs
│     │  ├─ connection.rs       # save/list/delete/test_connection
│     │  ├─ query.rs            # run_query, cancel_query
│     │  ├─ schema.rs           # list_databases/tables/columns, get_schema
│     │  ├─ export.rs           # export_csv, export_xlsx, export_json
│     │  └─ ai.rs               # ai_nl2sql, ai_explain, ai_optimize, ai_fix_error
│     │
│     ├─ core/
│     │  ├─ mod.rs
│     │  ├─ pool.rs             # bağlantı hovuzu reyestri (conn_id → Driver)
│     │  ├─ drivers/
│     │  │  ├─ mod.rs           # trait Driver + enum Dialect
│     │  │  ├─ mysql.rs         # sqlx MySQL implementasiyası
│     │  │  ├─ postgres.rs      # sqlx Postgres
│     │  │  ├─ sqlite.rs        # sqlx SQLite
│     │  │  └─ mssql.rs         # tiberius (v1-də)
│     │  ├─ secrets.rs          # keyring: parol/açar saxlama
│     │  ├─ crypto.rs           # AES-GCM (config faylı üçün)
│     │  └─ ssh.rs              # SSH tunel (v2-də)
│     │
│     └─ ai/
│        ├─ mod.rs
│        ├─ client.rs           # reqwest → Claude /v1/messages (05-AI-INTEGRATION)
│        ├─ prompts.rs          # system prompt şablonları (dialekt-aware)
│        └─ nl2sql.rs           # sxem çıxarışı + cavab parse
│
└─ docs/                        # bu blueprint
```

## Tikinti sırası (hansı faylı əvvəl)

1. `src-tauri/src/error.rs`, `state.rs`, `main.rs` — skelet
2. `core/drivers/mod.rs` (trait) + `mysql.rs` — ilk sürücü
3. `commands/connection.rs` + `query.rs` — bağlan və sorğu işlət
4. Frontend: `ipc.ts`, `App.tsx`, `SqlEditor.tsx`, `ResultGrid.tsx`
5. `ai/*` + `commands/ai.rs` + `AiPanel.tsx` — AI
6. `export.rs`, `schema.rs` — qalan funksiyalar
