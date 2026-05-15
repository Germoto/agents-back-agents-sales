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

## Credenciales demo

- `phone`: `963337953`
- `password`: `123456`

## Endpoint MVP para n8n

`GET /api/bot/config?channel=whatsapp&account=ACCOUNT_WA_DEMO&phone=51999999999`
