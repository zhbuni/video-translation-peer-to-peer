# p2p-webrtc

MVP каркас: **signaling-сервер на Go** (HTTP + будущий WebSocket `/ws`) для P2P WebRTC mesh.

## Локальный запуск (без Docker)

```bash
cd /home/vladimir/p2p-webrtc
go run ./cmd/signaling-server
```

Проверка:

```bash
curl -sS localhost:8080/healthz
```

## Docker

Сборка и запуск:

```bash
cd /home/vladimir/p2p-webrtc
docker compose up --build
```

Проверка:

```bash
curl -sS localhost:8080/healthz
```

## Web клиент

После `docker compose up --build` открой `http://localhost:8081/`.

Вбей:
- `Room ID`: например `demo`
- `Peer ID`: разные значения в двух вкладках, например `alice` и `bob`
- `STUN URLs`: можно оставить по умолчанию
- `TURN ...`: заполни, если тестируешь через NAT/интернет (иначе P2P может не установиться)
- `Join` в обеих вкладках
- `Start screen+mic` в одной вкладке

## Эндпоинты
- `GET /healthz`: healthcheck JSON
- `GET /ws`: WebSocket signaling

## Деплой на VPS через GitHub Actions (GHCR + SSH)

### 1) Подготовка VPS

- Установи Docker + Docker Compose plugin (`docker compose`).
- Создай директорию приложения, например `/opt/p2p-webrtc`.

### 2) Секреты репозитория (GitHub → Settings → Secrets and variables → Actions)

Нужны:
- `VPS_HOST`
- `VPS_USER`
- `VPS_SSH_KEY` (приватный ключ)
- `VPS_SSH_PORT` (опционально, по умолчанию 22)
- `VPS_APP_DIR` (например `/opt/p2p-webrtc`)
- `DOMAIN` (например `webrtc.example.com`)
- `ACME_EMAIL` (email для Let's Encrypt)
- `GHCR_USERNAME` (обычно твой GitHub user, например `zhbuni`)
- `GHCR_TOKEN` (PAT с правами на Packages: read, а если нужно — write)

### 3) Как работает workflow
- На push в `main` собираются и пушатся образы:
  - `ghcr.io/<owner>/<repo>-signaling:latest`
  - `ghcr.io/<owner>/<repo>-web:latest`
- Затем по SSH на VPS копируются `docker-compose.prod.yml` и `deploy/Caddyfile`, выполняется `docker compose pull && up -d`.

### 4) Первый запуск на VPS (если нужно руками)

```bash
cd /opt/p2p-webrtc
docker compose -f docker-compose.prod.yml up -d
```

