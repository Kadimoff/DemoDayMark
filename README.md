# munsif.im — münsif sistemi, pitch taymeri və prezentasiya səhnəsi

**munsif.im** (oxunuşu "münsifim": *Təqdimatlarınız münsifim ilə qiymətləndirilir.*) — DemoDay münsif sisteminin yeni adı və görünüşüdür.
Mövcud funksiyaların hamısı (koordinator girişi, münsif QR girişi, bal sistemi, canlı panel, taymer, nəticə açıqlaması, Excel/PDF ixrac, backup) dəyişmədən qalır;
üstünə munsif.im landing-i, komanda girişi, prezentasiya/sayt yükləmə, bildirişlər və prezentasiya səhnəsi (taymer bubble + son 5 saniyə effekti) əlavə olunub.

Tədbirin adı Quraşdırma → "Brend / prefiks" sahəsindən gəlir (məs. "Ignite" → **Ignite DemoDay**) və paneldə tədbir nişanı kimi görünür; əsas loqo hər yerdə **munsif.im**-dir.

Real vaxtda münsif qiymətləndirməsi və səhnə taymeri. 8 komanda, 4–5 münsif, hər komanda üçün 3 dəq pitch + 2 dəq sual-cavab.

**Təşkilatlar (multi-tenant).** munsif.im bir neçə müştəri şirkətə xidmət edir: hər təşkilatın öz tədbiri, komandaları, münsifləri, balları, faylları, bildirişləri, taymeri/səhnəsi və nəticə açıqlaması var. Təşkilatın koordinatoru yalnız öz təşkilatını görür və idarə edir. Platforma sahibi (**root**, `.env`-dəki admin) bütün təşkilatları görür. Ətraflı: [Təşkilatlar və rollar](#təşkilatlar-və-rollar).

| Ekran | Ünvan | Kim üçün |
|---|---|---|
| **Landing** | `/` (AZ), `/en/` (EN) | ziyarətçi; daxil olmuş istifadəçi header-də "Panel" düyməsini görür |
| Giriş | `/login` | koordinator (admin) və platforma sahibi (root) — eyni forma |
| **Platforma paneli** | `/root` (`/admin/orgs` → buraya) | yalnız root: bütün təşkilatlar canlı vəziyyəti ilə (səhnədəki komanda, taymer, komanda/münsif sayı, səs irəliləyişi), təşkilat yarat / deaktiv et, koordinatorlar, **“Proyektoruna bax”** (yalnız oxu), **“Müdaxilə et”**, qiymət tarixçəsi (Excel) |
| Münsif QR girişi | `/j/<kod>` | münsif (QR skan edəndə açılır) |
| Münsif paneli | `/juror` | münsiflər (telefon) |
| **Komanda girişi** | `/t/<kod>`, `/team` | komandalar (link/QR və ya kod) |
| Canlı panel | `/admin` | koordinator: 4 bölmə — **Səhnə · Komandalar · Münsiflər · Nəticələr** (telefonda aşağıda tab bar) |
| Quraşdırma | `/admin/setup` | koordinator |
| **Pult** | `/admin/pult` (`/stage/control` → buraya) | koordinatorun telefonu: start/fasilə, ±30 s, slayd, intro, sayt rejimi, tədbirin prezentasiyası, nəticə açıqlaması |
| **Səhnə** | `/stage` (= `/timer`) | proyektor: komandanın və ya **tədbirin öz** prezentasiyası + üzən taymer; prezentasiya yoxdursa böyük taymer. İdarə düyməsi yoxdur. Təşkilat üçün: `/o/<slug>/stage`, `/o/<slug>/timer` |
| **Səhnə demosu** | `/stage/demo` | girişsiz demo (nümunə PDF, 15 s; `?t=30`, `?slow=8`) |
| Danışan ekranı | `/speaker` (`/o/<slug>/speaker`) | çıxış edən: taymer + cari və növbəti slayd |
| **Nəticə açıqlaması** | `/reveal` (`/o/<slug>/reveal`) | proyektor; yalnız admin icazə verdikdən sonra, addım-addım |

Prefikssiz `/stage`, `/timer`, `/reveal`, `/speaker`, `/team` əsas (root) təşkilatı göstərir — köhnə proyektor linkləri dəyişmir. Hər səhifə `?org=<slug>` ilə də açılır.

## Təşkilatlar və rollar

| Rol | Kim | Nə edir |
|---|---|---|
| **root** (platforma sahibi) | `ADMIN_USERNAME` hesabı (`users.is_root = 1`, `role = 'admin'`) | Girişdən sonra **`/root` platforma paneli** (tədbir ekranlarından tam ayrı): bütün təşkilatlar (öz tədbiri — təşkilat #1, slug `root` — da siyahıdadır), təşkilat yaratmaq, deaktiv/aktiv etmək, koordinator yaratmaq / parolunu sıfırlamaq / deaktiv etmək, **“Proyektoruna bax”** (həmin təşkilatın proyektoru canlı, yalnız oxu, iframe `?preview=1`), **“Müdaxilə et”** (həmin təşkilatın koordinator panelinə — yuxarıda sarı banner, “Platformaya qayıt”), istənilən təşkilatın qiymət tarixçəsi (Excel) |
| **admin** (təşkilat koordinatoru) | `role = 'admin'`, `is_root = 0`, `org_id` = təşkilatı | Yalnız öz təşkilatının tədbiri: komandalar, münsiflər (QR), meyarlar, ballar, ixrac, səhnə/taymer/pult, nəticə açıqlaması. `/root` → `/admin`-ə yönləndirilir, `/api/root/*` → 403, root socket izləməsi (`watch: "root"`) koordinatora heç nə göndərmir |
| juror / komanda | təşkilatın münsifi / komandası | QR və komanda linki yalnız öz təşkilatına aparır |

- **Giriş:** koordinator da eyni `/login` formasından (istifadəçi adı + şifrə) daxil olur və öz `/admin` panelinə düşür. Header-də təşkilatın adı görünür. Hər iki rol üçün header-də **“Şifrəni dəyiş”** (açar ikonu) var: hazırkı şifrə + yeni şifrə (min. 8); digər cihazlardakı sessiyalar bağlanır.
- **Yeni təşkilat** boş tədbirlə başlayır: standart meyarlar, pitch 3:00 + sual-cavab 2:00, komanda və münsif yoxdur, brend prefiksi = təşkilatın adı (Quraşdırmada dəyişilir).
- **Koordinatorun proyektor linkləri** paneldə avtomatik öz təşkilatına aparır: `https://munsif.im/o/<slug>/stage`, `/o/<slug>/timer`, `/o/<slug>/reveal`, `/o/<slug>/speaker`; açıq qeydiyyat: `/o/<slug>/team`. Koordinator prefikssiz `/timer` açsa, server onu `/o/<slug>/timer`-ə yönləndirir. Başqa təşkilatın proyektor səhifəsində admin düymələri görünmür.
- **Deaktiv təşkilat:** koordinator, münsif və komandaların sessiyaları bağlanır, giriş 403, ictimai ekranlar 404. Data silinmir; yenidən aktiv etmək olar. Əsas təşkilat (#1) deaktiv edilə bilməz.
- **İzolyasiya serverdədir:** hər sorğu sessiyanın təşkilatı ilə süzülür (`Repo`/`TeamRepo` təşkilata bağlıdır, başqa təşkilatın id-si “tapılmadı” kimi görünür), socket otaqları təşkilata görədir (`o<id>:public|admin|jurors`), wipe təsdiq kodu, taymer, səhnə, açıqlama — hamısı təşkilata görə. Testlər: `test/orgs.test.ts` (hər API qrupu, fayllar, ixrac, socket, QR/komanda linki, root API 403, eyni anda iki taymer, bootstrap), `test/orgs-migration.test.ts` (köhnə bazanın itkisiz keçidi).
- **Backup** bütün platformanın bazasıdır (`npm run backup`, pre-migration nüsxələri, serverdəki yedəklər) — yalnız infrastruktur/root səviyyəsində; koordinator üçün backup API-si yoxdur.

### Demo/müştəri koordinatorunu env ilə yaratmaq (bootstrap)

Bir dəfəlik və idempotent: hər startda təşkilat yoxdursa yaradılır, istifadəçi yoxdursa koordinator kimi yaradılır. **İstifadəçi artıq varsa — toxunulmur** (parolu üzərinə yazılmır). İstifadəçi adı root-a, münsifə və ya başqa təşkilata aiddirsə — heç nə edilmir, logda xəbərdarlıq. Yaradılma audit loguna yazılır (`org.create`, `coordinator.create`, `by: bootstrap`).

```bash
# parolun argon2id hash-ı (serverin öz parametrləri ilə); parol yalnız stdin-dən oxunur, ekrana/loga yazılmır
node scripts/hash-password.mjs            # interaktiv: iki dəfə soruşur, gizli
printf '%s' 'PAROL' | node scripts/hash-password.mjs   # və ya stdin ilə
```

| Dəyişən | Nümunə |
|---|---|
| `BOOTSTRAP_ORG_SLUG` | `demo` (kiçik latın hərfləri, rəqəm, tire; `root`, `admin`, `api`… ayrılıb) |
| `BOOTSTRAP_ORG_NAME` | `Demo` |
| `BOOTSTRAP_COORD_USERNAME` | `demo` |
| `BOOTSTRAP_COORD_HASH_B64` | `hash-password.mjs`-in çıxışı (base64) |

Koordinator yarandıqdan sonra env-ləri silmək olar (qalsalar da zərərsizdir). Eyni işi root `/root` panelindən də edə bilər.

## munsif.im: komanda girişi, prezentasiyalar və səhnə

**Komanda girişi.** Quraşdırma → Komandalar → komandanı açın → *Giriş linki / QR* (və ya canlı panel → Komandalar → ⋯) hər komanda üçün giriş linki + QR yaradır (`/t/ABCD-EFGH-JKMN`). Komandanın bütün üzvləri eyni linklə daxil olur; kodu `/team` səhifəsində əl ilə də yazmaq olar. "Yeni link" köhnəsini etibarsız edir, "Ləğv et" komandanın bütün sessiyalarını bağlayır. *Açıq qeydiyyat* (standart: söndürülüb) açılsa komanda `/team`-də özü qeydiyyatdan keçir, "təsdiq gözləyir" statusunda yaranır və koordinator təsdiqləyənə qədər sıraya/reytinqə düşmür.

**Komanda paneli (`/team`) — bir səhifəlik sadə forma.** Yuxarıda status və **deadline geri sayımı** (saniyə ilə; 1 saatdan az qalanda sarı, keçəndə “yükləmə bağlıdır”), çıxış sırası; altında forma: komanda adı, layihə, üzvlər, sayt linki, prezentasiya (sürüklə-burax və ya “Fayl seç”; PDF; PPTX serverdə LibreOffice varsa avtomatik PDF-ə çevrilir), *Yadda saxla*. Demo video və loqo “Əlavə (istəyə bağlı)” altında. Komanda/layihə adı yalnız koordinator icazə versə dəyişir. Komanda bal və ya reytinq görmür.

**“Səhnədəsiniz” — komanda öz slaydlarını çevirir.** Komanda səhnəyə çıxanda `/team`-in başında böyük ← → düymələri və proyektordakı slaydın kiçik görüntüsü çıxır (Bluetooth klikker / klaviatura ←/→/PageUp/PageDown da işləyir). Hüquq yalnız **öz prezentasiyası səhnədə olanda** var (komanda səhnəsi, slayd görünüşü); səhnədən düşəndə, proyektorda tədbirin prezentasiyası və ya taymer/sayt göstəriləndə itir. Koordinator Quraşdırma → *Səhnə taymeri* → “Komanda öz slaydlarını çevirə bilsin” ilə söndürə bilər (standart: açıq). Server hər sorğuda yoxlayır (`POST /api/team/slide`, `test/v3.test.ts`).

**Prezentasiyaya baxış.** Canlı panel → **Komandalar**: hər komanda bir sətir — *Bax* (pdf.js ilə tam ekran, ← → / sürüşdürmə, slayd sayı), *Sayt*, *Səhnəyə*. “Qəbul et / Geri qaytar” istəyə bağlıdır (⋯ menyusunda); səhnəyə çıxarmaq üçün qəbul tələb olunmur.

**Tədbirin öz prezentasiyası** (açılış, fasilə, sponsorlar, qaydalar). Quraşdırma → *Tədbirin prezentasiyası*: bir və ya bir neçə PDF/PPTX yüklənir (ad, sıra, silmə). Canlı panel → Səhnə və ya pult → *Proyektora*: proyektor komandasız, taymer bubble-sız (istəyə görə açılır) həmin faylı göstərir; slaydlar panel/pult ← →, proyektordakı klikker ilə çevrilir; *Komandaya qayıt* və ya komandanı səhnəyə çıxarmaq proyektoru komandaya qaytarır. Fayl yalnız proyektorda olduğu müddətdə ictimaidir (`/api/stage/event-presentation`).

**Fayllar.** Maksimum 50 MB (`MAX_UPLOAD_MB`), loqo 5 MB; uzantı + magic byte yoxlanılır (PDF `%PDF-`, PPTX zip, PNG/JPEG/WebP); fayllar `DATA_DIR/uploads`-da təsadüfi adla (0600) saxlanılır — Docker-də persistent volume içindədir. Endirmə: admin hamısını, komanda yalnız özününkünü (başqasınınkı 403), münsif yalnız "Münsiflər materialları görsün" açıq olanda; girişsiz səhnə ekranı yalnız **hazırda səhnədə olan** komandanın prezentasiyasını ala bilər (`/api/stage/presentation`).

**Bildirişlər** (socket.io + brauzer Notification API): koordinatora "Komanda X prezentasiya yüklədi" (toast + zəng ikonu + siyahı), canlı paneldə *Qəbul et / Geri qaytar (səbəblə)*; komandaya "Prezentasiyanız qəbul edildi / geri qaytarıldı", "Sıranız yaxınlaşır" (qabaqda 2 komanda qalanda), "Növbəti sizsiniz", "Səhnəyə dəvət olunursunuz", deadline-a 1 saat qalmış xatırlatma.

**Səhnə (`/stage` = `/timer`).** Səhnədəki komandanın PDF-i pdf.js ilə tam ekranda, taymer üstündə üzən **bubble** kimi (sürüşdürülə bilər, ikiqat klik yerinə qaytarır): son 30 s amber, son 10 s qırmızı; **son 5 saniyə** (həm pitch, həm sual-cavab) bubble mərkəzə uçub ekranı örtür, rəqəmlər kiçilərək azalır, halqa/zərrəciklər hər saniyə çoxalır, ekran titrəyir; 0-da "VAXT BİTDİ" partlayışı və sual-cavab başlayır (mövcud pitch → sual-cavab → vaxt bitdi axını). Səs: köhnə siqnallar qalır, takeover zamanı tik-səsləri effektin öz səsi ilə əvəz olunur (ikiqat səs yoxdur); `M` səsi söndürür. Zəif cihazda effekt avtomatik *lite* rejimə keçir; `prefers-reduced-motion` hörmət olunur. Prezentasiyası olmayan komandada köhnə böyük taymer (yeni dizaynla) görünür.
Slaydlar: `←/→`, `PageUp/PageDown` (klikker, admin sessiyası olan proyektorda), canlı panel, pult, səhnədəki komanda — slayd nömrəsi serverdə saxlanılır və bütün səhnə/danışan ekranlarında sinxron dəyişir. **Proyektorda idarə düyməsi və taymer qısayolu yoxdur** (Space/S/R/N işləmir): yalnız avtomatik gizlənən səs (`M`) və tam ekran (`F`) ikonları. Taymeri canlı paneldən və ya pultdan idarə edin. *Səhnə taymeri* ayarları (Quraşdırma): pitch və sual-cavab müddəti, son 5 saniyə effekti aç/bağla, səs aç/bağla. *Sayt rejimi*: layihə saytı iframe-də; sayt daxil edilməyə icazə vermirsə (X-Frame-Options/CSP, server yoxlayır) böyük QR kod. *Intro*: "Növbəti çıxış" ekranı + 3·2·1.

**PPTX → PDF.** Server `soffice`-u PATH-da tapır (və ya `SOFFICE` env). Eyni anda bir çevirmə, 90 s limit, profil `DATA_DIR/lo-profile`. Docker image-ə `libreoffice-impress` + şriftlər əlavə olunub (~400 MB).

**Təşkilatlar miqrasiyası (v9).** Bütün mövcud cədvəllərə `org_id INTEGER NOT NULL DEFAULT 1` əlavə olunur — yəni bütün köhnə data (tədbir, komandalar, meyarlar, ballar, tarixçə, münsiflər, QR-lar, komanda linkləri/sessiyaları/faylları, bildirişlər, audit, səhnə/taymer/açıqlama vəziyyəti) təşkilat #1-də (`root`, adı = mövcud brend, məs. “TechConnect Hakaton”) qalır; mövcud admin `is_root = 1` olur. Yeni `orgs` cədvəli. İki cədvəl yenidən qurulur, çünki məhdudiyyətləri tək tədbir fərz edirdi: `event` (`CHECK (id = 1)` → `UNIQUE (org_id)`, sətir id-si 1 qalır) və `criteria` (`key` qlobal unikal → `UNIQUE (org_id, key)`). Hər ikisi eyni transaksiyada bütün sətirləri köçürür, köçürmə orijinalla müqayisə olunur, sonda `PRAGMA foreign_key_check`; hər hansı uyğunsuzluqda bütün v9 geri qaytarılır və baza v8 kimi qalır (`test/orgs-migration.test.ts`). Miqrasiyadan əvvəl `pre-v9-*.db` surəti alınır.

**Tədbirlər və arxiv (v10).** Təşkilat bir neçə tədbir keçirə bilər; hər an bir tədbir aktivdir. Quraşdırma → Tədbir → **“Yeni tədbir yarat”**: ad, növ, tarix, pitch/sual-cavab müddəti, yükləmə deadline-ı; meyarları köçür (standart), komanda adlarını köçür (istəyə görə; fayl/link/bal köçmür). Hazırkı tədbir **arxivə** keçir: nəticələri, tarixçəsi, Excel/PDF ixracı “Arxiv” siyahısında oxuma rejimində qalır; arxivdəki münsif və komanda sessiyaları bağlanır. Miqrasiya yalnız əlavədir: yeni `events` (hər təşkilatın mövcud tədbiri onun aktiv tədbiri olur, id = köhnə `event` sətrinin id-si) və `event_files` cədvəlləri; `users`, `teams`, `criteria`, `scores`, `score_history`, `juror_invites`, `team_links`, `team_sessions`, `team_files`, `notifications` cədvəllərinə `event_id` sütunu (mövcud sətirlər öz təşkilatının aktiv tədbirinə yazılır, sətir sayı və boş `event_id` yoxlanılır); `event`-ə səhnə sütunları (`stage_scene`, `stage_event_file`, `event_slide`, `event_bubble`, `team_slide_control`, `last5_fx`, `stage_sound`). Heç bir sətir köçürülmür və silinmir; bir transaksiyada, uğursuzluqda baza v9 kimi qalır. Əvvəlcə `pre-v10-*.db` surəti (`test/events-migration.test.ts` — 537b462-in donmuş data qatı ilə yazılmış v9 baza).

**Qiymətləndirmə tarixçəsi (Excel).** Canlı panel → Nəticələr → *Qiymətləndirmə tarixçəsi* → Excel: kim, nə vaxt, hansı komanda, meyar, köhnə → yeni bal (hər göndərmə/dəyişiklikdə hər meyar bir sətir; silinmələr də). Koordinator öz təşkilatı üçün (`/api/admin/history.xlsx`, arxiv tədbiri üçün `/api/admin/events/<id>/history.xlsx`), root istənilən təşkilat üçün (`/api/root/orgs/<id>/history.xlsx`).

**Realtime etibarlılığı.** socket.io: əvvəl WebSocket, alınmasa polling; `pingInterval` 15 s / `pingTimeout` 10 s (Traefik/Coolify arxasında boş bağlantı kəsilmir, ölü bağlantı ~25 s-də tapılır); klient 0.5 s → 5 s eksponensial backoff ilə yenidən qoşulur, ekranda “Yenidən qoşulur…” göstəricisi; hər yenidən qoşulmada, telefon arxa plandan qayıdanda (`visibilitychange`) və şəbəkə qayıdanda (`online`) tam vəziyyət (səhnə, taymer, slayd, bildirişlər) yenidən yüklənir. Taymer hər saniyə yayımlanmır — ekranlar `serverNow` ilə özü hesablayır; tez-tez gələn yayımlar birləşdirilir. PDF səhifə sayma worker thread-də, PPTX çevirmə ayrıca prosesdə — event loop bloklanmır. Yük testi (30 münsif + 5 ekran socket-i): slayd dəyişikliyi p95 ~20 ms (`test/v3.test.ts`, limit 150 ms).

**Backup və miqrasiya.** Sxem yalnız əlavə ilə dəyişir (v8: yeni cədvəllər `team_links`, `team_sessions`, `team_files`, `notifications`; `teams`/`event`-ə default-lu sütunlar). Server açılanda sxem köhnədirsə miqrasiyadan **əvvəl** bazanın surəti `DATA_DIR/backups/pre-v<N>-<vaxt>.db` kimi saxlanılır (better-sqlite3 `.backup()`, son 10 nüsxə). Köhnə (v7) bazanın itkisiz açılması `test/munsif-migration.test.ts`-də yoxlanılır.

## Bal sistemi

| Hissə | Mənbə | Maksimum |
|---|---|---|
| **Giriş balı** | Demo Day-dən əvvəlki seçim mərhələsi. Hər komanda üçün Quraşdırma → Komandalar → "Giriş balı" sahəsinə yazılır. | 50 |
| **Demo Day balı** | Münsiflərin orta balı. Hər münsif 6 meyar üzrə bal verir, onun balı bu balların cəmidir. | 50 |
| **Yekun** | Giriş balı + Demo Day balı | 100 |

Demo Day meyarları (hər birində münsif 1-dən maksimuma qədər tam bal verir):

| Meyar | Maks. |
|---|---|
| Təqdimat qabiliyyəti | 5 |
| Komandanın qabiliyyəti | 10 |
| Biznes Model | 10 |
| Məhsul-Bazar uyğunluğu | 10 |
| Bazar | 10 |
| Təsir qabiliyyəti | 5 |

- **Bərabərlik:** yekun bal bərabərdirsə, əvvəlcə Demo Day balı yüksək olan komanda öndə gedir. O da bərabərdirsə, maksimumu yüksək olan meyarların orta balı müqayisə olunur (Komanda → Biznes → Məhsul-Bazar → Bazar → Təqdimat → Təsir). Tam bərabərlikdə yer paylaşılır.
- **Giriş balı yekuna daxil edilməsin** deyirsinizsə: Quraşdırma → "Yekun balın hesablanması" bölməsindəki açarı söndürün. Reytinq dərhal yalnız Demo Day balı ilə qurulur.
- **Giriş balları admin və münsiflər üçün görünür.** Münsif panelində hər komandanın başlığında göstərilir. Başqa münsiflərin balları, Demo Day ortalaması, yekun və reytinq isə münsiflərə göndərilmir (`test/privacy.test.ts`).
- Meyarları, onların maksimumunu və giriş balının maksimumunu Quraşdırma səhifəsindən dəyişmək olar.

## Taymer necə inteqrasiya olunub

Köhnə "Pitch Deck Taymeri" (`docs/reference/pitch-deck-timer.html`) yalnız öz brauzerində işləyirdi. İndi taymerin vəziyyəti **serverdə** saxlanılır və bütün ekranlara eyni anda yayımlanır:

- Admin canlı paneldə komandanı səhnəyə çıxarır. Komandanın adı proyektor taymerində (dairənin altında, zalın arxasından oxunacaq böyüklükdə, layihə adı ilə birlikdə), münsiflərin telefonundakı "Səhnədə" şeridində və admin panelində eyni anda görünür.
- Kursor taymer dairəsinin üzərinə gələndə dairə avtomatik fırlanır və 3D yırğalanır. Kursor çıxanda yumşaq şəkildə tam dövrəni tamamlayıb dayanır. Rəqəmlər bu zaman da düz qalır. "Hərəkəti azalt" sistem ayarı açıq olanda animasiya söndürülür.
- **Pitch → Sual-cavab → Vaxt bitdi** keçidi avtomatikdir (3:00 + 2:00, müddət Quraşdırmada dəyişdirilə bilər). Fasilə və davam etmə dəstəklənir.
- Bütün cihazlar serverin saatına görə hesablayır (`serverNow`). Proyektor, münsif telefonu və admin noutbuku eyni saniyəni göstərir.
- Komanda adları **Quraşdırma** səhifəsində və ya canlı paneldə "Adı dəyiş" düyməsi ilə dəyişdirilir. Dəyişiklik bütün ekranlarda dərhal yenilənir.
- `/timer` səhifəsini istənilən cihaz girişsiz aça bilər. O, yalnız səhnə və taymer məlumatını görür, heç bir bal görmür. **v3: proyektorda idarə düymələri yoxdur — admin sessiyası ilə açılanda belə.** İdarə yalnız canlı paneldən (`/admin`, Səhnə bölməsi; orada Space/Q/R/N qısayolları qalır) və pultdan (`/admin/pult`). Proyektorda qalan klaviatura:

| Düymə | Funksiya |
|---|---|
| ← / → , PageUp / PageDown | slayd (klikker; yalnız həmin təşkilatın admin sessiyası ilə) |
| F | Tam ekran |
| M | Səs |

Səs siqnalları orijinaldakı kimidir: son 5 saniyədə tik, pitch bitəndə keçid melodiyası, vaxt bitəndə 3 dəfə həyəcan siqnalı. Brauzer səsi yalnız ilk toxunuşdan sonra açır. Proyektorda bir dəfə "Səs" düyməsinə basın.

## Nəticə açıqlaması (`/reveal`)

1. Proyektorda `/reveal` səhifəsini açın və **F** ilə tam ekran edin. Proyektorda düymə yoxdur — açıqlamanı canlı paneldən (Nəticələr) və ya pultdan idarə edin. Səs üçün ekrana bir dəfə toxunun. İcazə verilənə qədər ekranda yalnız "Nəticələr tezliklə açıqlanacaq" yazısı görünür.
2. Canlı paneldəki **Nəticə açıqlaması** kartında **"Açıqlamaya icazə ver"** düyməsini basıb təsdiqləyin. Düymə yaşıl ✓ olur, qiymətləndirmə avtomatik bağlanır və həmin anın reytinqi qeydə alınır. Açıqlama bu siyahı ilə gedir, sonradan heç nə dəyişə bilməz.
3. **"Sıradakını açıqla →"** düyməsi hər basılanda ekranda bir yer açılır: sonuncu yerdən başlayaraq yuxarıya. Kartda növbəti komanda yalnız sizə görünür.
4. **İlk üçlük iki addımla açılır:**
   - birinci basış böyük yer nömrəsini göstərir (sakit, yumşaq animasiya);
   - ikinci basış komandanın adını, layihəsini və balını açır.
   1-ci yer üçün təmkinli konfetti. İntizar mətnləri, ürək döyüntüsü və fişəng yoxdur.
5. Səhv basılsa, **"← Geri"** düyməsindən istifadə edin. **"Sıfırla"** açıqlamanı əvvələ qaytarır və reytinqi yenidən qeydə alır. İcazəni söndürmək ekranı gözləmə rejiminə keçirir, irəliləyiş saxlanılır.

Proyektorda yalnız **F** (tam ekran) və **M** (səs) işləyir.

Gizlilik serverdə təmin olunur: ekrana yalnız artıq açıqlanmış yerlər göndərilir. İntizar addımında belə komandanın adı və balı göndərilmir, yalnız yer nömrəsi gedir (`test/reveal.test.ts`, `test/privacy.test.ts`).

## Tez başlanğıc (lokal)

```bash
npm install
cp .env.example .env        # ADMIN_PASSWORD və SESSION_SECRET dəyərlərini yazın
npm run build               # frontend + server
npm start                   # http://localhost:3000
```

İnkişaf rejimi (avtomatik yenilənmə): `npm run dev`. Frontend `http://localhost:5173`-də açılır, API isə 3000-də işləyir.

İlk açılışda admin hesabı `.env`-dəki `ADMIN_USERNAME` / `ADMIN_PASSWORD` dəyərlərindən yaradılır. Bununla yanaşı standart kriteriyalar və "Komanda 1–8" yer tutucuları da əlavə olunur. Münsiflər QR kodla qoşulur (aşağıya baxın).

## Münsif girişi: QR kod

Münsiflər üçün istifadəçi adı və şifrə yoxdur.

1. Canlı paneldə **"Münsif QR yarat"** düyməsini basın (və ya Quraşdırma → Münsiflər → **"Münsif əlavə et (QR)"**). Ekranda böyük QR açılır. Tam ekran düyməsi də var.
2. Ekranı münsifə yaxınlaşdırın. Münsif telefonun kamerası ilə skan edir, adını və soyadını yazır və dərhal münsif panelinə düşür.
3. Koordinatorun ekranında QR yerində "✓ <ad>" görünür. Ad canlı paneldə, matrisdə və hesabatlarda görünür. **"Növbəti münsif"** ilə ardıcıl QR paylaya bilərsiniz.

- QR **bir dəfə** işləyir və 24 saat etibarlıdır. Şəklini çəkən başqa biri onunla daxil ola bilməz.
- Münsifin telefonu dəyişsə, brauzeri təmizlənsə və ya əlaqə itsə: münsif kartındakı **QR / "Yeni QR"** düyməsi **eyni hesab** üçün yeni kod yaradır. Köhnə istifadə olunmamış QR etibarsız olur, münsifin bütün balları yerində qalır.
- Panel `localhost` ünvanında açılıbsa, QR pəncərəsi xəbərdarlıq edir: münsif telefonları həmin ünvana çata bilməz. Paneli server ünvanı ilə açın.
- Münsif şifrə ilə daxil ola bilməz (`/login` yalnız koordinator üçündür).

## Münsif paneli və canlı izləmə

- **Sürətli rəy çipləri:** münsif "Güclü texnologiya", "Rəqabət riski" kimi hazır etiketləri bir toxunuşla seçir. Siyahını Quraşdırma → "Sürətli rəy etiketləri" bölməsində dəyişirsiniz. Seçilənlər münsifin şəxsi qeydi kimi saxlanılır, admin matrisində, Excel-də (ayrıca sütun) və PDF-də görünür.
- **Canlı gedişat:** münsif bal seçdikcə admin kartında "Doldurur… 4 / 6 meyar" görünür. Serverə yalnız doldurulmuş meyarların **sayı** gedir, bal dəyərləri göndərilənə qədər heç kimə getmir.
- **Xəbərdar et:** canlı paneldəki "Səs verməyənləri xəbərdar et" düyməsi səhnədəki komandaya hələ səs verməmiş münsiflərin telefonunda banner göstərir və telefonu titrədir.
- **Komanda lentləri:** münsif panelinin yuxarısında bütün komandalar üfüqi lent kimi düzülür (göndərildi ✓ / qaralama / səhnədə). "Əvvəlki komanda" və "Sıfırla" düymələri də var.
- Canlı paneldə klaviatura qısayolları işləyir: **Space** başlat/fasilə, **Q/S** sual-cavab, **R** sıfırla, **N** növbəti komanda.

## Server (Docker) ilə deploy

```bash
cp .env.example .env
# .env: ADMIN_PASSWORD, SESSION_SECRET (openssl rand -hex 32), ORIGIN=https://sizin-domen.az
# Caddyfile: domeni dəyişin
docker compose --profile caddy up -d --build
```

- SQLite bazası `./data/ignite.db` faylındadır (volume).
- Sağlamlıq yoxlaması: `GET /api/health`.
- Caddy HTTPS sertifikatını avtomatik alır. WebSocket də avtomatik ötürülür. nginx istifadə edirsinizsə, `nginx.conf` nümunəsinə baxın (Upgrade başlıqları vacibdir).
- Proxy olmadan yalnız lokal şəbəkədə işlədəcəksinizsə: `docker-compose.yml`-də portu `"3000:3000"` edin, `.env`-də `ORIGIN` boş qalsın və `TRUST_PROXY=false` yazın. HTTPS olmadığı üçün `COOKIE_SECURE` avtomatik söndürülür.

### Mühit dəyişənləri

| Dəyişən | Təsvir | Standart |
|---|---|---|
| `PORT` | Server portu | 3000 |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Platforma sahibinin (root) hesabı (yalnız ilk açılışda istifadə olunur) | admin / — |
| `SESSION_SECRET` | Cookie imzası üçün gizli açar (production-da məcburidir) | — |
| `ORIGIN` | İcazəli ünvan(lar), vergüllə. Boş olarsa yalnız eyni host qəbul olunur | — |
| `SHOW_JUROR_TOTAL` | Münsif öz yekun balını görsün (bazanın ilk açılışında tətbiq olunur, sonra Quraşdırmadan dəyişdirilir) | false |
| `MIN_JURORS_FOR_RANK` | Bundan az münsif qiymətləndiribsə, reytinqdə "eksik" etiketi görünür | 3 |
| `TRUST_PROXY` | Proxy arxasında real IP üçün | true |
| `LOG_LEVEL` | `info` sorğu loglarını açır | warn |
| `MAX_UPLOAD_MB` | Prezentasiya faylının maksimum ölçüsü | 50 |
| `SOFFICE` | LibreOffice yolu (boş olarsa PATH-da `soffice` axtarılır; tapılmasa PPTX çevrilmir) | avtomatik |
| `BOOTSTRAP_ORG_SLUG`, `BOOTSTRAP_ORG_NAME`, `BOOTSTRAP_COORD_USERNAME`, `BOOTSTRAP_COORD_HASH_B64` | Təşkilat + koordinatoru bir dəfəlik yaratmaq ([bootstrap](#demomüştəri-koordinatorunu-env-ilə-yaratmaq-bootstrap)) | — |

### Əmrlər

| Əmr | Nə edir |
|---|---|
| `npm run seed` | Admin, kriteriyalar və yer tutucu komandalar (təkrar işlətmək təhlükəsizdir, münsif yaratmır) |
| `npm run backup` | `data/backups/ignite-<vaxt>.db` — server işləyərkən də təhlükəsizdir |
| `npm test` | Unit + gizlilik testləri |
| `npm run typecheck` | Server və frontend tip yoxlaması |

Docker daxilində: `docker compose exec app node dist-server/server/backup.js`.

## Canlı server (Coolify) və avtomatik yenilənmə

Tətbiq serverdə Coolify layihəsi **Ignite Demo Day** → tətbiq **demoday-mark** kimi işləyir (Dockerfile, port `2233 → 3000`).

- **Avtomatik deploy:** serverdəki `demoday-autodeploy.timer` hər dəqiqə GitHub-dakı `main` budağını yoxlayır. Yeni commit görəndə əvvəlcə bazanın yedəyini alır, sonra Coolify-da deploy başladır. GitHub-da webhook qurmağa ehtiyac yoxdur. Push-dan saytda görünənə qədər təxminən 3–4 dəqiqə keçir (1 dəq yoxlama + build).
- **Səhvə qarşı qoruma:** Docker build zamanı tip yoxlaması və bütün testlər işləyir. Biri uğursuz olsa, image yaranmır və köhnə versiya işləməyə davam edir.
- **Qısa fasilə:** port birbaşa hosta bağlı olduğu üçün Coolify köhnə konteyneri dayandırıb yenisini başladır (bir neçə saniyə). Münsiflərin qaralamaları itmir və bağlantı özü bərpa olunur. Yenə də canlı qiymətləndirmə zamanı push etməyin.
- **Baza:** Coolify-ın davamlı yaddaşında (`/app/data`) saxlanılır və deploy-lar onu silmir.
- **Yedəklər:** hər deploy-dan əvvəl və hər gecə 03:30-da alınır. Həm volume içində (`/app/data/backups`), həm də serverdə `/root/demoday-backups/` qovluğunda saxlanılır (son 30).
  - Əl ilə yedək: `demoday-backup`
  - Deploy loqları: `journalctl -u demoday-autodeploy -n 50`
- **Yedəkdən bərpa:** Coolify-da tətbiqi dayandırın. Sonra yedək faylını volume-dakı `ignite.db` faylının yerinə köçürün (`-wal` / `-shm` fayllarını silin) və tətbiqi yenidən başladın.

## Tədbir günü yoxlama siyahısı

**Bir gün əvvəl**
- [ ] `.env`: güclü `ADMIN_PASSWORD`, təsadüfi `SESSION_SECRET`, düzgün `ORIGIN`.
- [ ] Quraşdırma: tədbirin adı və tarixi, 8 komandanın adı və layihəsi, sıra.
- [ ] Quraşdırma → "Brend / prefiks" (məs. Ignite) və sürətli rəy etiketləri.
- [ ] Münsiflər gələndə hər biri üçün "Münsif QR yarat" → münsif skan edib adını yazır.
- [ ] Meyarlar və maksimum ballar düzgündür (cəmi 50), hər komandanın giriş balı yazılıb.
- [ ] Tam prova (aşağıdakı ssenari), sonra **Canlı panel → Təhlükəli zona → Bütün qiymətləri sil**.
- [ ] `npm run backup`.

**Tədbirdən əvvəl (30 dəq)**
- [ ] Proyektor noutbukunda `/timer` açın, admin kimi daxil olun, **F** ilə tam ekran edin, "Səs" ilə səsi yoxlayın.
- [ ] Koordinator noutbukunda `/admin`.
- [ ] Münsiflər telefonda daxil olur. Canlı paneldə 5 yaşıl nöqtə görünməlidir.
- [ ] Telefonların enerjiyə qənaət rejimi söndürülsün (ekran avtomatik sönməsin; sistem Wake Lock da istəyir).

**Tədbir zamanı**
- Komandanı seçin → **Pitch · 3:00** (və ya proyektorda Space). Pitch bitəndə sual-cavab özü başlayır.
- Münsif kartlarında "Gözləyir" qalan varsa, növbəti komandaya keçməzdən əvvəl xəbərdar edin.
- **Növbəti komanda** taymeri sıfırlayır, münsiflərin forması avtomatik yeni komandaya keçir.

**Sonda**
- [ ] İrəliləyiş 40/40 → **Qiymətləndirməni bağla**.
- [ ] **Nəticə açıqlaması** kartı → icazə verin → addım-addım açıqlayın.
- [ ] Excel və PDF yükləyin, PDF-i münsiflərə imzalatın.
- [ ] `npm run backup`.

## Manual qəbul ssenarisi

1. 5 münsif telefonu və 1 admin noutbuku ilə 8 komandanın hamısı üçün prova edin.
2. Bir münsif formu doldurarkən Wi-Fi-ı söndürür və "Göndər"ə basır. "Göndərilmədi, qaralama saxlanılıb" mesajı çıxmalıdır. Wi-Fi qayıdanda qaralama avtomatik göndərilir (səhifə yenilənsə belə itmir).
3. Kilidi açın və bağlayın: münsif forması dərhal salt oxunur olmalıdır.
4. Excel və PDF-də "ə" və "Ə" hərfləri düzgün görünməlidir (məs. münsif adı "Əli").
5. Münsif telefonunda başqa münsifin balı, ortalama və reytinq heç yerdə görünməməlidir.

## Arxitektura

```
shared/      scoring.ts (bal hesablaması, saf funksiya) · timer.ts (taymer riyaziyyatı) · types.ts
server/      Fastify + Socket.IO + better-sqlite3
  app.ts     hook-lar (sessiya, Origin yoxlaması), səhifələr, statik fayllar
  orgs.ts    təşkilatlar: Orgs (CRUD) və Scope (təşkilatın repo/trepo/rt/teams-i)
  bootstrap.ts BOOTSTRAP_* env ilə təşkilat + koordinator
  realtime.ts  otaqlar: o<org>:public · o<org>:jurors · juror:<id> · o<org>:admin · team:<id>
  views.ts   münsif cavabı yalnız öz sətirlərindən yığılır (gizlilik sərhədi)
  routes/    auth · juror · admin · team (komanda girişi, yükləmə) · stage (materiallar, səhnə rejimi/slayd) · root (təşkilatlar)
  teamrepo.ts · teams.ts · files.ts   munsif.im: komandalar, bildirişlər, fayl yoxlaması, PPTX→PDF
  export/    xlsx.ts (exceljs) · pdf.ts (pdfkit + gömülü TTF)
web/         Vite + vanilla TS, tək styles.css (token sistemi)
assets/fonts Manrope, Unbounded, JetBrains Mono, Noto Sans
test/        scoring · privacy · team · orgs · orgs-migration · munsif-migration · history · migration …
             fixtures/legacy-acf187a — əvvəlki buraxılışın data qatı (köhnə bazanı köhnə kodla yazmaq üçün)
scripts/     hash-password.mjs (BOOTSTRAP_COORD_HASH_B64) · import-landing.mjs
assets/landing  munsif.im landing (scripts/import-landing.mjs ilə ~/projects/munsif-landing/dist-dən gəlir)
assets/brand    munsif.im loqoları
```

**Gizlilik serverdə təmin olunur:** münsif sessiyası ilə `/api/admin/*` 403 qaytarır. `GET /api/juror/state` yalnız münsifin öz ballarını qaytarır (`SHOW_JUROR_TOTAL=false` olanda öz yekununu da qaytarmır). Münsif socket-i yalnız `public`, `jurors` (kilid xəbəri) və öz `juror:<id>` otağına qoşulur. Bunların hamısı `test/privacy.test.ts`-də yoxlanılır.

**Təhlükəsizlik:** argon2id şifrələr, imzalı httpOnly + SameSite=Lax cookie (HTTPS-də Secure), admin, münsif və komanda üçün ayrı cookie (`ij_admin`, `ij_juror`, `ij_team`), sessiya 7 gün, bazada yalnız sessiya tokeninin SHA-256 heşi saxlanılır, POST/PUT/PATCH/DELETE və WebSocket üçün Origin yoxlaması, girişdə IP + istifadəçi adı üzrə 5 uğursuz cəhd → 5 dəq blok. Hamı eyni Wi-Fi-dan (eyni IP) gəldiyi üçün blok yalnız IP-yə görə deyil, IP + istifadəçi adına görə qoyulur. Şifrə sıfırlananda və ya münsif deaktiv ediləndə onun bütün sessiyaları bağlanır.

## İlkin tapşırıqdan fərqlər (qəsdən)

- **Taymer modeli:** `event` cədvəlində `phase_kind / phase_started_at / phase_duration_sec` əvəzinə `timer_visible, timer_running, timer_offset_sec, timer_anchor_at, pitch_sec, qa_sec` sahələri var. Səbəb: inteqrasiya olunan taymer fasilə/davam etməni və pitch-dən sual-cavaba avtomatik keçidi dəstəkləyir. Bunu tək "başlama vaxtı" sahəsi ilə ifadə etmək olmur.
- **Node 22** (Docker image): Node 20-nin dəstəyi 2026-cı ilin aprelində bitib.
- **Noto Sans** əlavə şrift kimi: Manrope-da böyük "Ə" (U+018F) hərfi yoxdur. PDF-də və ekranda yalnız bu hərf Noto Sans ilə çap olunur.
- **SameSite=Lax** (Strict əvəzinə): Strict olanda linki Telegram/WhatsApp-dan açan münsif hər dəfə login səhifəsinə düşürdü. Lax ilə başqa saytdan gələn POST sorğusu yenə cookie daşımır, bütün yazma sorğuları əlavə olaraq Origin ilə yoxlanılır.
- **Admin və münsif sessiyaları ayrıdır:** eyni brauzerdə hər ikisi açıq qala bilər. Səhifəni yeniləmək və ya münsif kimi çıxmaq admin sessiyasına toxunmur.
- PDF-dəki kriteriya cədvəlində sütun başlıqları K1–K8 kodları ilə verilir, açıqlaması cədvəlin altındadır (A4 enində 8 tam ad sığmır).

## P1 vəziyyəti

| Tapşırıq | Vəziyyət |
|---|---|
| Aktiv sessiyaları bağlamaq | Hazırdır (Quraşdırma → münsif → "Sessiyaları bağla") |
| Audit log | API hazırdır (`GET /api/admin/audit`), ekranı yoxdur |
| Nəticə açıqlama ekranı | Hazırdır: `/reveal` + canlı paneldəki idarə kartı |
| Komandaya xüsusi anonim rəy PDF-i | Edilməyib |

## Problemlərin həlli

| Əlamət | Səbəb və həll |
|---|---|
| "Sorğu mənbəyi təsdiqlənmədi (Origin)" | `.env`-də `ORIGIN` brauzerdəki ünvanla eyni deyil (http/https, port, domen). |
| Girişdən sonra yenə login səhifəsi | HTTP üzərindən açılıb, amma cookie Secure-dur. HTTPS istifadə edin və ya `COOKIE_SECURE=false` yazın (yalnız lokal şəbəkə). |
| "Bağlantı yoxdur" pill-i | Wi-Fi və ya proxy WebSocket-i ötürmür. nginx-də `Upgrade`/`Connection` başlıqlarını yoxlayın. Qaralamalar itmir. |
| "Çox sayda uğursuz cəhd" | 5 dəqiqə gözləyin və ya serveri yenidən başladın (blok yaddaşda saxlanılır). |
| Münsif çıxıb / telefonu dəyişib / QR işləmir | Canlı panel və ya Quraşdırma → həmin münsif → "Yeni QR". Ballar qorunur. |
| Proyektorda səs yoxdur | Səhifədə bir dəfə klikləyin və ya "Səs" düyməsinə basın (brauzer qaydası). |
| `docker build` zamanı "Temporary failure resolving 'deb.debian.org'" | Docker konteynerində DNS işləmir. `docker build --network=host -t ignite-jury .` ilə build edin və ya Docker daemon-un DNS ayarlarını düzəldin. |
| Admin (root) şifrəsini unutmusunuz | `data/` qovluğunun yedəyini alın, `users` cədvəlindən `is_root = 1` sətrini silin, serveri `.env`-dəki yeni `ADMIN_PASSWORD` ilə yenidən başladın. |
| Koordinator şifrəsini unudub | Root: `/root` → təşkilat → Koordinatorlar → “Şifrə”. |
| `/o/<slug>/stage` 404 verir | Təşkilat deaktivdir və ya slug səhvdir (`/root`-da yoxlayın). |
| Ekranda “Yenidən qoşulur…” | Şəbəkə kəsilib; socket özü yenidən qoşulur (0.5 s → 5 s backoff) və qoşulan kimi vəziyyəti tam yeniləyir. Proyektor əlavə olaraq hər 60 s vəziyyəti özü yoxlayır. |
