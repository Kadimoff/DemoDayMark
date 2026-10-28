# Ignite Demo Day — münsif sistemi + pitch taymeri

Real vaxtda münsif qiymətləndirməsi və səhnə taymeri. 8 komanda, 4–5 münsif, hər komanda üçün 3 dəq pitch + 2 dəq sual-cavab.

| Ekran | Ünvan | Kim üçün |
|---|---|---|
| Giriş | `/login` | hamı |
| Münsif paneli | `/juror` | münsiflər (telefon) |
| Canlı panel | `/admin` | koordinator (noutbuk) |
| Quraşdırma | `/admin/setup` | koordinator |
| **Proyektor taymeri** | `/timer` | səhnə ekranı (girişsiz baxış; admin girişi ilə idarə) |

## Taymer necə inteqrasiya olunub

Köhnə "Pitch Deck Taymeri" (`docs/reference/pitch-deck-timer.html`) yalnız öz brauzerində işləyirdi. İndi taymerin vəziyyəti **serverdə** saxlanılır və bütün ekranlara eyni anda yayımlanır:

- Admin canlı paneldə komandanı səhnəyə çıxarır. Komandanın adı proyektor taymerində (dairənin altında, zalın arxasından oxunacaq böyüklükdə, layihə adı ilə birlikdə), münsiflərin telefonundakı "Səhnədə" şeridində və admin panelində eyni anda görünür.
- Kursor taymer dairəsinin üzərinə gələndə dairə avtomatik fırlanır və 3D yırğalanır. Kursor çıxanda yumşaq şəkildə tam dövrəni tamamlayıb dayanır. Rəqəmlər bu zaman da düz qalır. "Hərəkəti azalt" sistem ayarı açıq olanda animasiya söndürülür.
- **Pitch → Sual-cavab → Vaxt bitdi** keçidi avtomatikdir (3:00 + 2:00, müddət Quraşdırmada dəyişdirilə bilər). Fasilə və davam etmə dəstəklənir.
- Bütün cihazlar serverin saatına görə hesablayır (`serverNow`). Proyektor, münsif telefonu və admin noutbuku eyni saniyəni göstərir.
- Komanda adları **Quraşdırma** səhifəsində və ya canlı paneldə "Adı dəyiş" düyməsi ilə dəyişdirilir. Dəyişiklik bütün ekranlarda dərhal yenilənir.
- `/timer` səhifəsini istənilən cihaz girişsiz aça bilər. O, yalnız səhnə və taymer məlumatını görür, heç bir bal görmür. Admin kimi daxil olmuş brauzerdə həmin səhifədə idarə düymələri və klaviatura qısayolları da görünür:

| Düymə | Funksiya |
|---|---|
| Space | Başlat / fasilə |
| S və ya Q | Dərhal sual-cavaba keç |
| R | Sıfırla (3:00, hazır) |
| N | Növbəti komanda |
| F | Tam ekran |

Səs siqnalları orijinaldakı kimidir: son 5 saniyədə tik, pitch bitəndə keçid melodiyası, vaxt bitəndə 3 dəfə həyəcan siqnalı. Brauzer səsi yalnız ilk toxunuşdan sonra açır. Proyektorda bir dəfə "Səs" düyməsinə basın.

## Tez başlanğıc (lokal)

```bash
npm install
cp .env.example .env        # ADMIN_PASSWORD və SESSION_SECRET dəyərlərini yazın
npm run build               # frontend + server
npm start                   # http://localhost:3000
```

İnkişaf rejimi (avtomatik yenilənmə): `npm run dev`. Frontend `http://localhost:5173`-də açılır, API isə 3000-də işləyir.

İlk açılışda admin hesabı `.env`-dəki `ADMIN_USERNAME` / `ADMIN_PASSWORD` dəyərlərindən yaradılır. Bununla yanaşı standart kriteriyalar və "Komanda 1–8" yer tutucuları da əlavə olunur. Münsif hesablarını **Quraşdırma** səhifəsindən siz yaradırsınız.

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
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Admin hesabı (yalnız ilk açılışda istifadə olunur) | admin / — |
| `SESSION_SECRET` | Cookie imzası üçün gizli açar (production-da məcburidir) | — |
| `ORIGIN` | İcazəli ünvan(lar), vergüllə. Boş olarsa yalnız eyni host qəbul olunur | — |
| `SHOW_JUROR_TOTAL` | Münsif öz yekun balını görsün (bazanın ilk açılışında tətbiq olunur, sonra Quraşdırmadan dəyişdirilir) | false |
| `MIN_JURORS_FOR_RANK` | Bundan az münsif qiymətləndiribsə, reytinqdə "eksik" etiketi görünür | 3 |
| `TRUST_PROXY` | Proxy arxasında real IP üçün | true |
| `LOG_LEVEL` | `info` sorğu loglarını açır | warn |

### Əmrlər

| Əmr | Nə edir |
|---|---|
| `npm run seed` | Admin, kriteriyalar və yer tutucu komandalar (təkrar işlətmək təhlükəsizdir, münsif yaratmır) |
| `npm run backup` | `data/backups/ignite-<vaxt>.db` — server işləyərkən də təhlükəsizdir |
| `npm test` | Unit + gizlilik testləri |
| `npm run typecheck` | Server və frontend tip yoxlaması |

Docker daxilində: `docker compose exec app node dist-server/server/backup.js`.

## Tədbir günü yoxlama siyahısı

**Bir gün əvvəl**
- [ ] `.env`: güclü `ADMIN_PASSWORD`, təsadüfi `SESSION_SECRET`, düzgün `ORIGIN`.
- [ ] Quraşdırma: tədbirin adı və tarixi, 8 komandanın adı və layihəsi, sıra.
- [ ] 5 münsif hesabı (ad, istifadəçi adı, şifrə). Giriş məlumatlarını kağızda hər münsifə ayrıca verin.
- [ ] Kriteriyaların çəki cəmi 100%.
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
  realtime.ts  otaqlar: public · jurors · juror:<id> · admin
  views.ts   münsif cavabı yalnız öz sətirlərindən yığılır (gizlilik sərhədi)
  routes/    auth · juror · admin
  export/    xlsx.ts (exceljs) · pdf.ts (pdfkit + gömülü TTF)
web/         Vite + vanilla TS, tək styles.css (token sistemi)
assets/fonts Manrope, Unbounded, JetBrains Mono, Noto Sans
test/        scoring.test.ts · privacy.test.ts
```

**Gizlilik serverdə təmin olunur:** münsif sessiyası ilə `/api/admin/*` 403 qaytarır. `GET /api/juror/state` yalnız münsifin öz ballarını qaytarır (`SHOW_JUROR_TOTAL=false` olanda öz yekununu da qaytarmır). Münsif socket-i yalnız `public`, `jurors` (kilid xəbəri) və öz `juror:<id>` otağına qoşulur. Bunların hamısı `test/privacy.test.ts`-də yoxlanılır.

**Təhlükəsizlik:** argon2id şifrələr, imzalı httpOnly + SameSite=Lax cookie (HTTPS-də Secure), admin və münsif üçün ayrı cookie (`ij_admin`, `ij_juror`), sessiya 7 gün, bazada yalnız sessiya tokeninin SHA-256 heşi saxlanılır, POST/PUT/PATCH/DELETE və WebSocket üçün Origin yoxlaması, girişdə IP + istifadəçi adı üzrə 5 uğursuz cəhd → 5 dəq blok. Hamı eyni Wi-Fi-dan (eyni IP) gəldiyi üçün blok yalnız IP-yə görə deyil, IP + istifadəçi adına görə qoyulur. Şifrə sıfırlananda və ya münsif deaktiv ediləndə onun bütün sessiyaları bağlanır.

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
| Nəticə açıqlama ekranı `/admin/reveal` | Edilməyib |
| Komandaya xüsusi anonim rəy PDF-i | Edilməyib |

## Problemlərin həlli

| Əlamət | Səbəb və həll |
|---|---|
| "Sorğu mənbəyi təsdiqlənmədi (Origin)" | `.env`-də `ORIGIN` brauzerdəki ünvanla eyni deyil (http/https, port, domen). |
| Girişdən sonra yenə login səhifəsi | HTTP üzərindən açılıb, amma cookie Secure-dur. HTTPS istifadə edin və ya `COOKIE_SECURE=false` yazın (yalnız lokal şəbəkə). |
| "Bağlantı yoxdur" pill-i | Wi-Fi və ya proxy WebSocket-i ötürmür. nginx-də `Upgrade`/`Connection` başlıqlarını yoxlayın. Qaralamalar itmir. |
| "Çox sayda uğursuz cəhd" | 5 dəqiqə gözləyin və ya serveri yenidən başladın (blok yaddaşda saxlanılır). |
| Münsif şifrəsini unudub | Quraşdırma → həmin münsif → "Yeni şifrə" → "Təyin et". |
| Proyektorda səs yoxdur | Səhifədə bir dəfə klikləyin və ya "Səs" düyməsinə basın (brauzer qaydası). |
| `docker build` zamanı "Temporary failure resolving 'deb.debian.org'" | Docker konteynerində DNS işləmir. `docker build --network=host -t ignite-jury .` ilə build edin və ya Docker daemon-un DNS ayarlarını düzəldin. |
| Admin şifrəsini unutmusunuz | `data/` qovluğunun yedəyini alın, `users` cədvəlindən admin sətrini silin, serveri `.env`-dəki yeni `ADMIN_PASSWORD` ilə yenidən başladın. |
