# Backend WhatsApp Admin

Backend multiempresa para administrar agentes vendedores por WhatsApp con Node.js, TypeScript, Express, PostgreSQL y Prisma.

## Requisitos

- Node.js 20+
- PostgreSQL 14+

## Variables de entorno

Copiar `.env.example` a `.env` y ajustar:

```env
PORT=3000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/whatsapp_admin?schema=public"
JWT_SECRET="super-secret-jwt"
JWT_EXPIRES_IN="7d"
BOT_CONFIG_API_KEY=""
```

## Scripts

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

## Deploy de producción

El backend puede desplegarse automáticamente por GitHub Actions usando:

- workflow: `.github/workflows/deploy-production.yml`
- script de referencia/manual: `scripts/deploy-backend.sh`

El flujo seguro de producción es:

- `git pull --ff-only`
- `rsync` del código al directorio de despliegue
- `docker compose build backend`
- `docker compose up -d backend`
- arranque con `prisma migrate deploy`

Precauciones importantes:

- no ejecutar `prisma migrate dev` en producción
- no ejecutar seeds en producción
- no usar `docker compose down -v`
- la data vive en el volumen de PostgreSQL, no en el contenedor del backend

## Credenciales demo

- `phone`: `963337953`
- `password`: `123456`

## Endpoint MVP para n8n

`GET /api/bot/config?channel=whatsapp&account=ACCOUNT_WA_DEMO&phone=51999999999`
