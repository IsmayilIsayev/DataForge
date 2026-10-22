# 06 — Yol xəritəsi

## MVP (Mərhələ 1) — işləyən nüvə
Məqsəd: MySQL-ə bağlan, SQL işlət, nəticəni gör, AI ilə SQL yarat.

- [x] Tauri skeleti (`main.rs`, `error.rs`, `state.rs`)
- [x] `trait Driver` + **MySQL** sürücüsü (`sqlx`)
- [x] `save/list/test_connection` + keychain parol saxlama
- [x] `run_query` → nəticə grid (virtual scroll)
- [x] Monaco SQL redaktoru
- [x] **AI: `ai_nl2sql`** (dildə yaz → SQL) + AI provayder konfiqurasiyası (keychain)
- [ ] CSV ixrac

**Bitmə meyarı:** öz MySQL (clopos) bazana bağlan, "son 10 sifariş" yaz → AI SQL versin → [Run] → nəticə görünsün.

## v1 (Mərhələ 2) — gündəlik istifadəyə hazır
- [x] **PostgreSQL** + **SQLite** sürücüləri
- [x] Sxem ağacı (baza → cədvəl → sütun) sidebar-da
- [ ] Cədvəl strukturu redaktoru (sütun əlavə/dəyiş)
- [ ] `ai_explain` + `ai_optimize` + `ai_fix_error`
- [ ] XLSX + JSON ixrac
- [x] Dark/light tema, Command palette (⌘K)
- [x] Çoxlu tab (bir neçə sorğu eyni vaxtda)
- [ ] Prompt caching (sxem keşi)
- [x] Relevant schema context + `schema_token_budget` (default 3000; 113 cədvəl üçün ~3k token)
- [x] NL2SQL JSON mode + fenced/standalone SQL fallback + raw-response diagnostics
- [x] Dialect-aware SQL formatter (`sql-formatter`) for toolbar Format + AI output

## UI v2 — təhvil verilmiş prototip (checkpoint-lər)
- [x] **A** — tokens, Lucide icon font, top bar, sidebar
- [x] **B** — tab strip, SQL editor, result grid, table data view
- [x] **C** — connection dialog, AI panel, command palette, footer/states

## Desktop hardening (native app)
- [x] Native menu bar: File / Edit / View / Help
- [x] Reload, zoom, browser context menu bloklandı; chrome text selection söndürüldü
- [x] Release build-də devtools bağlıdır
- [x] Native notifications (uzun sorğu bitəndə)
- [x] System tray (Show / Quit)
- [ ] Auto-updater + distribution (TASK 2)

## v2 (Mərhələ 3) — Navicat paritetinə yaxın
- [ ] **SQL Server** (`tiberius`) + **MongoDB** (`mongodb`)
- [ ] **SSH tunel** (`russh`)
- [ ] **ER diaqram** (web canvas — react-flow)
- [ ] **Data transfer / sync** (bazalar arası köçürmə)
- [ ] **Chart / dashboard** (recharts)
- [ ] Backup + planlayıcı (cron)
- [ ] Plugin API

## ⭐ Prioritet plan — tam Navicat paritetı (istifadəçi seçimi)

İstifadəçi **dörd istiqamətin hamısını** istəyir. MVP bitəndən sonra bu sıra ilə (asılılıqlara görə optimal):

**P1 — Çoxlu DB** (əvvəl, çünki bütün sonrakı funksiyalar dialekt-aware olmalıdır)
- [x] PostgreSQL driver (`sqlx` — mövcud trait-ə yeni impl)
- [x] SQLite driver (`sqlx`, serversiz — test üçün ən asan)
- [ ] SQL Server driver (`tiberius`)
- [ ] MongoDB driver (`mongodb` — NoSQL, ayrı nəticə forması)
- [x] `ConnectionDialog`-da dialekt seçimi + hər dialektə uyğun sahələr

**P2 — İxrac + Data transfer**
- [ ] XLSX (`rust_xlsxwriter`) + JSON ixrac (`export_result`)
- [ ] Data transfer: bir bağlantıdan digərinə cədvəl/data köçürmə
- [ ] Struktur müqayisə (iki baza/cədvəl fərqi → ALTER generasiya)

**P3 — Cədvəl / sxem redaktoru**
- [ ] Cədvəl strukturu UI: sütun əlavə/dəyiş/sil, tip, nullable, default
- [ ] İndeks + foreign key redaktoru
- [ ] Dialekt-aware `CREATE TABLE` / `ALTER TABLE` generasiyası (SQL preview + icra)

**P4 — ER diaqram / model**
- [ ] `get_schema` + foreign key introspeksiyası (hər dialektdə)
- [ ] Web canvas (`react-flow`): cədvəllər qutu, FK-lar xətt
- [ ] Avtomatik düzülüş + zoom/pan + PNG ixrac

**Sıra səbəbi:** çoxlu DB əvvəl olmalıdır ki, redaktor/ER/transfer modulları bir dialektə bağlı qalmasın. İxrac sürətli qələbədir. Redaktor və ER introspeksiya tələb edir (onu çoxlu DB verir).

## ⭐⭐ İstifadəçinin əlavə istədikləri (növbəti batch-lar)

**Grid interaksiyaları**
- [x] Sütunların yerini dəyişmək (başlığı dartıb reorder)
- [x] Xana/sətir diapazonu seçib kopyalamaq (TSV/CSV; sətri kopyala)
- [x] Seçilmiş SQL-i işlətmək (redaktorda var) + seçilmiş data ilə əməl

**4 əsas funksiya**
- [ ] İxrac: CSV / JSON / XLSX + "copy as INSERT/CSV"
- [ ] Grid-də inline data redaktə (xana dəyiş, sətir əlavə/sil → UPDATE/INSERT/DELETE, təsdiqlə commit)
- [ ] Sxem-əsaslı auto-complete (Monaco-da cədvəl/sütun adları)
- [ ] Sorğu tarixçəsi + grid-də SQL-siz filtr/sort

**AI provayderləri**
- [x] `openai_compatible` preset-ləri: **OpenRouter** (base_url `https://openrouter.ai/api/v1`), **opencode** (local server base_url), + custom
- [x] Provayder seçimində hazır preset dropdown-u

## Gələcək fikirlər
- Komanda əməkdaşlığı (bulud sinxron) — ödənişli tier
- AI "schema design": təbii dildən cədvəl strukturu yarat
- AI "data insights": nəticəni avtomatik təhlil + qrafik təklif
- Query tarixçəsi + AI ilə axtarış

## Tikinti sırası (praktik)
1. Backend skelet → MySQL driver → run_query (frontend-siz, test ilə yoxla)
2. Minimal frontend (editor + grid) → bağlan və işlət
3. AI panel → nl2sql
4. Qalan sürücülər və funksiyalar

## Lisenziya tövsiyəsi
Nüvəni **MIT** və ya **Apache-2.0** ilə aç (geniş qəbul). Bulud/komanda funksiyalarını ayrıca ticari tier kimi saxla (open-core model).
