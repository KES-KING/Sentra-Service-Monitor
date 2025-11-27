![Logo](public/assets/whitesentra_logo2.png)
# Sentra Stat Monitor

Sentra Stat Monitor; Linux ve Windows sunuculardaki servisleri, durumlarını ve loglarını
izlemek için hazırlanmış, Node.js + MySQL tabanlı küçük bir dashboard projesidir.

Projede artık iki ana bileşen vardır:

- Web arayüzü ve HTTP API (bu depo, `server.js`)
- Windows için Sentra SSM Agent (WinForms uygulaması – `WinApp/SSM Agent` ve derlenmiş
  sürüm `WinAppBuild/SSM Agent.exe`)

Web arayüzü hem kendi çalıştığı sunucunun durumunu izleyebilir, hem de SSM Agent kurulu
Windows makinelerden gelen verileri tek bir panelde toplayabilir.

![Banner](public/assets/SentraStatBanner.png)

## Özellikler

- Oturum temelli login sistemi (MySQL `users` tablosu)
- Linux / Windows üzerinde çalışan web sunucusu için:
  - Sunucu bilgileri (IP, hostname, OS)
  - CPU, bellek, swap ve disk I/O metrik kartları
  - Kısıtlı komut çalıştırma konsolu (`/console`)
- Uzak Windows makineler için SSM Agent entegrasyonu:
  - Her Windows makine için benzersiz App ID (GUID)
  - App ID’leri kullanıcı hesabına bağlama (`/apps` sayfası)
  - Agent’lardan periyodik CPU/RAM/uptime ve servis listesi toplama
  - /dashboard sayfasında tüm agent’ları ve servislerini tek ekranda izleme
  - Hostname filtresi ile tek bir agent’ı seçerek detaylarını görme
  - Web arayüzünden servis yeniden başlatma isteği gönderme
    (komut, veritabanında kuyruğa alınır; Windows’ta SSM Agent tarafından çalıştırılır)

> Not: Proje demo amaçlıdır. Gerçek bir üretim ortamına almadan önce
> güvenlik ayarlarınızı ve ağ topolojinizi mutlaka gözden geçirin.

## Mimari Genel Bakış

- **Web uygulaması (Node.js + Express)**
  - Statik HTML + Bootstrap + vanilla JS (`public/` klasörü)
  - Express oturum yönetimi (`express-session`)
  - MySQL üzerinden kullanıcı ve agent verileri

- **Veritabanı (MySQL)**
  - `users` – web kullanıcıları (login)
  - `agents` – Windows agent tanımları ve App ID’ler
  - `agent_status` – agent’ların son CPU/RAM/uptime kayıtları
  - `agent_services` – agent başına servis listesi ve durumları
  - `agent_service_commands` – uzak servis yeniden başlatma gibi komutlar için kuyruk

- **Windows Sentra SSM Agent**
  - WinForms uygulaması (`WinApp/SSM Agent`)
  - Her kurulumda benzersiz bir App ID üretir ve Windows Registry’de saklar
  - `ServerAddress` ayarı ile web API adresine (`http://localhost:4001/api` gibi)
    bağlanır
  - `X-APP-ID` HTTP header’ı ile kendini tanıtır ve JSON verilerini sunucuya yollar

## Gereksinimler

- **Web tarafı**
  - Node.js 18+ (geliştirme ortamında 22 ile test edildi)
  - npm
  - MySQL 8 (veya uyumlu bir MySQL sunucusu)

- **Linux üzerinde web sunucusu**
  - `systemd` ve `journalctl` komutlarına erişim (ileri düzey servis izlemesi için)
  - `/proc` dosya sistemine erişim (CPU / bellek / disk metrikleri için)

- **Windows üzerinde web sunucusu**
  - PowerShell (temel komutlar için)

- **Windows SSM Agent**
  - Windows 10 veya üzeri
  - .NET / WinForms runtime (proje Visual Studio ile derlenmiştir)
  - `SSM Agent.exe` için internet / LAN erişimi (web API’ye ulaşabilmesi için)

## Kurulum

Depoyu klonladıktan sonra kök dizinde:

```bash
npm install
```

Bu komut `express`, `mysql2`, `express-session`, `bcryptjs`, `dotenv` vb. bağımlılıkları kurar.

### Veritabanı kurulumu

1. `schema.sql` içindeki MySQL kullanıcı parolasını kendi ortamınıza göre güncelleyin:

```sql
CREATE USER 'sentrauser'@'%' IDENTIFIED BY 'password_here';
```

2. Ardından şemayı MySQL sunucunuza yükleyin:

```bash
mysql -u root -p < schema.sql
```

`schema.sql` şunları yapar:

- `sentra_monitor` adında ana veritabanını oluşturur.
- `sentrauser` kullanıcısına bu veritabanı üzerinde yetki verir.
- Aşağıdaki yapıya sahip `users` tablosunu oluşturur:
  - `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY
  - `username` VARCHAR(64) UNIQUE
  - `password_hash` VARCHAR(255) (bcrypt hash)
  - `created_at` TIMESTAMP (varsayılan CURRENT_TIMESTAMP)
- Geliştirme için bir adet varsayılan `admin` kullanıcısı ekler:
  - Kullanıcı adı: `admin`
  - Parola (düz metin): `k+@F1U[bkwA=TD9`

Ayrıca Windows Agent entegrasyonu için aşağıdaki tablolar oluşturulur:

- `agents`
  - Her App ID için bir satır içerir.
  - `user_id` alanı ile web kullanıcısına bağlanır (NULL ise henüz bağlanmamış agent).
  - `hostname`, `os`, `last_seen` alanları en son gelen veriye göre güncellenir.

- `agent_status`
  - Her `status/update` çağrısında CPU, RAM, uptime ve zaman damgası kaydedilir.

- `agent_services`
  - Agent’tan gelen servis listesi burada tutulur (agent + servis adı benzersiz).

- `agent_service_commands`
  - Web arayüzünden gönderilen servis komutları (şu an için `restart`) kuyruklanır.
  - Agent, komutları okuyup çalıştırır ve sonucu yine API üzerinden bildirir.

### İsteğe bağlı: test kullanıcı yapısı

Yerel denemeler için farklı bir MySQL kullanıcısı kullanmak isterseniz
`schema-test.sql` dosyasını inceleyip çalıştırabilirsiniz. Bu dosya:

- `sentra_monitor` veritabanı için ek bir MySQL kullanıcısı oluşturur.
- Aynı `users` tablosu ve varsayılan `admin` kullanıcısını ekler.

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

> Not: Buradaki `DB_USER` / `DB_PASSWORD` değerleri `schema.sql`
> (veya kullanıyorsanız `schema-test.sql`) içindeki kullanıcıyla uyumlu olmalıdır.
>
> `SESSION_SECRET` değerini üretim ortamında güçlü ve tahmin edilemez bir değerle
> mutlaka değiştirin.

## Uygulamayı çalıştırma

```bash
node server.js
```

Sunucu varsayılan olarak şu adreste çalışır:

- `http://localhost:4001`

Tarayıcıdan bu adrese gittiğinizde login sayfasına yönlendirilirsiniz.

## Login akışı

- `GET /login` – Login sayfası (`public/login.html`)
- `POST /login`
  - `req.body.username`
  - `req.body.password`
  - MySQL `users` tablosu üzerinden kullanıcı doğrulaması
  - Parola, `bcrypt.compare` ile hash’e göre kontrol edilir
  - Başarılı olursa `req.session.userId` doldurulur ve frontend sizi `/` adresine yönlendirir
- `POST /logout`
  - Oturumu sonlandırır ve tekrar `/login` sayfasına dönmenizi sağlar.

## Web arayüzü (sayfalar)

Tüm sayfalar login gerektirir; oturum yoksa `/login`’e redirect edilir.

- `/login`  
  Basit logo + login formu. Başarılı login sonrası `/` (ana dashboard) açılır.

- `/` – Ana sistem dashboard’u  
  Web uygulamasının kurulu olduğu sunucunun durumuna odaklanır.
  - Navbar:
    - Sol: logo
    - Orta: server info paneli (IP, hostname, OS) – `/api/server-info`
    - Sağ: `Windows Agent Dashboard`, `Agent Credentials`, `Web Console`,
      `User settings`, `Logout` butonları
  - Üstte metrik kartları (CPU, Memory, Swap, Disk I/O)
  - Sol panel: servis listesi ve failure trend panelleri
  - Sağ panel: seçili servis için status / log detayları ve yeniden başlatma butonu

- `/dashboard` – Windows Agent Dashboard  
  Uzak Windows SSM Agent’larını ve bu agent’lardan gelen servis bilgilerini gösterir.
  - Üstte “Agents & Services Overview” başlığı ve “Hostname filter” açılır menüsü
  - Sol kart: **Registered Agents**
    - App ID, hostname, OS, last_seen ve create time bilgileri
    - Sayfalama ile agent listesinde gezinme
  - Sağ kart: **Last 50 Status Updates**
    - Agent’tan gelen son CPU/RAM/uptime kayıtları
  - Altta: **Service Status** tablosu
    - Her agent için servis listesi ve durumu
    - Her satırda `Restart` butonu (servis yeniden başlatma isteğini kuyruğa alır)
  - Hostname filtresi:
    - “Hostname filter” alanından bir hostname seçerek hem agent, hem status,
      hem de service tablosunu sadece bu makine için filtreleyebilirsiniz.

- `/apps` – Uygulama (Agent) tanımlama ekranı  
  SSM Agent App ID’lerini kullanıcı hesabınıza bağlamak için kullanılır.
  - Üstte yeni App ID ekleme formu
    - SSM Agent üzerinde üretilen GUID’i buraya yapıştırırsınız.
    - `POST /api/apps` ile `agents` tablosunda App ID ilgili kullanıcıya bağlanır.
  - Altta mevcut agent listesi:
    - ID, App ID, hostname, OS, last_seen ve created_at alanları gösterilir.

- `/user-settings` – Şifre değiştirme  
  - `POST /api/user/change-password` endpoint’ini kullanır.
  - Alanlar: mevcut şifre, yeni şifre, yeni şifre tekrar
  - Yeni şifre minimum 8 karakter; `bcrypt` ile hash’lenip DB’de güncellenir.

- `/console` – Kısıtlı web konsolu  
  - `POST /api/console/exec` endpoint’ini kullanır.
  - Bazı basit komutlar için yardım: `help`, `clear`, `whoami`, `pwd`, `ls`,
    `cat`, `echo`, `date`, `uname` vb.
  - Tehlikeli komutlar ve kabuk metakarakterleri engellenir (detay için
    “Güvenlik notları” bölümüne bakın).

## Windows SSM Agent entegrasyonu

### Agent ve App ID kavramı

- Her SSM Agent kurulumu kendi App ID’sini (GUID) üretir ve Windows Registry’de saklar.
- Bu App ID, agent’ın web API’ye kendini tanıtması için kullanılır (`X-APP-ID` header’ı).
- Web tarafında `/apps` sayfasına gidip bu App ID’yi kendi kullanıcı hesabınıza
  tanımlamanız gerekir.
  - Böylece web kullanıcısı ile agent arasında birebir ilişki kurulmuş olur.

### Agent’ın sunucuya bağlanması

SSM Agent ayarlarında (Settings ekranında) `ServerAddress` değeri bulunur.
Buraya API’nin temel adresini yazmanız gerekir:

- Örnek: `http://localhost:4001/api`

Agent HTTP isteklerini bu adres üzerinden yapar:

- `POST {ServerAddress}/auth/register`
  - Header: `X-APP-ID: <AppId>`
  - Body: `{ hostname, os }`
  - Sunucu, `agents` tablosunda bu App ID’yi arar.
    - Yoksa HTTP 403 ve `{ registered: false }` döner – önce `/apps` sayfasından bu App ID’yi tanımlamanız gerekir.
    - Varsa `last_seen`, `hostname`, `os` alanlarını günceller ve `{ status: "ok", registered: true }` döner.

Agent tarafında bu isteğin başarılı olması durumunda arka planda periyodik veri
gönderimi başlar.

### Agent’ın gönderdiği veriler

Agent belirli aralıklarla aşağıdaki istekleri yapar:

- `POST {ServerAddress}/status/update`
  - Body örneği: `{ cpu, ram, uptime, timestamp, hostname, os }`
  - Sunucu:
    - `agent_status` tablosuna bir satır ekler
    - `agents.last_seen` alanını günceller
    - İlgili agent için `agent_service_commands` tablosundaki `pending` komutları okur
      ve yanıt olarak döner:
      - `{ status: "ok", last_seen: "...", commands: [ { id, type, service_name }, ... ] }`

- `POST {ServerAddress}/status/services`
  - Body: `{ services: [ { name/service_name, display_name, status }, ... ], timestamp }`
  - Sunucu, `agent_services` tablosunu upsert (INSERT ... ON DUPLICATE KEY UPDATE)
    mantığıyla günceller.

- `POST {ServerAddress}/status/service-command-result`
  - Agent, `status/update` yanıtında aldığı komutları çalıştırdıktan sonra sonucu bu
    endpoint’e gönderir.
  - Body: `{ id, success, error }`
  - Sunucu, `agent_service_commands` tablosunda ilgili kaydı `done` veya `failed`
    olarak işaretler.

### Servis yeniden başlatma akışı

1. Web arayüzü `/dashboard` sayfasında servis tablosunda `Restart` butonuna basılır.
2. Frontend aşağıdaki isteği yapar:
   - `POST /api/agent-services/:agentId/:serviceName/restart`
3. Sunucu:
   - Önce `agents` tablosunda `agentId` satırının o anki kullanıcıya ait olduğunu
     (veya `user_id IS NULL` olduğu) doğrular.
   - `agent_service_commands` tablosuna `status = 'pending'` bir `restart` komutu ekler.
4. Bir sonraki `status/update` isteğinde agent bu komutu `commands` alanında görür,
   Windows servisini yeniden başlatır ve sonucu `status/service-command-result`
   endpoint’i ile bildirir.

## API özeti

### 1. Kimlik doğrulama ve oturum

- `POST /login`  
  Kullanıcı adı / parola ile login olur, başarılı olduğunda session cookie döner.

- `POST /logout`  
  Mevcut oturumu sonlandırır.

### 2. Web panel API’leri (session gerekir)

Bu endpoint’lere erişmek için geçerli bir oturum (`express-session`) gerekir.

- `GET /api/server-info`  
  Sunucu hostname, IP adresi ve işletim sistemi bilgilerini döner.

- `GET /api/metrics`  
  CPU, bellek, swap ve disk I/O metriklerini döner.

- `POST /api/user/change-password`  
  Oturum açmış kullanıcının parolasını değiştirir.

- `POST /api/console/exec`  
  Console sayfasından gelen komutu kısıtlı bir ortamda çalıştırır, stdout/stderr döner.

- `GET /api/agents`  
  Oturum açmış kullanıcının sahip olduğu agent kayıtlarını (`agents` tablosu)
  listeler.

- `POST /api/apps`  
  Body: `{ app_id }`  
  Verilen App ID’yi mevcut kullanıcıya bağlar; kayıt varsa `user_id` güncellenir,
  yoksa yeni `agents` satırı oluşturulur.

- `GET /api/agent-status`  
  Oturum açmış kullanıcıya ait agent’ların son 50 status kaydını listeler.

- `GET /api/agent-services`  
  Oturum açmış kullanıcıya ait agent’ların servis listelerini, durumlarını ve
  `last_updated` alanlarını döner.

- `POST /api/agent-services/:agentId/:serviceName/restart`  
  İlgili agent + servis için `agent_service_commands` tablosuna bir `restart`
  komutu ekler (kuyruğa alır).

### 3. Windows Agent API’leri (X-APP-ID header)

Bu endpoint’ler, Windows SSM Agent tarafından kullanılır ve session cookie yerine
`X-APP-ID` header’ı ile kimlik doğrulaması yapar.

- `POST /api/auth/register`  
  Agent’ı App ID’ye göre tanımlar / doğrular, `agents` tablosunu günceller.

- `POST /api/status/update`  
  Agent’ın anlık CPU/RAM/uptime bilgilerini kaydeder, bekleyen komutları döner.

- `POST /api/status/services`  
  Agent’tan gelen servis listesini `agent_services` tablosuna yazar.

- `POST /api/status/service-command-result`  
  Agent’ın daha önce kuyruğa alınan komutların sonucunu bildirmesi için kullanılır.

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

## Güvenlik notları

- Parolalar hiçbir zaman düz metin olarak saklanmaz; `bcrypt` ile hash’lenir.
- Tüm web dashboard ve web API endpoint’leri (agent API’leri hariç) login sonrası
  session’a bağlıdır (`requireAuth`).
- Console endpoint’i için:
  - `sudo` ve birçok tehlikeli komut (örn. `rm`, `mkfs`, `shutdown`, `reboot`,
    `dd`, `docker`, `kubectl` vb.) engellenir.
  - Shell metakarakterleri (`;`, `&`, `|`, `$`, `<`, `>` ve ters tırnak) reddedilir.
  - Sadece sınırlı bir karakter kümesine izin verilir (`a-zA-Z0-9_./=-` ve boşluk).
  - Komut uzunluğu 200 karakter ile sınırlandırılmıştır.
- Agent App ID’leri birer erişim anahtarı gibi düşünülmelidir:
  - App ID’yi yalnızca ilgili Windows makinede ve güvenilir ortamlarda saklayın.
  - `/apps` sayfası üzerinden yanlış App ID’yi yanlış kullanıcıya bağlamamaya
    dikkat edin.

Üretim ortamında:

- `SESSION_SECRET` mutlaka güçlü ve gizli bir değer olmalıdır.
- `.env` dosyasını versiyon kontrolü dışında tutun (repo’da `.gitignore` ile hariç bırakılıyor).
- Gerekirse `cors()` yapılandırmasını sadece gerekli origin’lerle sınırlandırın.
- Uygulamayı sadece güvenilir ağlarda veya reverse proxy/VPN arkasında yayınlayın;
  HTTPS kullanın.

## Geliştirme notları

- Frontend tarafı statik HTML + Bootstrap + vanilla JS kullanır; derleme adımı yoktur.
- Değişiklik yaptıktan sonra sadece `server.js` sürecini yeniden başlatmanız yeterlidir.
- Proje hem Linux hem de Windows üzerinde çalışabilir; ancak üretim için öncelikli
  hedef Linux/systemd ortamıdır.

