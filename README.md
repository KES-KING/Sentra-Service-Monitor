![Logo](public/assets/whitesentra_logo2.png)
# Sentra Stat Monitor

Linux ve Windows üzerindeki servisleri, durumlarını ve loglarını takip etmek için hazırlanmış, ağırlıklı olarak Linux/systemd için tasarlanmış küçük bir dashboard.

## Özellikler

- Tüm systemd (Linux) veya Windows servislerini listeleme (filtre + sayfalama)
- Seçili servisin durumunu ve son loglarını görüntüleme
- Servisleri yeniden başlatma
- Failed + inactive servisler için failure trend paneli
- CPU, bellek, swap ve disk I/O metrik kartları
- Session tabanlı login (MySQL `users` tablosu)
- Kullanıcının şifresini değiştirebileceği `User settings` sayfası
- Sunucu bilgisi paneli (IP, hostname, OS) – `/api/server-info`
- Kısıtlı komut çalıştırma konsolu (`/console` + `/api/console/exec`)

> Not: Proje demo amaçlıdır. Gerçek bir üretim ortamına almadan önce güvenlik ayarlarını gözden geçirmeniz gerekir.

![Logo](public/assets/SentraStatBanner.png)

## Gereksinimler

- Node.js 18+ (geliştirme ortamında 22 ile test edildi)
- npm
- MySQL 8 (veya uyumlu bir MySQL sunucusu)
- Linux:
  - `systemd` ve `journalctl` komutlarına erişim
  - `/proc` dosya sistemine erişim (metrikler için)
- Windows:
  - PowerShell (Get-Service, Get-WmiObject, Get-WinEvent, Get-Counter komutları)
  - PowerShell Komutları etkinleştirmek için `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` kodunu administrator yetkisi ile çalıştırın

## Kurulum

Depoyu klonladıktan sonra kök dizinde:

```bash
npm install
```

Bu komut `express`, `mysql2`, `express-session`, `bcryptjs`, `dotenv` gibi bağımlılıkları yükler.

## Veritabanı kurulumu

### Geliştirme veritabanı

1. `schema.sql` dosyasındaki kullanıcı parolasını kendi ortamınıza göre güncelleyin:

```sql
CREATE USER 'sentrauser'@'%' IDENTIFIED BY 'password_here';
```

2. Ardından MySQL içinde şemayı yükleyin:

```bash
mysql -u root -p < schema.sql
```

Bu dosya şunları yapar:

- `sentra_monitor` adında ana veritabanını oluşturur.
- `sentrauser` kullanıcısına bu veritabanı üzerinde yetki verir.
- Aşağıdaki şemaya sahip `users` tablosunu oluşturur:
  - `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY
  - `username` VARCHAR(64) UNIQUE
  - `password_hash` VARCHAR(255) (bcrypt hash)
  - `created_at` TIMESTAMP (varsayılan CURRENT_TIMESTAMP)
- Geliştirme için bir adet `admin` kullanıcısı ekler:
  - username: `admin`
  - password (plain): `k+@F1U[bkwA=TD9`

Hash, `bcrypt` ile üretilmiştir ve `server.js` tarafından doğrudan kullanılabilir.

### İsteğe bağlı: test kullanıcısı

Yerel denemeler için farklı bir MySQL kullanıcısı kullanmak isterseniz `schema-test.sql` dosyasını inceleyip çalıştırabilirsiniz. Bu dosya:

- `sentra_monitor` veritabanı için `sentrauser25210` adında ikinci bir MySQL kullanıcısı oluşturur.
- Aynı `users` tablosunu ve varsayılan `admin` kullanıcısını ekler.

## Ortam değişkenleri (.env)

Kök dizinde bir `.env` dosyası oluşturun ve kendi veritabanınız ile eşleştirin:

```env
# Server
PORT=4001
SESSION_SECRET=change-this-secret-for-production

# MySQL
DB_HOST=localhost
DB_USER=sentrauser
DB_PASSWORD=your_mysql_password
DB_NAME=sentra_monitor
```

> Not: Buradaki `DB_USER` / `DB_PASSWORD` değerleri `schema.sql` (veya kullanıyorsanız `schema-test.sql`) içindeki kullanıcı ile uyumlu olmalıdır.

`SESSION_SECRET` değerini üretim ortamında güçlü ve tahmin edilemez bir değerle değiştirin.

## Uygulamayı çalıştırma

```bash
node server.js
```

Sunucu varsayılan olarak şu adreste çalışır:

- `http://localhost:4001`

Uygulama açıldığında önce `/login` sayfasına yönlendirilirsiniz.

## Login akışı

- `GET /login` – Login sayfası (`public/login.html`)
- `POST /login` – MySQL içindeki `users` tablosuna göre kullanıcıyı doğrular:
  - `req.body.username`
  - `req.body.password`
  - `bcrypt.compare` ile hash karşılaştırması
  - Başarılı olursa `req.session.userId` doldurulur ve frontend `/` adresine yönlendirir.
- `POST /logout` – Oturumu sonlandırır ve tekrar `/login` sayfasına döner.

## Sayfalar

- `/login`  
  Logo + basit login formu. Başarılı login sonrası `/` adresine yönlendirir.

- `/` (dashboard)  
  Sadece login olmuş kullanıcılar erişebilir. Aksi halde `/login`’e redirect edilir.
  - Üst navbar:
    - Sol: logo (156px yükseklik)
    - Ortada: server info (IP, hostname, OS) paneli
    - Sağ: `Console`, `User settings` ve `Logout` butonları
  - Üstte metrik kartları (CPU, Memory, Swap, Disk I/O)
  - Sol panel: Failure trend + services list (filtre + sayfalama)
  - Sağ panel: Seçili servis için status output + recent logs + restart butonu

- `/user-settings`  
  Şifre değiştirme sayfası (login zorunlu).
  - `POST /api/user/change-password` endpoint’ini kullanır.
  - Alanlar: current password, new password, confirm new password
  - Yeni şifre minimum 8 karakter, `bcrypt` ile hash’lenip DB’de güncellenir.
  - Navbar’da `Back to dashboard`, `Console` ve `Logout` bulunur.

- `/console`  
  Kısıtlı bir terminal/console arayüzü.
  - `POST /api/console/exec` endpoint’ini kullanır.
  - Bazı basit komutlar için yardım: `help`, `clear`, `whoami`, `pwd`, `ls`, `cat`, `echo`, `date`, `uname` vb.
  - Tehlikeli komutlar ve kabuk metakarakterleri engellenir (ayrıntı için “Güvenlik notları” bölümüne bakın).

## PM2 ile çalıştırma

Uygulamayı PM2 ile servis gibi çalıştırmak isterseniz:

```bash
cd /path/to/linux-service-dashboard
pm2 start server.js --name sentra-stat-monitor
```

Yararlı komutlar:

```bash
pm2 logs sentra-stat-monitor        # logları izle
pm2 restart sentra-stat-monitor     # süreci yeniden başlat
pm2 stop sentra-stat-monitor        # süreci durdur
pm2 save                            # reboot sonrasında otomatik başlatma için süreç listesini kaydet
```

## API özeti

Tüm API endpoint’leri login gerektirir (`requireAuth`), aksi belirtilmedikçe.

- `GET /api/server-info`  
  Sunucu hostname, IP adresi ve işletim sistemi bilgilerini döner.

- `GET /api/services`  
  Tüm servisleri listeler.
  - Linux: `systemctl list-units --type=service ...`
  - Windows: `Get-Service` (PowerShell) çıktısını JSON’a çevirir.

- `GET /api/services/:name`  
  Belirli bir servis için:
  - Linux: `systemctl status <name>` + `journalctl -u <name> -n 200`
  - Windows: `Get-Service` + ilgili event loglarını `Get-WinEvent` ile okur.
  - Çıktıları JSON olarak döner (`statusText`, `logsText`).

- `GET /api/failed-services`  
  Başarısız veya otomatik olup çalışmayan servisleri döner.
  - Linux: `active === "failed"` olan systemd servisleri ve `systemctl show` üzerinden alınan zaman damgaları.
  - Windows: `Status = Stopped` ve `StartType = Automatic` olan servisler.

- `POST /api/services/:name/restart`  
  Servisi yeniden başlatır.
  - Linux: `systemctl restart <name>`
  - Windows: `Restart-Service -Name '<name>' -Force`

- `GET /api/metrics`  
  CPU, bellek, swap ve disk I/O metriklerini döner.
  - Linux: `/proc/stat`, `/proc/meminfo`, `/proc/diskstats` üzerinden okunur.
  - Windows: PowerShell komutları ile sistem metrikleri alınır.

- `POST /api/user/change-password`  
  Oturum açmış kullanıcının şifresini değiştirir.

- `POST /api/console/exec`  
  Console sayfasından gelen komutu kısıtlı bir ortamda çalıştırır ve stdout/stderr döner.

## Güvenlik notları

- Şifreler hiçbir zaman plain-text saklanmaz, `bcrypt` ile hash’lenir.
- Service name parametresi regex ile filtrelenir:
  - Linux: sadece `a-zA-Z0-9_.@-` karakterleri ve `.service` uzantısına izin verilir.
  - Windows: harf, rakam, boşluk, alt çizgi ve tire karakterleri kabul edilir.
- Tüm dashboard ve API endpoint’leri login sonrası session’a bağlıdır (`requireAuth`).
- Console endpoint’i için:
  - `sudo` ve birçok tehlikeli komut (örn. `rm`, `mkfs`, `shutdown`, `reboot`, `dd`, `docker`, `kubectl` vb.) engellenir.
  - Shell metakarakterleri (`;`, `&`, `|`, `$`, `<`, `>`, ve ters tırnak karakteri) reddedilir.
  - Sadece sınırlı bir karakter kümesine izin verilir (`a-zA-Z0-9_./=-` ve boşluk).
  - Komut uzunluğu 200 karakter ile sınırlandırılmıştır.

Üretim ortamında:

- `SESSION_SECRET` mutlaka güçlü ve gizli bir değer olmalıdır.
- `.env` dosyasını versiyon kontrolü dışında tutun (repo’da `.gitignore` ile hariç bırakılıyor).
- Gerekirse `cors()` yapılandırmasını sadece gerekli origin’lerle sınırlandırın.
- Uygulamayı sadece güvenilir ağlarda veya reverse proxy/VPN arkasında yayımlayın; HTTPS kullanın.

## Geliştirme notları

- Frontend tarafı statik HTML + Bootstrap + vanilla JS kullanır, derleme adımı yoktur.
- Değişiklik yaptıktan sonra sadece `server.js` sürecini yeniden başlatmanız yeterlidir.
- Proje hem Linux hem de Windows üzerinde çalışabilir, ancak üretim için öncelikli hedef Linux/systemd ortamıdır.

