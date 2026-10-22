# 01 — Memarlıq

## Ümumi baxış

DataForge iki prosesli Tauri tətbiqidir: **frontend** (WebView — React/TS) və **backend** (Rust — native). Aralarında Tauri IPC (JSON komandalar) var. Bütün ağır/həssas işlər (DB bağlantıları, AI açarı, şifrələmə) backend-dədir.

```
┌──────────────────────── Frontend (WebView: React + TS) ───────────────────────┐
│                                                                                │
│  Sidebar (bağlantılar)   SQL redaktoru (Monaco)   Nəticə grid-i   AI panel     │
│         │                        │                      │              │        │
│         └────────────────────────┴──────────────────────┴──────────────┘        │
│                              invoke("<command>", args)                          │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                     │  Tauri IPC (serde JSON)
┌────────────────────────────────────▼────────────────────────────────────────────┐
│                           Backend (Rust — src-tauri)                             │
│                                                                                   │
│  commands/           core/                         ai/                            │
│  ├─ connection.rs    ├─ pool.rs (bağlantı hovuzu)  ├─ client.rs (reqwest→Claude)  │
│  ├─ query.rs         ├─ drivers/ (mysql,pg,sqlite) ├─ prompts.rs (şablonlar)      │
│  ├─ schema.rs        ├─ secrets.rs (keychain)      └─ nl2sql.rs (axın)            │
│  ├─ export.rs        ├─ crypto.rs (AES-GCM)                                       │
│  └─ ai.rs            └─ ssh.rs (tunel)                                            │
│                                                                                   │
└───────┬───────────────────────────────┬───────────────────────────┬──────────────┘
        │                               │                           │
   ┌────▼────┐                    ┌─────▼─────┐               ┌──────▼──────┐
   │  DB-lər │                    │ OS Keychain│               │ Claude API  │
   │ MySQL…  │                    │ (açarlar)  │               │ /v1/messages│
   └─────────┘                    └───────────┘               └─────────────┘
```

## Əsas prinsiplər

1. **Açar/sirr heç vaxt frontend-ə çıxmır.** Bağlantı parolları və Claude API açarı OS keychain-də (Windows Credential Manager) saxlanılır; frontend yalnız bağlantı adı/id görür.
2. **Hər DB sürücüsü bir trait arxasında.** `trait Driver { connect, query, schema, ... }` — yeni DB əlavə etmək = yeni modul.
3. **AI köməkçidir, idarəçi deyil.** AI SQL *təklif edir*; icra həmişə istifadəçinin təsdiqi ilə. AI heç vaxt avtomatik `DELETE/DROP/UPDATE` işlətmir.
4. **Oxu/yazma ayrımı.** Təhlükəli sorğular (DDL/DML) UI-də vizual xəbərdarlıqla işarələnir.

## Əsas axınlar

### A) Sorğu icrası
```
İstifadəçi SQL yazır → invoke("run_query",{conn_id,sql})
   → backend: pool-dan bağlantı → driver.query(sql)
   → nəticə (sütunlar + sətirlər + metrik) → frontend grid
```

### B) NL→SQL (AI)
```
İstifadəçi: "keçən ay ən çox satılan 10 məhsul"
   → invoke("ai_nl2sql",{conn_id, question})
   → backend: schema.rs cari bazanın sxemini çıxarır (cədvəl+sütun adları)
   → ai/prompts.rs: system promptu qurur (dialekt + sxem + qaydalar)
   → ai/client.rs: Claude /v1/messages (reqwest)
   → cavab {sql, explanation, warnings} → frontend
   → istifadəçi SQL-i görür, bəyənsə [Run] basır (avtomatik icra YOX)
```

### C) Bağlantı yaratma
```
Form (host,port,user,pass,db) → invoke("save_connection",...)
   → crypto.rs parolu şifrələyir / keychain-ə yazır
   → metadata (ad,host,db,tip) local config DB-də (SQLite)
```

## Təhlükəsizlik sərhədləri

- **SQL injection:** AI-nin verdiyi SQL birbaşa icra olunmur — istifadəçi görür və təsdiqləyir. Parametrli sorğular driver səviyyəsində.
- **Dağıdıcı əməllər:** `DROP/TRUNCATE/DELETE` üçün UI təsdiq dialoqu + "neçə sətir təsirlənəcək" göstərişi.
- **AI privacy:** Sxem Claude-a getməzdən əvvəl istifadəçi razılığı; data (sətirlər) default göndərilmir.
