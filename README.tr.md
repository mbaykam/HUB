<p align="center"><img src="docs/assets/hub-banner.svg" alt="HUB — Yapay zekân, sesin, ikinci beynin" width="900"></p>

# HUB

**Konuşmak, görev devretmek ve bilgilerini birbirine bağlamak için kendi
bilgisayarında çalışan bir yapay zekâ çalışma alanı.**

Hızlı bir ses karakteriyle konuş; kapsamlı işleri ana HUB asistanına devret.
Telegram'dan mesaj gönder, PWA'da görevleri ve konuşmalarını takip et, bağlı
Markdown notlarından oluşan ikinci beynini keşfet. Karakterlerin modellerini,
seslerini ve araçlarını kendin seç.

[English](README.md) · [Kurulum](docs/setup.md) · [Belgeler](docs/README.md) ·
[Sorun bildir](https://github.com/mbaykam/HUB/issues)

## Neler var?

- Yerel STT/TTS, çok dilli ses desteği, hazırlanmış ses örnekleri ve
  canlı transkript.
- Ses karakterinden ana HUB'a görev devri; native iş geçmişi ve sesli sonuç
  dönüşü.
- Eşleştirilmiş Telegram botuyla tek mesajı güncelleyerek sohbet; ayrı bir
  kullanıcı hesabıyla isteğe bağlı gelen arama köprüsü.
- Obsidian uyumlu Markdown vault, özgün konuşmaları koruyan AI ilişkilendirmesi, ayrı reflection kayıtları,
  kaynak/medya kayıtları, konu bulutları ve geçmiş sohbetleri içe aktarma.
- OpenRouter model kataloğu, kurulu sağlayıcılar, yerel model seçenekleri ve
  karakter başına model/araç/delegasyon ayarları.
- Koyu cam yüzeyler ve gradient mesh kullanan mobil PWA; görev, sohbet ve
  görsel sonuçları birlikte izleme.

## Başla

**[v1.0.0 Windows kurulumunu indir](https://github.com/mbaykam/HUB/releases/tag/v1.0.0)**
veya kaynak kodundan çalıştır. HUB Windows önceliklidir; bilgisayar PWA ve Telegram'a hizmet verir.
Kaynak kodundan kurulum için Node.js 24+, Git ve pnpm 11.7.0 gerekir:

```sh
git clone --recurse-submodules https://github.com/mbaykam/HUB.git
cd HUB
pnpm install --frozen-lockfile
pnpm run harness:stage
pnpm start
```

Önce sağlayıcını bağlayıp HUB ve ses karakterlerini yapılandır.
Ses, Knowledge AI ve Telegram araması ek Python/runtime ve özel profil
yapılandırması gerektirir; yukarıdaki komut bunları otomatik kurmaz.
[Kurulum rehberi](docs/setup.md), [ses](docs/voice.md),
[knowledge](docs/knowledge.md) ve [Telegram](docs/telegram.md) adımlarına bak.

Host bilgisayarı açık olmalıdır. Telefon mikrofonu için kimlik doğrulamalı HTTPS
erişimi gerekir. Telegram botu metin içindir; normal aramalar ayrı, izinli bir
Telegram kullanıcı hesabıyla çalışır.

## Durum ve veri

Geçmiş araması, sohbet başlıklarının yanında mesajların içindeki kelimeleri de
bulur. Yerel indeks ilk aramada hazırlanır ve masaüstü veri klasöründe saklanır;
orijinal sohbet dosyaları değişmez. İlk arama daha uzun sürebilir.

Speech ve notlar yerel olabilir; seçtiğin bulut modeline gönderilen istemler
sağlayıcıya ulaşır. Telegram ve web erişimi de ilgili hizmetlerden geçer.
Hesaplar, tokenlar, kişisel sohbetler, vaultlar ve model ağırlıkları depoya dahil
edilmez. [Güvenlik ve özel veri](SECURITY.md).

Ses gecikmesi/kalitesi cihaz ve modele bağlıdır. Mevcut yankı koruması yanıt
sırasında dinlemeyi durdurur; Interrupt ile kesebilirsin. Tam akustik yankı
iptali henüz tamamlanmış olarak sunulmaz. Uzun seanslar native compaction,
özgün geçmiş ve kaynaklardan hatırlama ile desteklenir; compaction kayıplı bir
özetleme işlemidir. macOS/Linux paketleme yolları bulunur; bu sürüm
o platformlar için doğrulanmış ses desteği veya hazır indirme sunmaz.

## Kaynaklar

HUB'ın geliştiricisi ve bakımını yapan kişi **[Mete Baykam (@mbaykam)](https://github.com/mbaykam)**.
[Tüm katkıda bulunanlar](https://github.com/mbaykam/HUB/graphs/contributors).

HUB, lencx'in [Minke](https://github.com/lencx/Minke) projesinden türetilmiş,
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) üzerine
kurulu bağımsız bir projedir.

Sayfa düzeni için [OpenClaw](https://github.com/openclaw/openclaw/blob/main/README.md),
[OpenCode](https://github.com/anomalyco/opencode/blob/dev/README.md) ve
[Pi](https://github.com/earendil-works/pi/blob/main/README.md) örnek alındı.
Metin ve görseller özgün; bu projelerle bağlılık iddiası yoktur.
[Bağlantılı kaynak listesi](docs/sources.md).

HUB kodu [Apache-2.0](LICENSE) lisanslıdır. Upstream bileşenler ve indirilen
modeller kendi lisanslarını korur; [NOTICE](NOTICE).

Otomasyonlar sağ panelde yönetilir: zaman, tekrar, takvim, kaynak değişimi ve HUB olayları. Çalışma geçmişi, araç izinleri ve limit bekleme durumları burada görünür. [Otomasyonlar](docs/automations.md) · [Knowledge](docs/knowledge.md).

Knowledge'da bir nottan geri dönünce arama listesi ve okuma konumu korunur.
Çalışma alanında başka bir yere geçmeden önce not düzenlemesini kaydet veya
**Discard changes** ile açıkça vazgeç.
