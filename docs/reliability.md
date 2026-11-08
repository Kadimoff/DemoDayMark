# munsif.im — etibarlılıq (v11)

Məqsəd: canlı tədbirdə (30–100 münsif, 5–10 ekran, zəif Wi-Fi, server restartı) **heç bir bal itməsin**, ekranlar sinxron
qalsın və platforma özü bərpa olunsun. Bu sənəd auditi, edilən dəyişiklikləri və ölçülmüş nəticələri yazır.
Tədbir günü nə etməli: [runbook.md](runbook.md).

## 1. Audit (468f2a0 — v11-dən əvvəlki canlı versiya)

| # | Risk | Harada (468f2a0) | Həll (v11) |
|---|---|---|---|
| 1 | Bal, onun tarixçə sətri və audit ayrı-ayrı yazılırdı (3 commit). Arada çökmə → bal var, tarixçə yoxdur. | `server/scores.ts:42-44` | Hamısı **bir transaksiyada** (`applyScore` + `ScoreWriter`). |
| 2 | Op id yox idi: socket ack 7 s-də gəlməyəndə eyni bal HTTP ilə yenidən göndərilirdi → server onu **iki dəfə** tətbiq edirdi (2 tarixçə sətri, "update" auditi). Restartda cavabı itən bal da təkrar yazılırdı. | `web/src/juror.ts:438-457`, `server/realtime.ts:119` | Hər bal üçün telefonda yaranan **op id**; server `score_ops` cədvəlində saxlayır və eyni op-u bir dəfə tətbiq edir, təkrarına saxlanmış cavabı qaytarır. |
| 3 | Telefon növbəsi yox idi: şəbəkə xətası olanda bal "qaralama"da qalırdı, yalnız `online` hadisəsi / reconnect / kilidin açılması ilə yenidən göndərilirdi. Bu hadisələr gəlməsə (məs. Wi-Fi "qoşulu", amma internet yoxdur) münsif özü "Yenidən cəhd et" basmalı idi. Eyni anda yalnız bir bal göndərilə bilirdi. | `web/src/juror.ts:399-431, 476-484` | `web/src/lib/outbox.ts`: `localStorage` növbəsi, backoff ilə (1→15 s) avtomatik təkrar, sıra ilə göndərmə, hər balın vəziyyəti UI-da (göndərilir / növbədə / saxlanıldı / rədd edildi), göndərmə tarixçəsi. |
| 4 | Qiymətləndirmə bağlı olanda göndərilən bal sadəcə 423 alırdı — serverdə izi qalmırdı. | `server/scores.ts:20` | Rədd edilən op dəyərləri ilə `score_ops`-da (`status='rejected'`) + `audit_log` `score.rejected`; telefonda tarixçədə "rədd edildi", qaralama itmir; kilid açılanda dəyişməmiş bal özü yenidən gedir. |
| 5 | Hər SQL çağırışında `db.prepare()` — yük altında serverin ən böyük CPU xərci (profil: 6.4 s / 27 s). | `server/repo.ts`, `teamrepo.ts` (hər metod) | `openDb` hazırlanmış statement-ləri keşləyir (`cacheStatements`). |
| 6 | `synchronous` açıq yazılmamışdı (better-sqlite3 default = FULL) və hər bal ayrıca fsync idi; 100 bal/s-də event loop saniyələrlə dayanırdı (p99 2–7 s). | `server/db.ts:379-381` | `synchronous=FULL` açıq + **group commit**: eyni event-loop turunda gələn ballar bir transaksiyada (bir fsync), hər biri öz savepoint-ində. |
| 7 | Startda bütövlük yoxlaması yox idi. | `server/db.ts:376` | `PRAGMA quick_check` hər startda; xəta logda və `/api/health`-də (`db.integrity`, `warnings`). |
| 8 | Server işləyərkən dövri yedək yox idi (yalnız miqrasiyadan əvvəl + host cron). | — | `BackupScheduler`: hər 10 dəq (dəyişiklik olubsa) onlayn yedək → `.part` → `quick_check` → `auto-*.db`, son 48 saxlanılır; root paneldən "İndi yedəklə". |
| 9 | Bərpa əl ilə fayl köçürməklə idi (WAL/SHM səhvi riski). | README | `restore.js <fayl>` → növbəti startda yoxlanılır, köhnə baza `pre-restore-*.db` kimi saxlanılır; `--now` dayanmış server üçün. |
| 10 | `/api/health` yalnız `SELECT 1` idi. | `server/app.ts:123` | Baza, quick_check, son yedək, socket sayı, event-loop gecikməsi, uptime, versiya/commit, sxem; DB oxunmursa 503. Root üçün `/api/root/system`. |
| 11 | PPTX çevrilməsi zamanı restart → fayl həmişəlik "running" qalırdı. | `server/routes/team.ts:56`, `stage.ts:220` | Startda `running/pending` çevrilmələr yenidən başladılır. |
| 12 | Xətalarda kontekst yox idi; SIGTERM-də vaxt limiti yox idi; tutulmamış promise prosesi öldürə bilərdi. | `server/index.ts` | `onError` hook (url, method, user, org), socket xətalarında jurorId/opId; `unhandledRejection` loglanır; `uncaughtException` → log + exit (konteyner yenidən başlayır); SIGTERM 8 s hard limit, WAL checkpoint. |
| 13 | `npm test`-də 1–1.5 s-lik gözləmələr və latency limitləri — yüklü build host-da flaky (2 deploy uğursuz olmuşdu). | `test/team.test.ts:34`, `v3.test.ts:37,181,344,353`, `orgs.test.ts:39`, `privacy.test.ts:150` | Hadisə gözləmələri 8 s, latency limitləri 5 s (funksional yoxlama qalır; real latency `test:load`-da ölçülür). |
| 14 | `SESSION_SECRET` boşdursa (yalnız dev) hər restart bütün sessiyaları bitirir. | `server/config.ts:61` | Production-da onsuz da məcburidir; runbook-da qeyd. Yük testi bunu tapdı (harness əvvəl hər restartda yeni secret verirdi). |

**Artıq düzgün olanlar (yoxlanıldı):** taymer (`timer_running/offset_sec/anchor_at` — server saatına bağlı), səhnə
(cari komanda, rejim, slayd, səhnə/tədbir prezentasiyası), reveal (addım + snapshot) **bazadadır** (`event` cədvəli) —
restartdan sonra eynidir, taymer server saatı ilə davam edir. Ekranlar reconnect-dən sonra bütün vəziyyəti yenidən alır
(`web/src/lib/socket.ts`). RAM-da qalanlar yalnız telemetriyadır: onlayn münsiflər, "doldurur 4/6" gedişatı, login
limitləri, xatırlatma dedupe (`realtime.ts:24-27`, `auth.ts:109`, `teams.ts:74`) — restartda sıfırlanmaları zərərsizdir.

## 2. Bal axını (v11)

```
telefon: bal → outbox (localStorage, opId) ──socket "score:submit" (ack 7 s)──▶ server
                         │  ack gəlmədi → HTTP PUT /api/juror/scores/:id (eyni opId)
                         │  şəbəkə/5xx → növbədə, backoff 1→15 s, online/reconnect/visible olanda dərhal
server: ScoreWriter (group commit) → TRANSACTION { score_ops yoxla → upsert scores + score_history + audit + score_ops }
        → commit (fsync) → ack + admin/juror broadcast
```

- Eyni op ikinci dəfə gəlsə: `score_ops`-dan saxlanmış cavab (`duplicate: true`), heç nə yazılmır.
- 423/400/404: `rejected` — dəyərləri ilə saxlanılır, telefonda tarixçədə qalır; sonra eyni op gələrsə yenidən yoxlanılır.
- 401: növbə dayanır (op silinmir), yeni QR ilə daxil olanda davam edir.
- Eyni komandaya yeni versiya: hələ göndərilməmiş köhnə versiyanı əvəz edir (son versiya qalib gəlir).

## 3. SQLite

| Parametr | Dəyər | Niyə |
|---|---|---|
| `journal_mode` | WAL | Oxuyanlar yazanı bloklamır; proses çöksə commit olunmuş heç nə itmir. |
| `synchronous` | **FULL** (`DB_SYNCHRONOUS=NORMAL` ilə dəyişir) | "Saxlanıldı" cavabı yalnız fsync-dən sonra gedir: host/enerji qəzası belə təsdiqlənmiş balı silə bilməz (telefon onu artıq növbədən çıxarıb). NORMAL-da son commit-lər OS qəzasında itə bilər. Qiyməti: bir fsync ≈ 5–7 ms (bu VPS), amma group commit ilə 100 bal/s-də də p95 < 50 ms. |
| `busy_timeout` | 5000 ms | Yedək/bərpa CLI kimi ikinci bağlantı SQLITE_BUSY ilə yıxılmır. |
| `foreign_keys` | ON | |
| `quick_check` | hər start | Nəticə log + `/api/health`. |
| Yedək | `auto-*.db` hər 10 dəq, son 48; `manual-*`, `pre-v*`, `pre-restore-*` rotasiyaya düşmür | Yedək tək fayldır (journal_mode=DELETE), yoxlanılmadan adını almır. |

## 4. Yük və xaos testləri

`npm run build && npm run test:load` / `npm run test:chaos` (`scripts/loadtest/run.ts`). Harness build olunmuş serveri
təzə `DATA_DIR`-lə başladır, 100 münsifi **real QR dəvətləri** ilə daxil edir və hər münsifi **real telefon növbəsi**
(`web/src/lib/outbox.ts`) ilə idarə edir. Hər münsif 30 komandanın hamısına bal verir (təsadüfi 150–1500 ms fasilələrlə,
20%-ni sonra dəyişir — ~3600 göndəriş), koordinator hər 2 s taymer/slayd dəyişir, 10 ekran dinləyir. Sonda server dayandırılır
və **baza birbaşa oxunur**: hər münsif/komanda üçün bazadakı bal münsifin göndərdiyi son versiya ilə müqayisə olunur.

Host: paylaşılan VPS, 6 CPU, Node 22, eyni maşında digər agentlər işləyir (load1 2.7–6). Harness (100 socket klienti) də
eyni maşındadır, yəni rəqəmlər real tədbirdən pis şəraitdədir.

### Nəticələr (son qaçış, 2026-11-08, commit-də olan kod)

| | test:load | test:chaos |
|---|---|---|
| Münsif / ekran / komanda / meyar | 100 / 10 / 30 / 6 | 100 / 10 / 30 / 6 |
| Göndərilən versiyalar (op) | 3630 | 3586 |
| Gözlənilən bal (münsif×komanda) | 3000 | 3000 |
| Bazada bal | 3000 | 3000 |
| **İtirilmiş bal** | **0** | **0** |
| Səhv dəyər | 0 | 0 |
| Dublikat tətbiq (tarixçə − tətbiq olunmuş op) | 0 | 0 |
| Server dedupe etdi (təkrar gələn op) | 0 | 2 |
| HTTP fallback cəhdləri | 0 | 556 |
| Xaos | — | 60 qopma (30 kəskin, 30 oflayn 1–4 s), 10.7-ci saniyədə **SIGKILL**, 2.9 s fasilə |
| Bal → admin ekranı p50 / p95 / p99 / max | 7 / 31 / 111 / 626 ms | 9 / 225 / 3849 / 5539 ms* |
| ↳ restart pəncərəsindən kənar | — | 8 / 44 / 193 / 3043 ms |
| Ack (telefon) p50 / p95 / p99 | 8 / 32 / 117 ms | 10 / 192 / 742 ms |
| Ekran hadisəsi p50 / p95 | 11 / 250 ms | 17 / 113 ms |
| Sonda sinxron ekran | 10/10 | 10/10 |
| Server CPU orta / p95 | 39% / 70% | 44% / 79% |
| Server RSS max | 178 MB | 174 MB |
| Event loop gecikməsi p99 / max | 50 / 590 ms | 44 / 138 ms |
| Test zamanı avtomatik yedək | 3 | 2 |

\* Xaosda gecikməyə qəsdən oflayn saxlanılan (1–4 s) telefonların və server restartının gözləmə vaxtı daxildir — bal itmir,
sadəcə şəbəkə qayıdanda gedir. Xaos qaçışında 1 op serverdə tətbiq olunub, amma telefona cavabı çatmayıb və münsif həmin
komandaya artıq yeni versiya göndərib — yeni versiya köhnəni əvəz edib, bazadakı dəyər düzgündür (yoxlanılıb).

### Optimallaşdırmanın təsiri (eyni test:load, eyni host, dəyişən yüklə)

| Vəziyyət | Bal → admin p50 / p95 / p99 | Event loop max | Qeyd |
|---|---|---|---|
| Statement keşi yox, hər bal ayrı fsync (468f2a0 yazma yolu) | 77 / 903 / 2092 ms | 2.4 s | CPU-nun 23%-i `prepare` |
| eyni, host daha yüklü | 878 / 3075 / 7325 ms | 7.3 s | fsync dayanmaları |
| `synchronous=NORMAL` (müqayisə üçün) | 14 / 622 / 1522 ms | 1.6 s | |
| Statement keşi, FULL | 14 / 1159 / 2793 ms | 1.9 s | qalan xərc: fsync (`COMMIT`) |
| Statement keşi + group commit, FULL | 23 / 176 / 293 ms | 0.15 s | host yüklü |
| Son (yuxarıdakı cədvəl) | **7 / 31 / 111 ms** | 0.59 s | |

Real tədbirdə yük xeyli azdır: ~3000 bal 2–3 saata (pitch-dən sonra ~10 bal/s partlayış), test isə hamısını 35 s-yə sıxır.

## 5. `npm test` və flakiness

- `npm test` = 14 fayl, 168 test (~10 s; əvvəl 11 fayl, 151 test); ağır yük testləri **daxil deyil** (Docker build tez qalır).
- 5 dəfə ardıcıl: hamısı keçdi. 5 dəfə **12 məşğul thread / 6 CPU** yükü altında (load avg 18–32): əvvəl 2/5 qaçışda
  `team.test.ts` "PDF yüklənəndə admin bildirişi" 1.5 s limitə görə düşdü → gözləmələr 8 s-yə qaldırıldı; sonra 5/5 keçdi.
- Coolify env-ləri (`BOOTSTRAP_*`, `ADMIN_*`, `SESSION_SECRET`, `DATA_DIR`, `BACKUP_*`) testlərdə `test/setup-env.ts` ilə silinir.

## 6. Restart davamlılığı (sübutlar)

- `test/reliability.test.ts`: səhnə + rejim + slayd + **işləyən taymer** + reveal restartdan sonra eyni (taymer mövqeyi irəliləyib);
  ekran socket-i özü yenidən qoşulur və növbəti taymer hadisəsini alır; cavabı restartda itən bal təkrar göndərilir → `duplicate`, 1 tarixçə sətri.
- `e2e/run.mjs`: brauzerdə server SIGKILL → restart: proyektor və telefon özü qoşulur, server düşükkən verilən bal restartdan sonra çatır.
- Köhnə canlı baza (old-data surəti, 468f2a0 ilə v10-a açılıb, işləyən taymerlə) yeni kodla açıldı: `pre-v11-*.db` yaradıldı,
  komandalar/münsiflər/ballar/reytinq/meyarlar **IDENTICAL**, `/api/stage` (taymer anchor/offset daxil) **IDENTICAL**.

## 7. Məlum məhdudiyyətlər

- Son-yazan-qalib gəlir: eyni münsif eyni komandaya iki cihazdan bal versə, serverə son çatan qalır (client vaxtı `score_ops.client_at`-da saxlanılır, amma qərarda istifadə olunmur).
- Telefon növbəsi `localStorage`-dadır: münsif brauzer məlumatlarını silsə və ya "gizli rejim" tabını bağlasa, hələ göndərilməmiş ballar itir (UI "növbədə" göstərir).
- Səhifə ilk dəfə oflayn açıla bilməz (service worker yoxdur); açıq səhifə oflayn işləyir.
- Server tək prosesdir (SQLite + bir Node). Host özü düşsə, Coolify konteyneri qaldırana qədər telefonlar növbədə saxlayır.
- Rədd edilən op-lar admin tarixçə ekranında ayrıca göstərilmir (API: `repo.rejectedOps()`, `/api/root/system`-də say; audit log-da `score.rejected`).
- `fastify-static` faylları startda indeksləyir: server işləyərkən `npm run build` etsəniz yeni asset-lər restartadək 404 olur (Docker-də problem deyil).
