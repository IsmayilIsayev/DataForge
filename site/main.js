(function () {
  "use strict";

  var REPO = "IsmayilIsayev/DataForge";
  var RELEASES_URL = "https://github.com/" + REPO + "/releases";
  var RELEASE_API = "https://api.github.com/repos/" + REPO + "/releases/latest";
  var CHANGELOG_URL =
    "https://raw.githubusercontent.com/" + REPO + "/main/CHANGELOG.md";
  var STORAGE_KEY = "dataforge-site-lang";
  var OS_ASSETS = {
    windows: [".exe", ".msi"],
    macos: [".dmg"],
    linux: [".deb", ".AppImage", ".rpm"],
  };

  var messages = {
    en: {
      skip: "Skip to content",
      "nav.label": "Main",
      "nav.features": "Features",
      "nav.screenshots": "Screenshots",
      "nav.compare": "Compare",
      "nav.whatsnew": "What's new",
      "nav.faq": "FAQ",
      "nav.download": "Download",
      "lang.switch": "Switch language",

      "hero.badge": "Free & open source (MIT)",
      "hero.titleBody": "a fast, AI-native database client",
      "hero.subline":
        "6 MB. Opens instantly. MySQL, PostgreSQL, SQLite, SQL Server.",
      "hero.cta": "Download for {os}",
      "hero.other": "Other platforms",
      "hero.github": "View on GitHub",
      "hero.platforms": "Windows · macOS · Linux",

      "download.eyebrow": "Download",
      "download.title": "Get DataForge for your desktop",
      "download.desc":
        "One small installer. No Node, Rust, or runtime required.",
      "download.latest": "Latest release",
      "download.checking": "Checking the latest release…",
      "download.meta": "{version} · {size}",
      "download.cta": "Download for {os}",
      "download.releases": "All releases on GitHub",
      "download.releasesShort": "Releases",
      "download.failed":
        "Could not load release data. Download from the Releases page instead.",
      "download.noAsset":
        "No {os} installer found in the latest release.",
      "download.unsignedTitle": "Unsigned builds",
      "download.unsignedBody":
        "These builds are not code-signed yet. On Windows, if SmartScreen appears, choose “More info → Run anyway”. On macOS, right-click the app → Open the first time.",

      "features.eyebrow": "Features",
      "features.title": "Everything you need to work with data",
      "features.lead":
        "Small app, serious toolset. Built for speed and everyday database work.",
      "feature.ai.title": "AI → SQL in your language",
      "feature.ai.desc":
        "Describe what you need in plain English or Azerbaijani and get a ready-to-run query.",
      "feature.fix.title": "Fix with AI, Explain, Optimize",
      "feature.fix.desc":
        "Turn errors into working SQL, understand complex queries, and optimize with the real EXPLAIN plan.",
      "feature.autocomplete.title": "Smart autocomplete + 30 templates",
      "feature.autocomplete.desc":
        "Keywords, tables, columns, aliases, and shortcuts for the queries you write every day.",
      "feature.filter.title": "Filter & sort without SQL",
      "feature.filter.desc":
        "Click column headers to filter (=, contains, NULL, in list…) and sort, then keep working.",
      "feature.batch.title": "Batch edits in one transaction",
      "feature.batch.desc":
        "Queue cell edits and row changes, then Save (Ctrl/Cmd+S) or Discard — all in one transaction.",
      "feature.prod.title": "Protected production connections",
      "feature.prod.desc":
        "Dev/test/prod labels, typed confirmation before writes, and optional read-only mode.",
      "feature.ssh.title": "SSH tunnel",
      "feature.ssh.desc":
        "Connect to MySQL and PostgreSQL through an SSH tunnel with a password or private key.",
      "feature.export.title": "Export & import, four formats",
      "feature.export.desc":
        "CSV, JSON, SQL, and Excel — with streaming, progress, and cancel for large tables.",

      "screenshots.eyebrow": "Screenshots",
      "screenshots.title": "Take a look inside",
      "screenshots.lead":
        "The editor, data grid, AI actions, and connection manager.",
      "screenshot.editor.alt":
        "DataForge SQL editor with query tabs and autocomplete",
      "screenshot.editor.caption":
        "SQL editor with tabs, autocomplete, and query history.",
      "screenshot.grid.alt":
        "DataForge data grid with filtered and sorted rows",
      "screenshot.grid.caption":
        "Fast grid: filter, sort, edit, and copy rows.",
      "screenshot.ai.alt":
        "DataForge AI panel generating SQL from a natural-language prompt",
      "screenshot.ai.caption":
        "AI actions: generate, fix, explain, and optimize.",
      "screenshot.connection.alt":
        "DataForge connection manager with presets and environment labels",
      "screenshot.connection.caption":
        "Connection presets, colors, and protected environments.",

      "compare.eyebrow": "Comparison",
      "compare.title": "How it compares",
      "compare.lead":
        "A lightweight alternative to the big database IDEs. Figures are approximate.",
      "compare.feature": "Feature",
      "compare.size": "Installer size",
      "compare.size.df": "~6 MB",
      "compare.size.dbeaver": "~100+ MB (Java)",
      "compare.size.navicat": "Large",
      "compare.startup": "Startup",
      "compare.startup.df": "Instant",
      "compare.startup.dbeaver": "Slower (Java)",
      "compare.startup.navicat": "Fast",
      "compare.price": "Price",
      "compare.price.df": "Free (MIT)",
      "compare.price.dbeaver": "Free Community; paid editions",
      "compare.price.navicat": "Paid",
      "compare.ai": "AI built in",
      "compare.ai.df": "Yes (bring your own key)",
      "compare.ai.dbeaver": "No (via extensions)",
      "compare.ai.navicat": "Varies by version",
      "compare.native": "Native look",
      "compare.native.df": "Yes (Tauri)",
      "compare.native.dbeaver": "No (Java/SWT)",
      "compare.native.navicat": "Yes (native UI)",
      "compare.note":
        "DBeaver and Navicat are trademarks of their respective owners. Details reflect their public editions and may change.",

      "whatsnew.eyebrow": "What's new",
      "whatsnew.title": "Latest changes",
      "whatsnew.desc": "Pulled from the project changelog on GitHub.",
      "whatsnew.loading": "Loading the latest changes…",
      "whatsnew.error":
        "Could not load the changelog right now. Open it on GitHub instead.",
      "whatsnew.full": "Read the full changelog",

      "faq.eyebrow": "FAQ",
      "faq.title": "Common questions",
      "faq.q1": "Is DataForge free?",
      "faq.a1":
        "Yes. It is open source under the MIT license — free to use, modify, and distribute.",
      "faq.q2": "Where are my passwords stored?",
      "faq.a2":
        "Database passwords and AI API keys are stored in your operating system's keychain, not in plain text in the app. Connection files do not contain passwords.",
      "faq.q3": "Which AI providers are supported?",
      "faq.a3":
        "OpenAI, OpenRouter, Google Gemini, Groq, and local models through Ollama or LM Studio. You bring your own key.",
      "faq.q4": "Does my data go to the AI?",
      "faq.a4":
        "Only the schema and SQL you send with a request. Requests go directly from your machine to the provider you configure; DataForge does not run a proxy server.",

      "footer.label": "Footer",
      "footer.license": "MIT license",
      "footer.github": "GitHub",
      "footer.issues": "Issues",
      "footer.copyright":
        "© {year} DataForge contributors. Free and open source.",

      "os.desktop": "desktop",
    },

    az: {
      skip: "Məzmuna keç",
      "nav.label": "Əsas",
      "nav.features": "Xüsusiyyətlər",
      "nav.screenshots": "Ekran görüntüləri",
      "nav.compare": "Müqayisə",
      "nav.whatsnew": "Yeniliklər",
      "nav.faq": "Suallar",
      "nav.download": "Yüklə",
      "lang.switch": "Dili dəyiş",

      "hero.badge": "Pulsuz və açıq mənbə (MIT)",
      "hero.titleBody":
        "sürətli, AI-yə əsaslanan verilənlər bazası müştərisi",
      "hero.subline":
        "6 MB. Dərhal açılır. MySQL, PostgreSQL, SQLite, SQL Server.",
      "hero.cta": "{os} üçün yüklə",
      "hero.other": "Digər platformalar",
      "hero.github": "GitHub-da bax",
      "hero.platforms": "Windows · macOS · Linux",

      "download.eyebrow": "Yüklə",
      "download.title": "DataForge-u kompüteriniz üçün əldə edin",
      "download.desc":
        "Kiçik bir quraşdırıcı. Node, Rust və ya əlavə mühit tələb etmir.",
      "download.latest": "Son buraxılış",
      "download.checking": "Son buraxılış yoxlanılır…",
      "download.meta": "{version} · {size}",
      "download.cta": "{os} üçün yüklə",
      "download.releases": "GitHub-da bütün buraxılışlar",
      "download.releasesShort": "Buraxılışlar",
      "download.failed":
        "Buraxılış məlumatlarını yükləmək alınmadı. Əvəzində Releases səhifəsindən yükləyin.",
      "download.noAsset":
        "Son buraxılışda {os} üçün quraşdırıcı tapılmadı.",
      "download.unsignedTitle": "İmzalanmamış buraxılışlar",
      "download.unsignedBody":
        "Bu buraxılışlar hələ kod imzası ilə təsdiqlənməyib. Windows-da SmartScreen görünərsə, “More info → Run anyway” seçin. macOS-da ilk dəfə tətbiqə sağ klikləyib “Open” seçin.",

      "features.eyebrow": "Xüsusiyyətlər",
      "features.title": "Verilənlərlə işləmək üçün lazım olan hər şey",
      "features.lead":
        "Kiçik tətbiq, ciddi alət dəsti. Sürət və gündəlik verilənlər bazası işi üçün qurulub.",
      "feature.ai.title": "AI → SQL sizin dilinizdə",
      "feature.ai.desc":
        "Ehtiyacınızı sadə ingilis və ya Azərbaycan dilində yazın və işə hazır sorğu alın.",
      "feature.fix.title": "AI ilə düzəlt, izah et, optimallaşdır",
      "feature.fix.desc":
        "Xətaları işlək SQL-ə çevirin, mürəkkəb sorğuları anlayın və real EXPLAIN planı ilə optimallaşdırın.",
      "feature.autocomplete.title":
        "Ağıllı avtomatik tamamlama + 30 şablon",
      "feature.autocomplete.desc":
        "Açar sözlər, cədvəllər, sütunlar, alias-lar və hər gün yazdığınız sorğular üçün qısayollar.",
      "feature.filter.title": "SQL yazmadan filtr və sıralama",
      "feature.filter.desc":
        "Sütun başlıqlarına klikləyin: filtr (=, tərkibində, NULL, siyahıda…) və sıralama — sonra işə davam edin.",
      "feature.batch.title": "Toplu dəyişikliklər bir tranzaksiyada",
      "feature.batch.desc":
        "Hüceyrə və sətir dəyişikliklərini növbəyə qoyun, sonra Save (Ctrl/Cmd+S) və ya Discard — hamısı bir tranzaksiyada.",
      "feature.prod.title": "Qorunan production bağlantıları",
      "feature.prod.desc":
        "Dev/test/prod etiketləri, yazma əməliyyatlarından əvvəl yazılı təsdiq və istəyə bağlı yalnız-oxuma rejimi.",
      "feature.ssh.title": "SSH tuneli",
      "feature.ssh.desc":
        "MySQL və PostgreSQL-ə SSH tuneli ilə parol və ya şəxsi açar vasitəsilə qoşulun.",
      "feature.export.title": "İxrac və idxal, dörd format",
      "feature.export.desc":
        "CSV, JSON, SQL və Excel — böyük cədvəllər üçün axın, gedişat və ləğv ilə.",

      "screenshots.eyebrow": "Ekran görüntüləri",
      "screenshots.title": "İçəriyə nəzər salın",
      "screenshots.lead":
        "Redaktor, data grid, AI əməliyyatları və bağlantı meneceri.",
      "screenshot.editor.alt":
        "Sorğu tabları və avtomatik tamamlama ilə DataForge SQL redaktoru",
      "screenshot.editor.caption":
        "Tablar, avtomatik tamamlama və sorğu tarixçəsi olan SQL redaktoru.",
      "screenshot.grid.alt":
        "Filtrlənmiş və sıralanmış sətirlərlə DataForge data grid-i",
      "screenshot.grid.caption":
        "Sürətli grid: filtr, sıralama, redaktə və sətirləri kopyalama.",
      "screenshot.ai.alt":
        "Təbii dildə yazılmış sorğudan SQL yaradan DataForge AI paneli",
      "screenshot.ai.caption":
        "AI əməliyyatları: yarat, düzəlt, izah et və optimallaşdır.",
      "screenshot.connection.alt":
        "Presetlər və mühit etiketləri ilə DataForge bağlantı meneceri",
      "screenshot.connection.caption":
        "Bağlantı presetləri, rənglər və qorunan mühitlər.",

      "compare.eyebrow": "Müqayisə",
      "compare.title": "Necə müqayisə olunur",
      "compare.lead":
        "Böyük verilənlər bazası IDE-lərinə yüngül alternativ. Rəqəmlər təxminidir.",
      "compare.feature": "Xüsusiyyət",
      "compare.size": "Quraşdırıcının ölçüsü",
      "compare.size.df": "~6 MB",
      "compare.size.dbeaver": "~100+ MB (Java)",
      "compare.size.navicat": "Böyük",
      "compare.startup": "Başlama vaxtı",
      "compare.startup.df": "Dərhal",
      "compare.startup.dbeaver": "Daha yavaş (Java)",
      "compare.startup.navicat": "Sürətli",
      "compare.price": "Qiymət",
      "compare.price.df": "Pulsuz (MIT)",
      "compare.price.dbeaver": "Pulsuz Community; ödənişli versiyalar",
      "compare.price.navicat": "Ödənişli",
      "compare.ai": "Daxili AI",
      "compare.ai.df": "Bəli (öz açarınızla)",
      "compare.ai.dbeaver": "Xeyr (əlavələrlə)",
      "compare.ai.navicat": "Versiyadan asılıdır",
      "compare.native": "Doğma görünüş",
      "compare.native.df": "Bəli (Tauri)",
      "compare.native.dbeaver": "Xeyr (Java/SWT)",
      "compare.native.navicat": "Bəli (doğma UI)",
      "compare.note":
        "DBeaver və Navicat müvafiq sahiblərinin ticarət nişanlarıdır. Məlumatlar onların açıq versiyalarına əsaslanır və dəyişə bilər.",

      "whatsnew.eyebrow": "Yeniliklər",
      "whatsnew.title": "Son dəyişikliklər",
      "whatsnew.desc":
        "Layihənin GitHub-dakı dəyişikliklər faylından götürülür.",
      "whatsnew.loading": "Son dəyişikliklər yüklənir…",
      "whatsnew.error":
        "Dəyişiklik tarixçəsini hazırda yükləmək alınmadı. Əvəzində GitHub-da açın.",
      "whatsnew.full": "Tam dəyişiklik tarixçəsini oxuyun",

      "faq.eyebrow": "Suallar",
      "faq.title": "Ümumi suallar",
      "faq.q1": "DataForge pulsuzdur?",
      "faq.a1":
        "Bəli. MIT lisenziyası ilə açıq mənbədir — istifadə, dəyişdirmə və paylama pulsuzdur.",
      "faq.q2": "Parollarım harada saxlanılır?",
      "faq.a2":
        "Verilənlər bazası parolları və AI API açarları əməliyyat sisteminizin keychain-ində saxlanılır, tətbiqdə açıq mətn kimi deyil. Bağlantı fayllarında parol olmur.",
      "faq.q3": "Hansı AI provayderləri dəstəklənir?",
      "faq.a3":
        "OpenAI, OpenRouter, Google Gemini, Groq və Ollama və ya LM Studio vasitəsilə lokal modellər. Açarı özünüz gətirirsiniz.",
      "faq.q4": "Məlumatlarım AI-ya göndərilir?",
      "faq.a4":
        "Yalnız sorğu ilə göndərdiyiniz sxem və SQL. Sorğular birbaşa sizin kompüterinizdən konfiqurasiya etdiyiniz provayderə gedir; DataForge heç bir proxy serverindən istifadə etmir.",

      "footer.label": "Alt hissə",
      "footer.license": "MIT lisenziyası",
      "footer.github": "GitHub",
      "footer.issues": "Problemlər",
      "footer.copyright":
        "© {year} DataForge iştirakçıları. Pulsuz və açıq mənbə.",

      "os.desktop": "masaüstü",
    },
  };

  var detectedOS = detectOS();
  var lang = initialLanguage();
  var release = null;
  var releaseFailed = false;
  var changelogStatus = "loading";
  var changelogVersions = [];

  var heroDownload = document.getElementById("hero-download");
  var downloadPrimary = document.getElementById("download-primary");
  var versionEl = document.getElementById("release-version");
  var metaEl = document.getElementById("release-meta");
  var changelogEl = document.getElementById("changelog");
  var langToggle = document.getElementById("lang-toggle");

  function t(key, vars) {
    var table = messages[lang] || messages.en;
    var value = table[key];
    if (typeof value !== "string") value = messages.en[key];
    if (typeof value !== "string") return key;
    var context = vars || {};
    return value.replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(context, name)
        ? String(context[name])
        : match;
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[char];
    });
  }

  function detectOS() {
    var ua = navigator.userAgent || "";
    var platform =
      (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform ||
      "";

    if (/Android|iPhone|iPad|iPod|CrOS/i.test(ua)) return "other";
    if (/Windows|Win32|Win64/i.test(platform) || /Windows/i.test(ua)) {
      return "windows";
    }
    if (/macOS|MacIntel|Macintosh/i.test(platform) || /Mac OS X/i.test(ua)) {
      return "macos";
    }
    if (/Linux|X11/i.test(platform) || /Linux|X11/i.test(ua)) return "linux";
    return "other";
  }

  function initialLanguage() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "az" || saved === "en") return saved;
    } catch (error) {
      /* storage can be unavailable */
    }
    var language =
      navigator.language ||
      (navigator.languages && navigator.languages[0]) ||
      "en";
    return language.toLowerCase().indexOf("az") === 0 ? "az" : "en";
  }

  function osName() {
    if (detectedOS === "windows") return "Windows";
    if (detectedOS === "macos") return "macOS";
    if (detectedOS === "linux") return "Linux";
    return t("os.desktop");
  }

  function applyI18n() {
    var context = {
      year: String(new Date().getFullYear()),
      os: osName(),
    };

    document.documentElement.lang = lang;

    document.querySelectorAll("[data-i18n]").forEach(function (element) {
      element.textContent = t(element.getAttribute("data-i18n"), context);
    });

    document.querySelectorAll("[data-i18n-alt]").forEach(function (element) {
      element.setAttribute("alt", t(element.getAttribute("data-i18n-alt")));
    });

    document.querySelectorAll("[data-i18n-aria]").forEach(function (element) {
      element.setAttribute(
        "aria-label",
        t(element.getAttribute("data-i18n-aria"))
      );
    });
  }

  function setLanguage(next, persist) {
    lang = next === "az" ? "az" : "en";
    applyI18n();
    renderRelease();
    renderChangelog();

    if (langToggle) {
      langToggle.textContent = lang === "az" ? "EN" : "AZ";
      langToggle.setAttribute("aria-label", t("lang.switch"));
      langToggle.title = t("lang.switch");
    }

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, lang);
      } catch (error) {
        /* storage can be unavailable */
      }
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    var megabytes = bytes / (1024 * 1024);
    var formatter = new Intl.NumberFormat(lang === "az" ? "az" : "en", {
      maximumFractionDigits: megabytes < 10 ? 1 : 0,
    });
    return formatter.format(megabytes) + " MB";
  }

  function assetExt(name) {
    var lower = String(name).toLowerCase();
    if (lower.slice(-9) === ".appimage") return ".AppImage";
    if (lower.slice(-4) === ".exe") return ".exe";
    if (lower.slice(-4) === ".msi") return ".msi";
    if (lower.slice(-4) === ".dmg") return ".dmg";
    if (lower.slice(-4) === ".deb") return ".deb";
    if (lower.slice(-4) === ".rpm") return ".rpm";
    return "";
  }

  function assetsFor(osKey) {
    if (!release || !Array.isArray(release.assets)) return [];
    var wanted = OS_ASSETS[osKey] || [];
    return wanted
      .map(function (ext) {
        return release.assets.find(function (asset) {
          return (
            assetExt(asset.name).toLowerCase() === ext.toLowerCase() &&
            asset.browser_download_url
          );
        });
      })
      .filter(Boolean);
  }

  function pickAsset() {
    var assets = assetsFor(detectedOS);
    return assets.length ? assets[0] : null;
  }

  function renderPlatforms() {
    var list = document.getElementById("platform-list");
    if (!list) return;

    list.querySelectorAll("li[data-os]").forEach(function (item) {
      var holder = item.querySelector(".platform-assets");
      if (!holder) return;

      var assets = release ? assetsFor(item.getAttribute("data-os")) : [];

      if (!assets.length) {
        holder.innerHTML =
          '<a href="' +
          escapeHtml(RELEASES_URL) +
          '" target="_blank" rel="noopener noreferrer">' +
          escapeHtml(t("download.releasesShort")) +
          "</a>";
        return;
      }

      holder.innerHTML = assets
        .map(function (asset) {
          var size = formatBytes(asset.size);
          var sizeHtml = size
            ? ' · <span class="asset-size">' + escapeHtml(size) + "</span>"
            : "";
          return (
            '<a href="' +
            escapeHtml(asset.browser_download_url) +
            '" target="_blank" rel="noopener noreferrer">' +
            escapeHtml(assetExt(asset.name)) +
            sizeHtml +
            "</a>"
          );
        })
        .join("");
    });
  }

  function renderRelease() {
    var asset = release ? pickAsset() : null;

    if (versionEl && metaEl) {
      if (release) {
        var version = release.tag_name || release.name || "latest";
        versionEl.textContent = version;
        if (asset && asset.size) {
          metaEl.textContent = t("download.meta", {
            version: version,
            size: formatBytes(asset.size),
          });
        } else if (asset) {
          metaEl.textContent = version;
        } else {
          metaEl.textContent = t("download.noAsset", { os: osName() });
        }
      } else if (releaseFailed) {
        versionEl.textContent = "DataForge";
        metaEl.textContent = t("download.failed");
      } else {
        versionEl.textContent = "DataForge";
        metaEl.textContent = t("download.checking");
      }
    }

    var href = asset ? asset.browser_download_url : RELEASES_URL;
    if (heroDownload) heroDownload.href = href;
    if (downloadPrimary) downloadPrimary.href = href;

    renderPlatforms();
  }

  async function loadRelease() {
    try {
      var response = await fetch(RELEASE_API, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var data = await response.json();
      if (!data || !Array.isArray(data.assets)) {
        throw new Error("Unexpected release data");
      }
      release = data;
    } catch (error) {
      releaseFailed = true;
    }
    renderRelease();
  }

  function parseChangelog(markdown) {
    var versions = [];
    var current = null;
    var group = null;

    markdown.split(/\r?\n/).forEach(function (rawLine) {
      var line = rawLine.trim();
      var header = line.match(/^##\s+\[([^\]]+)\](?:\s*-\s*(.+))?$/);

      if (header) {
        if (current) versions.push(current);
        current = {
          version: header[1].trim(),
          date: (header[2] || "").trim(),
          groups: [],
        };
        group = null;
        return;
      }

      if (!current) return;

      var groupHeader = line.match(/^###\s+(.+)$/);
      if (groupHeader) {
        group = { title: groupHeader[1].trim(), items: [] };
        current.groups.push(group);
        return;
      }

      if (line.slice(0, 2) === "- ") {
        if (!group) {
          group = { title: "", items: [] };
          current.groups.push(group);
        }
        group.items.push(line.slice(2).trim());
        return;
      }

      if (line && group && group.items.length) {
        group.items[group.items.length - 1] += " " + line;
      }
    });

    if (current) versions.push(current);

    return versions
      .filter(function (version) {
        return (
          version.version.toLowerCase() !== "unreleased" &&
          version.groups.some(function (group) {
            return group.items.length > 0;
          })
        );
      })
      .slice(0, 2);
  }

  function inlineMarkdown(text) {
    var output = escapeHtml(text);
    output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
    output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return output;
  }

  function renderReleaseNotes(versions) {
    return versions
      .map(function (version) {
        var number = version.version.replace(/^v/i, "");
        var date = version.date
          ? '<time datetime="' +
            escapeHtml(version.date) +
            '">' +
            escapeHtml(version.date) +
            "</time>"
          : "";

        var groups = version.groups
          .filter(function (group) {
            return group.items.length > 0;
          })
          .map(function (group) {
            var heading = group.title
              ? "<h4>" + inlineMarkdown(group.title) + "</h4>"
              : "";
            var items = group.items
              .map(function (item) {
                return "<li>" + inlineMarkdown(item) + "</li>";
              })
              .join("");
            return heading + "<ul>" + items + "</ul>";
          })
          .join("");

        return (
          '<article class="release">' +
          '<header class="release-head">' +
          "<h3>v" +
          escapeHtml(number) +
          "</h3>" +
          date +
          "</header>" +
          groups +
          "</article>"
        );
      })
      .join("");
  }

  function renderChangelog() {
    if (!changelogEl) return;

    if (changelogStatus === "ready" && changelogVersions.length) {
      changelogEl.innerHTML = renderReleaseNotes(changelogVersions);
      return;
    }

    var message =
      changelogStatus === "error" ? t("whatsnew.error") : t("whatsnew.loading");
    changelogEl.innerHTML =
      '<p class="muted">' + escapeHtml(message) + "</p>";
  }

  async function loadChangelog() {
    try {
      var response = await fetch(CHANGELOG_URL, { cache: "no-cache" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var markdown = await response.text();
      var versions = parseChangelog(markdown);
      if (!versions.length) throw new Error("No versions found");
      changelogVersions = versions;
      changelogStatus = "ready";
    } catch (error) {
      changelogStatus = "error";
    }
    renderChangelog();
  }

  if (langToggle) {
    langToggle.addEventListener("click", function () {
      setLanguage(lang === "az" ? "en" : "az", true);
    });
  }

  setLanguage(lang, false);
  loadRelease();
  loadChangelog();
})();
