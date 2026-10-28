# Ignite Demo Day — Jüri Değerlendirme Sistemi
### Claude Code için proje promptu

> Bu dosyayı projenin köküne `PROMPT.md` olarak koy, referans tasarımı `docs/reference/ignite-jury.html` yoluna kopyala ve Claude Code'a şunu yaz:
> **"PROMPT.md dosyasını ve docs/reference/ignite-jury.html dosyasını oku, önce planını ve klasör yapını göster, onayımdan sonra P0 fazını uygula."**

> **Ek istek (Kadim):** Klasördeki Pitch Deck timer'ı da sisteme entegre et. Timer'da sahnedeki takımın adı görünür; aynı takım ve süre jüri panelinde timer ile birlikte gösterilir. Takım adları admin panelden değiştirilebilir. Orijinal timer: `docs/reference/pitch-deck-timer.html`.

---

## 0. Rolün ve bağlam

Sen kıdemli bir full-stack mühendis ve ürün tasarımcısısın. ADNSU'daki **Ignite** inkübasyon programının Demo Day etkinliği için gerçek zamanlı bir jüri değerlendirme sistemi kuruyorsun. Ben (Kadim) program koordinatörüyüm, projeyi yönetiyorum ve her fazda onay vereceğim.

**Etkinlik formatı:**
- 8 takım sırayla sahneye çıkıyor.
- Her takım için 3 dakika pitch, 2 dakika soru-cevap ve MVP demosu var.
- 4 ya da 5 jüri üyesi her takımı kendi cihazından (çoğunlukla telefon) puanlıyor.
- Sistemin sonunda takımlar jüri ortalamasına göre sıralanmalı ve sonuç Excel ve PDF olarak alınabilmeli.

**Zaman kısıtı:** Etkinlik çok yakın. Önce **P0** fazını eksiksiz ve sağlam bitir, sonra P1'e geç. Her fazın sonunda çalışan bir sürüm olsun.

**Arayüz dili:** Tüm kullanıcı metinleri **Azerbaycan Türkçesi** olmalı (ə, ğ, ı, ö, ü, ş, ç karakterleri her yerde doğru görünmeli: ekranda, Excel'de ve PDF'te). Kod, yorumlar ve commit mesajları İngilizce olabilir.

---

## 1. Referans tasarım

`docs/reference/ignite-jury.html` dosyası tek dosyalık çalışan bir prototip. Bu dosyadan şunları **birebir koru ve geliştir**:
- Tasarım dili: renk token'ları, Unbounded (display) + Manrope (gövde) + JetBrains Mono (rakamlar) font üçlüsü, kart/çip/şalter bileşenleri.
- Üstte sabit "Səhnədə" (sahnede) şeridi ve paylaşılan geri sayım (Pitch 3:00 / Sual-cavab 2:00; son 30 saniyede uyarı rengi, sürede bitince yanıp sönme).
- Jüri formu: kriter başına 1–10 segmentli butonlar, "zəif / orta / güclü / əla" bant etiketleri, yorum alanı, alttaki sabit gönder çubuğu.
- Değerlendirme kriterleri ve ağırlıkları (bölüm 4).
- Puanlama formülü ve eşitlik bozma kuralı.
- Liderlik tablosu, jüri × takım matrisi, kriter ısı haritası tablosu.
- PDF protokolünün içeriği: kazanan kutusu, sıralama, matris, kriter ortalamaları, yorumlar, jüri imza satırları.

**Değişen şey mimari:** Prototipteki claude.ai veritabanı yerine kendi sunucum, rol tabanlı giriş ve gerçek zamanlı yayın kullanılacak.

---

## 2. Rol ve gizlilik kuralları (en önemli bölüm)

Gizlilik kuralları **sunucu tarafında** uygulanmalı. Yalnızca arayüzde gizlemek yeterli değil.

### Admin (koordinatör, tek hesap)
- Admin şifresi ilk kurulumda `.env` dosyasındaki `ADMIN_PASSWORD` değerinden hash'lenerek oluşturulur.
- Takımları, jürileri ve kriterleri yönetir.
- **Her jürinin kullanıcı adını ve şifresini kendisi belirler.** Şifreyi sıfırlayabilir, jüriyi pasifleştirebilir.
- Aktif jüri oturumlarını görebilir ve bir oturumu zorla kapatabilir.
- Sahnedeki takımı seçer, zamanlayıcıyı başlatır ve durdurur.
- Değerlendirmeyi kilitler veya açar.
- **Her şeyi gerçek zamanlı izler:** hangi jüri hangi takımı puanladı, tek tek puanlar ve yorumlar, ortalamalar ve sıralama, mevcut takım için kimin henüz göndermediği.
- **Nihai skoru ve sıralamayı yalnızca admin görür.**
- Excel ve PDF dışa aktarımı yalnızca admin içindir.

### Jüri (5 ayrı hesap, her biri kendi girişiyle)
- Admin'in verdiği kullanıcı adı ve şifreyle girer.
- Yalnızca şunları görür: sahnedeki takım ve zamanlayıcı, takım listesi ve her takımda **kendi** gönderim durumu, **kendi** puan formu ve kendi önceki gönderimleri.
- **Başka jürilerin puanlarını, ortalamaları, sıralamayı ve hiçbir yekun skoru göremez.**
- Kendi ağırlıklı toplamını da görmez. Bunu `SHOW_JUROR_TOTAL=false` ayarıyla yönet; varsayılan değer `false` olmalı.
- Kilit açıkken kendi puanını düzenleyebilir. Kilitliyken sunucu her yazmayı reddeder.

### Sunucu tarafı garantileri
- Jüri rolüyle çağrılan hiçbir REST uç noktası veya socket olayı başka jürinin verisini, toplamları veya sıralamayı döndürmemeli.
- Socket.IO odaları ayrı olmalı: `admin` odası tüm olayları alır; `juror:<id>` odası yalnızca kendi verisini alır; `public` odası yalnızca sahne ve zamanlayıcı bilgisini alır.
- Bu kuralları kapsayan otomatik testler yaz (bölüm 10). Örnek: jüri token'ıyla `/api/admin/*` uç noktaları 403 dönmeli. Jüri socket'i başka bir jürinin `score:updated` olayını asla almamalı.

---

## 3. Teknoloji yığını

Basit, tek sunucuda çalışan ve kolay deploy edilen bir yapı kur. Daha iyi bir gerekçen varsa önce bana sor.

- **Backend:** Node.js 20 + TypeScript, Fastify (veya Express), Socket.IO.
- **Veritabanı:** SQLite (`better-sqlite3`, WAL modu). Migration için hafif bir çözüm kullan (Drizzle ORM veya düz SQL migration).
- **Kimlik doğrulama:** Şifreler `argon2id` (veya bcrypt cost 12) ile hash'lenir. Oturum bilgisi httpOnly + Secure + SameSite=Strict cookie ile tutulur. Durum değiştiren isteklerde Origin kontrolü yapılır. Girişte rate limit uygulanır: IP + kullanıcı başına, 5 başarısız denemeden sonra 5 dakika bekleme.
- **Frontend:** Vite + TypeScript. Ağır bir framework gerekmiyorsa vanilla TS + küçük bileşen fonksiyonları kullan. React tercih edersen gerekçesini yaz. CSS, referans HTML'deki token sistemini kullanan tek bir dosya olsun. Tailwind kullanma.
- **Dışa aktarım (sunucu tarafında):** Excel için `exceljs`. PDF için `pdfkit` + projeye gömülü **Manrope** ve **Unbounded** TTF dosyaları. Azerbaycan karakterleri bu fontlarla doğru basılmalı; "ə" mutlaka test edilmeli.
- **Deploy:** Çok aşamalı (multi-stage) `Dockerfile` ve `docker-compose.yml`. SQLite verisi bir volume'da tutulur. HTTPS ve WebSocket upgrade için örnek `Caddyfile` (tercih) ve `nginx.conf`.

---

## 4. Değerlendirme modeli

Kriterler admin panelinden düzenlenebilir. Varsayılan seed:

| id | Kriter (AZ) | Jüriye açıklama | Ağırlık |
|---|---|---|---|
| problem | Problem | Problem real və aktualdırmı? Kimin problemidir və nə qədər ağrılıdır? | 15 |
| solution | Həll və dəyər təklifi | Həll problemi birbaşa aradan qaldırırmı? Alternativlərdən nə ilə fərqlənir? | 15 |
| mvp | MVP / Demo | Məhsul işləyirmi? Demo inandırıcıdırmı, texniki icra hansı səviyyədədir? | 20 |
| market | Bazar və rəqabət | Hədəf seqment və bazar həcmi aydındırmı? Rəqiblər bilinirmi? | 10 |
| biz | Biznes model | Necə gəlir əldə edəcək? Qiymət, satış kanalları məntiqlidirmi? | 10 |
| traction | Validasiya və traction | İstifadəçi, pilot, müştəri müsahibəsi, niyyət məktubu — sübut varmı? | 10 |
| team | Komanda | Komanda bu işi həyata keçirə bilərmi? Bacarıqlar tamamlayırmı? | 10 |
| pitch | Təqdimat və sual-cavab | Vaxta sığdımı, aydın idimi? Suallara dəqiq və inamlı cavab verdimi? | 10 |

**Puanlama kuralları:**
- Her kriter 1–10 arası tam sayıdır. Tüm kriterler zorunludur.
- Bir jürinin bir takıma verdiği yekun puan: `Σ(puan × ağırlık) / Σ ağırlık × 10`, yani 100 üzerinden.
- Takım skoru, o takımı **tam** puanlamış jürilerin yekun puanlarının aritmetik ortalamasıdır.
- Sıralama ortalamaya göre azalan sırada yapılır.
- Eşitlikte sırasıyla en yüksek ağırlıklı kriterin ortalamasına bakılır (varsayılan MVP), ardından bir sonrakine.
- Puanı olmayan takım sıralamanın sonunda "—" olarak gösterilir.
- Hesaplama **tek bir saf fonksiyonda** (`scoring.ts`) yapılmalı ve unit testlerle kapsanmalı.
- Ayar: `MIN_JURORS_FOR_RANK`. Bir takım bu sayıdan az jüri puanı aldıysa sıralamada "eksik" etiketi gösterilir.

---

## 5. Veri modeli (SQLite)

- `users`: id, role (`admin` | `juror`), username (unique), display_name, password_hash, active, created_at
- `sessions`: id, user_id, created_at, last_seen_at, user_agent, ip
- `event`: tek satır. name, date, current_team_id, phase_kind (`pitch` | `qa` | null), phase_started_at, phase_duration_sec, locked, show_juror_total
- `teams`: id, order_index, name, project, active
- `criteria`: id, order_index, key, name, description, weight
- `scores`: id, juror_id, team_id, values_json, total, note, created_at, updated_at — `UNIQUE(juror_id, team_id)`
- `audit_log`: id, actor_id, action, payload_json, created_at — her puan gönderimi, puan değişikliği, kilit, sahne ve şifre değişikliği buraya yazılır.

**Zaman damgaları:** Sunucu saatini esas al. Zamanlayıcı için istemciye `serverNow` gönder, istemci saat farkını düzeltsin. Böylece tüm cihazlarda geri sayım aynı olur.

---

## 6. API ve gerçek zamanlı olaylar

Tüm girdileri `zod` ile doğrula. Hata mesajları Azerbaycanca ve anlaşılır olsun.

### REST
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
- **Jüri:** `GET /api/juror/state` → sahne, zamanlayıcı, takımlar, kriterler, kendi puanları; `PUT /api/juror/scores/:teamId` → kilit kontrolü yapılır, upsert edilir, audit kaydı düşülür
- **Admin:** CRUD `/api/admin/teams`, `/api/admin/jurors` (şifre belirleme ve sıfırlama dahil), `/api/admin/criteria`; `PATCH /api/admin/event` → sahne, faz, kilit; `GET /api/admin/results`; `GET /api/admin/export.xlsx`, `GET /api/admin/export.pdf`; `GET /api/admin/audit`; `DELETE /api/admin/scores` → onay token'ı ile

### Socket.IO
- **Bağlantı:** Bağlanırken cookie ile kimlik doğrulanır ve kullanıcı uygun odaya alınır.
- **`public` odası:** `stage:changed`, `timer:changed`
- **`juror:<id>` odası:** `my-score:saved`, `event:locked`
- **`admin` odası:** `score:upserted`, `presence:changed`, `results:changed`
- **Yeniden bağlanma:** İstemci yeniden bağlandığında tam durumu tekrar çekmeli.

---

## 7. Ekranlar

Mobil öncelikli; admin ekranı dizüstü ve projektör için geniş.

1. **Giriş (`/login`)** — Ignite markası, kullanıcı adı, şifre, "Daxil ol". Hatalı girişte net mesaj. Role göre yönlendirme.
2. **Jüri paneli (`/juror`)** — Referans form. Sahnedeki takım otomatik seçilir (kaydedilmemiş değişiklik varsa zorla değiştirilmez). Çiplerde ✓ ve "Səhnədə". Tüm kriterler dolmadan gönder pasif. "Göndərilir…" → "Göndərildi ✓". Ağ hatasında taslak `localStorage`'da, tekrar deneme. Kilitliyken salt okunur + uyarı şeridi. Wake Lock.
3. **Admin canlı paneli (`/admin`)** — Sahne kontrolü (takım ızgarası, "Növbəti komanda →", Pitch / Sual-cavab / Dayandır), mevcut takım için 5 jüri kartı (çevrimiçi noktası, gönderdi/bekliyor), FLIP animasyonlu canlı sıralama (ortalama, min–max, jüri sayısı), tıklanabilir jüri × takım matrisi, kriter ısı haritası, ilerleme çubuğu, kilit şalteri, dışa aktarım.
4. **Admin ayarları (`/admin/setup`)** — Etkinlik adı/tarihi; takımlar (ad, proje, sıra); jüriler (görünen ad, kullanıcı adı, şifre belirle/sıfırla, aktif/pasif, oturumları kapat); kriterler (ad, açıklama, ağırlık; toplam 100 değilse uyarı). Puan varken silmede uyarı.
5. **(P1) Sonuç açıklama ekranı (`/admin/reveal`)** — Projektör için tam ekran, 8'den 1'e açılış, 1. için ölçülü kutlama, yalnızca admin.

---

## 8. Tasarım ve tema

- Token yapısı korunur; literal renk yok.
- Light / dark / sistem: üç durumlu anahtar, `localStorage` + `<html data-theme>`; CSS sırası `:root` → `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` → `:root[data-theme="dark"]`; koyu temada `color-scheme: dark`; FOUC'u önleyen inline script.
- Kimlik: kor turuncusu `#DD4F18` / `#FF6F36`, mavi-gri nötrler, altın/gümüş/bronz; sahne şeridi iki temada da koyu.
- Hareket: FLIP sıralama, gönderim mikro animasyonu, sahne geçişi; `prefers-reduced-motion`.
- Erişilebilirlik: 44px dokunma hedefi, görünür `:focus-visible`, WCAG AA, `aria-pressed`, zamanlayıcıda `aria-live`.
- Kaçınılacaklar: emoji ikonlar, mor-mavi gradyan, her şeye aynı gölge ve köşe yuvarlaklığı.

---

## 9. Dışa aktarım

**Excel:** Reytinq, Münsif matrisi, Bütün qiymətlər, Kriteriyalar — kalın ve sabitlenmiş başlık, sayı formatı, ayarlı sütun genişlikleri.
**PDF (A4):** kazanan kutusu, sıralama, matris, kriter ortalamaları, yorumlar, jüri imza satırları; her sayfada etkinlik adı ve `n/m`.
**Dosya adı:** `Ignite_DemoDay_<tarih>_netice.xlsx`, `Ignite_DemoDay_<tarih>_protokol.pdf`.

---

## 10. Testler ve kabul kriterleri

- Unit: `scoring.ts` (ağırlık, ortalama, eşitlik bozma, eksik puan).
- Entegrasyon (Vitest + supertest + socket.io-client): jüri A, B'nin puanını alamaz; jüri rolüyle `/api/admin/*` 403; `results` hiçbir jüri yanıtında yok; kilitliyken PUT 423/409; 5 hatalı girişten sonra rate limit; admin socket'i 1 saniyeden kısa sürede `score:upserted` alır.
- Manuel: 5 jüri telefonu + 1 admin dizüstüyle 8 takım provası; Wi-Fi kapat/aç, taslak kaybolmaz; Excel ve PDF'te "ə".

---

## 11. Deploy ve işletim

- `.env.example`: `PORT`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `ORIGIN`, `SHOW_JUROR_TOTAL`, `MIN_JURORS_FOR_RANK`
- `docker compose up -d`, SQLite `./data`, `/api/health`.
- Caddy ve nginx örnekleri (WebSocket upgrade).
- `npm run backup`, `npm run seed` (jüri hesabı oluşturmaz).
- README: kurulum, deploy, etkinlik günü kontrol listesi, sorun giderme.

---

## 12. Fazlar

**P0:** giriş ve roller; jüri formu; admin canlı paneli (sahne, zamanlayıcı, matris, sıralama, kilit); ayarlar (takım, jüri ve şifre, kriter); Excel ve PDF; gizlilik testleri; Docker deploy.

**P1:** sonuç açıklama ekranı; audit log görünümü; aktif oturum yönetimi; takıma özel anonim geri bildirim PDF'i.

**Çalışma şekli:** her fazdan önce kısa plan ve dosya listesi; her fazdan sonra çalıştırılan testler ve deneme yolu; belirsiz kararlarda varsayımı açıkça belirt; geri dönüşü zor kararlarda önce sor.
