# Напрямую, мимо VPN

Администратор выбирает страны, домены и сети, к которым приложение пользователя ходит **без туннеля**, даже когда VPN включён
(например, `.ru` и российские IP). Настройка — «Подписки → Напрямую, мимо VPN», действует для всех подписок.

**Маршрутизацию выполняет приложение на устройстве**, панель и ноды только отдают правила в подписке. Поэтому охват зависит от клиента:

| Клиент | Что работает |
|---|---|
| mihomo / Clash (`?format=clash`, FlClash, Clash Verge, Mihomo Party) | всё: `DOMAIN-SUFFIX`, `IP-CIDR`/`IP-CIDR6`, `GEOIP` → `DIRECT` перед итоговым `MATCH`; и для AWG, и для VLESS. Перед ними всегда идут DIRECT-правила IP-адресов AWG ([subscriptions.md](subscriptions.md)) |
| AmneziaWG (Incy `awg://`, `.conf`, JSON Incy) | только IP: `AllowedIPs` = весь IPv4 минус сети выбранных стран и свои IPv4-сети (опция «Применять к конфигам AmneziaWG»). Доменов в WireGuard нет |
| VLESS-ссылки (v2rayN, Happ, Hiddify, Streisand) | в ссылке `vless://` правил нет — их задают в приложении |

## Данные

`settings`: `direct_enabled` (`1`), `direct_awg` (`1`), `direct_countries` / `direct_domains` / `direct_cidrs` (JSON-массивы),
кэш сетей страны `geo_v4_<cc>` (строки CIDR) и `geo_v4_<cc>_at`. Новых таблиц и миграций нет; кэш попадает в архивы переноса и копии как обычные настройки.

- Страны — коды ISO в нижнем регистре, не более 20. К каждой стране в правила mihomo добавляется её национальный домен
  (`gb` → `uk`; у `ru` дополнительно `su` и `рф`) и `GEOIP`.
- Домены — суффиксы (`example.com` включает поддомены), IDN приводятся к punycode, не более 500.
- Сети — IPv4 не шире `/8`, IPv6 не шире `/16`, не более 500. В `AllowedIPs` участвуют только IPv4; `::/0` остаётся в туннеле
  (защита от утечки IPv6, см. [subscriptions.md](subscriptions.md)).

## Сети стран

Сети скачиваются **панелью** из агрегированных зон `https://www.ipdeny.com/ipblocks/data/aggregated/<cc>-aggregated.zone` при
сохранении настроек (для стран без списка) и по кнопке «Обновить списки сетей». Выдача подписки сети не скачивает: она синхронная и
берёт кэш. Ответ источника — внешние данные: принимаются только строки формата IPv4 CIDR, пустой или нечитаемый ответ отклоняется,
прежний список остаётся. Если у выбранной страны списка нет, она в `AllowedIPs` пропускается; если нет ни одной сети — остаётся
`0.0.0.0/0, ::/0`, то есть подписка не ломается. Вычитание — `utils/cidr.ts` (`complementCidrs`), результат кэшируется до смены настроек или списков.

## API

- `GET /api/subscription-settings` → `direct: { enabled, awg, countries, domains, cidrs, countries_status[{country, networks, updated_at}] }`.
- `PUT /api/subscription-settings` — `direct: { enabled?, awg?, countries?, domains?, cidrs? }` (домены и сети — массивом или текстом).
  Ответ дополнен `refresh[{country, error}]` — итог загрузки сетей новых стран; сбой загрузки сохранение не отменяет.
- `POST /api/subscription-settings/direct/refresh` — `{ countries? }`, скачать сети заново.

Гость видит только `GET` (секретов в `direct` нет).
