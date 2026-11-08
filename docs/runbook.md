# Tədbir günü runbook — munsif.im

Qısa, praktik: tədbirdən əvvəl nəyi yoxlamalı, tədbir zamanı nə baş verə bilər və necə həll olunur, tədbirdən sonra nə
etməli. Texniki fon: [reliability.md](reliability.md).

Əsas prinsip: **bal telefonda itmir.** Münsifin telefonu hər balı əvvəlcə öz yaddaşına yazır və server təsdiqləyənə qədər
özü təkrar göndərir. Server düşsə, Wi-Fi kəsilsə, telefon yatsa belə — bağlantı qayıdanda bal gedir. Panikaya ehtiyac yoxdur.

## 1. Tədbirdən əvvəl

### Bir gün əvvəl
- [ ] `https://munsif.im/api/health` açın: `"ok": true`, `"db": {"integrity": "ok"}`, `"warnings": []`.
- [ ] `/root` → **Sistem vəziyyəti**: "Qaydasındadır", son yedək bir neçə dəqiqə əvvəl. **İndi yedəklə** basın — yeni yedək görünməlidir.
- [ ] Quraşdırma: komandalar, sıra, meyarlar və maksimum ballar, pitch/sual-cavab müddəti, deadline.
- [ ] Bütün münsiflər üçün hesab + QR hazırdır (çap və ya ekranda).
- [ ] **Test münsifi** ilə tam prova: QR → ad → bir komandaya bal → koordinator panelində görünür. Sonra Wi-Fi-ı söndürüb
      bal verin: aşağıda **"Oflayn — növbədə"** görünməlidir; Wi-Fi-ı qaytarın → "Saxlanıldı". Proyektorda taymer, son 5 saniyə, reveal sınağı.
- [ ] Provadan sonra test ballarını silin (Canlı panel → Təhlükəli zona) və ya yeni tədbir yaradın.
- [ ] Coolify-da `SESSION_SECRET` sabitdir (dəyişsə hamı yenidən daxil olmalı olur). Tədbir zamanı **deploy etməyin**.

### Tədbirdən 30 dəqiqə əvvəl
- [ ] Proyektor kompüteri: `/o/<slug>/stage` (və ya `/stage`), tam ekran (**F**), **səsi yoxlayın** (bir dəfə klik → "Səs").
      Ekranın yuxu rejimi və ekran qoruyucusu söndürülsün, noutbuk elektrikə qoşulsun.
- [ ] Nəticə ekranı lazımdırsa ikinci tab: `/reveal`.
- [ ] Koordinator: `/admin` + telefonda pult (`/admin/pult`).
- [ ] Münsiflər QR ilə daxil olur; koordinator panelində hamısı yaşıl (onlayn). Telefonlarda enerjiyə qənaət söndürülsün, parlaqlıq orta.
- [ ] **Ehtiyat internet:** koordinatorun telefonunda hotspot hazır (ad/parol yazılı). Proyektor kompüteri üçün ikinci şəbəkə (hotspot və ya kabel).
- [ ] `/root` → Sistem vəziyyəti: "Bağlantılar" sayı ≈ münsif + ekran + koordinator.

## 2. Tədbir zamanı: problemlər və həll

| Əlamət | Nə etməli |
|---|---|
| **Münsif qoşula bilmir** (QR açılmır / "istifadə olunub") | Koordinator: həmin münsif → **Yeni QR**. Köhnə ballar qorunur (eyni hesab). İnternet yoxdursa münsifi hotspot-a qoşun. |
| Münsifin ekranında **"Oflayn — növbədə"** | Heç nə etmək lazım deyil — bal telefonda saxlanılıb, şəbəkə qayıdanda özü gedir. Uzun sürərsə telefonu hotspot-a qoşun. **Səhifəni bağlamayın / brauzer datasını silməyin.** Aşağıdakı "Göndərmə tarixçəsi"ndə nə qaldığı görünür. |
| Münsif "Göndərilib" deyir, koordinator görmür | Koordinator səhifəsini yeniləyin (F5). `/api/health` → `ok`? Admin panelində bal yoxdursa münsifin "Göndərmə tarixçəsi"nə baxın: "növbədə" isə şəbəkə problemidir. |
| **Proyektor donub** / "Yenidən qoşulur…" | 5–10 s gözləyin (özü qoşulur və vəziyyəti yeniləyir). Olmasa F5. Taymer serverdədir — yeniləmə vaxtı itirmir. Hələ də olmasa: ehtiyat şəbəkəyə keçin. |
| Taymer səhv işləyir / vaxt əlavə lazımdır | Koordinator panelində ±vaxt və ya "qalan vaxtı təyin et". Bütün ekranlar dərhal izləyir. |
| **Server restart oldu** (deploy, çökmə) | Heç nə etməyin: 5–30 s ərzində ekranlar və telefonlar özü qoşulur. Səhnə, taymer (server saatı ilə davam edir), slayd və reveal addımı eyni qalır. Restart zamanı verilən ballar telefonlarda gözləyir və sonra gedir. `/root` → Sistem vəziyyəti: "İşləyir" kiçik rəqəm göstərəcək. |
| Server qayıtmır (5 dəq+) | Coolify → tətbiq → Logs. Konteyner işləyirsə `GET /api/health`. Bərpa üçün §4. Münsiflərə: "Ballarınız telefonda saxlanılıb, səhifəni bağlamayın." |
| **Bal səhv daxil edilib** | Münsif həmin komandanı açıb balı düzəldir və yenidən göndərir — son versiya qalır, köhnəsi tarixçədə görünür. Qiymətləndirmə bağlanıbsa: koordinator **kilidi açır** → münsif düzəldir → kilidi yenidən bağlayır. |
| Münsif "Rədd edildi: qiymətləndirmə bağlanıb" görür | Bal itməyib — telefonda qalıb (tarixçədə dəyərləri ilə). Koordinator lazım bilərsə kilidi açır; münsif dəyişməyibsə bal özü yenidən gedir. Serverdə də izi qalır (audit: `score.rejected`). |
| Münsif telefonu dəyişməlidir | Yeni QR verin. Köhnə telefonda göndərilməmiş bal qalıbsa, köhnə telefonu da internetə qoşun — özü göndərəcək. |
| `/api/health`-də `warnings` | `backup-failed`/`backup-old`: diskdə yer? `/root` → İndi yedəklə. `db-integrity`: dərhal yedək götürün, tədbiri davam etdirin, sonra §4. `event-loop-lag`: server yüklüdür — lazımsız tabları/ekranları bağlayın. |

## 3. Tədbirdən sonra
- [ ] İrəliləyiş tamdır → **Qiymətləndirməni bağla** → reveal.
- [ ] Excel + PDF yükləyin (nəticələr), **Qiymət tarixçəsi (Excel)**; PDF-i münsiflərə imzalatın.
- [ ] `/root` → **İndi yedəklə**. Coolify volume-dan `/app/data/backups/` qovluğunu (və ya ən azı son `auto-*.db` və `manual-*.db`) arxivə köçürün.
- [ ] Növbəti tədbir üçün: Quraşdırma → **Yeni tədbir** (köhnəsi arxivə düşür, silinmir).

## 4. Yedəkdən bərpa (yalnız lazım olsa)

Yedəklər: `DATA_DIR/backups/` — `auto-*.db` (hər 10 dəq), `manual-*.db`, `pre-v*.db` (miqrasiyadan əvvəl), `pre-restore-*.db`.

```bash
# konteynerin içində (Coolify → Terminal):
node dist-server/server/restore.js --list               # yedəklər, ən yenisi yuxarıda
node dist-server/server/restore.js auto-2026-11-08_18-40-00-000.db
# → "Bərpa sorğusu yazıldı" → Coolify-da Restart
```

Start zamanı server yedəyi yoxlayır (`quick_check`), indiki bazanı `backups/pre-restore-*.db` kimi saxlayır və yedəyi yerinə
qoyur. Yedək yararsızdırsa heç nəyə toxunmur (`restore-failed-*.json`). **Diqqət:** yedəkdən sonra verilmiş ballar bazadan
gedər — münsiflərin telefonlarında artıq "saxlanıldı" olduğu üçün təkrar göndərilməyəcək. Bərpanı yalnız baza zədələnəndə
edin və bərpadan sonra münsiflərdən son komandaları yoxlamağı xahiş edin.

Lokal / dayanmış server: `npm run restore -- <fayl> --now`.
