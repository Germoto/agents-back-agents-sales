# API pública de pagos para n8n

API HTTP sin token. Identifica la compañía con `?phone=+51...` (teléfono de
un usuario admin activo), mismo mecanismo que `/api/bot/config`.

Base URL prod: `https://api-sales-agents.molanosoft.com/api/public/payments`

---

## Flujo recomendado para autovalidación n8n

```
ValidPay (webhook)
   │ POST → /api/webhooks/payments/:companyId  (HMAC)
   ▼
Backend crea PaymentReceipt
   • status = PENDIENTE
   • amountPaid = monto recibido
   • currency = PEN
   • payerName, paymentSource, occurredAt
   • payerPhone / operationCode / reference si vinieron
   • sin customer ni product (huérfano)
   ▼
n8n hace polling o trigger:
   1) POST /match (busca candidatos por monto + nombre + ventana de tiempo)
   2) POST /:id/claim (lock con TTL para evitar doble proceso)
   3) Pregunta al cliente por WhatsApp / valida lo necesario
   4) PATCH /:id/status APROBADO|RECHAZADO
        envía customerPhone, productId/productIds, validationMode, matchScore, etc.
        → libera el claim automáticamente
```

---

## Modelo de respuesta común

Cada `PaymentReceipt` se serializa con:

```json
{
  "id": "uuid",
  "companyId": "uuid",
  "source": "validpay",
  "externalId": "cmprbfe0s00372vqe60zme6ls",
  "amountExpected": "9.99",
  "amountPaid": "9.99",
  "currency": "PEN",
  "status": "PENDIENTE",
  "payerName": "JUAN PEREZ",
  "paymentSource": "YAPE",
  "payerPhone": null,
  "operationCode": null,
  "reference": null,
  "occurredAt": "2026-05-29T15:30:00.000Z",
  "validatedAt": null,
  "validationMode": null,
  "matchScore": null,
  "matchStrategy": null,
  "matchedPayerNameInput": null,
  "validationNote": null,
  "rejectionReason": null,
  "customerId": null,
  "productId": null,
  "productIds": [],
  "orderId": null,
  "metadata": null,
  "claimedBy": null,
  "claimedUntil": null,
  "customer": null,
  "product": null,
  "createdAt": "2026-05-29T15:30:05.123Z",
  "updatedAt": "2026-05-29T15:30:05.123Z"
}
```

> `amountExpected` se mantiene como **alias retrocompatible** de `amountPaid`.
> Para integraciones nuevas usa `amountPaid`. Frontend y consumidores nuevos deberían leer
> `amountPaid` y `currency`.

---

## Endpoints

### 1) `GET /pending`

Lista comprobantes filtrables.

**Query params**

| Campo          | Tipo      | Default     | Notas |
|----------------|-----------|-------------|-------|
| `phone`        | string    | (requerido) | Phone admin |
| `limit`        | number    | 50          | 1–200 |
| `since`        | datetime  | —           | filtra `createdAt >= since` |
| `source`       | string    | —           | ej. `validpay` |
| `status`       | enum      | `PENDIENTE` | `PENDIENTE`/`EN_REVISION`/`APROBADO`/`RECHAZADO` |
| `amountPaid`   | string\|num | —         | match exacto (normalizado a 2 decimales) |
| `payerName`    | string    | —           | match parcial, case-insensitive |
| `occurredFrom` | datetime  | —           | rango `occurredAt` |
| `occurredTo`   | datetime  | —           | rango `occurredAt` |
| `paymentSource`| string    | —           | `YAPE`, `PLIN`, etc. (case-insensitive) |

**Ejemplo**
```bash
curl "https://api-sales-agents.molanosoft.com/api/public/payments/pending?phone=+51928018265&source=validpay&amountPaid=9.99&payerName=juan&occurredFrom=2026-05-29T15:00:00.000Z&occurredTo=2026-05-29T15:40:00.000Z"
```

---

### 2) `POST /match`

Devuelve candidatos PENDIENTES rankeados por similitud. **No modifica nada**.

`?phone=+51...`

**Body**
```json
{
  "amountPaid": "9.99",
  "payerName": "Juan Perez",
  "paymentSource": "YAPE",
  "occurredFrom": "2026-05-29T15:00:00.000Z",
  "occurredTo": "2026-05-29T15:40:00.000Z",
  "source": "validpay",
  "limit": 10
}
```

**Scoring** (suma):

| Razón                  | Puntos |
|------------------------|--------|
| `amount_exact`         | +50    |
| `payer_name_exact`     | +30    |
| `payer_name_similar`   | +20    |
| `time_window`          | +15    |
| `payment_source_match` | +5     |

`payer_name_similar` se calcula con normalización (sin acentos, lowercase),
substring, tokens compartidos ≥ 3 caracteres y/o distancia de Levenshtein ≤ 30%.

**Respuesta**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "source": "validpay",
      "externalId": "xxx",
      "amountPaid": "9.99",
      "currency": "PEN",
      "payerName": "JUAN PEREZ",
      "paymentSource": "YAPE",
      "occurredAt": "2026-05-29T15:30:00.000Z",
      "status": "PENDIENTE",
      "matchScore": 95,
      "matchReasons": ["amount_exact", "payer_name_similar", "time_window"],
      "...": "resto del modelo común"
    }
  ]
}
```

---

### 3) `POST /:id/claim`

Lock con TTL para evitar doble procesamiento entre ejecuciones de n8n.

`?phone=+51...`

**Body**
```json
{
  "claimedBy": "n8n-execution-12345",
  "claimTtlSeconds": 120
}
```

- `claimTtlSeconds` rango 5..600, default 120.
- Solo se permite si:
  - `status = PENDIENTE`, **o**
  - `status = EN_REVISION` y `claimedUntil < now` (claim expirado).
- Devuelve `409` si está claimed vigente o si está APROBADO/RECHAZADO.
- Setea `status = EN_REVISION`, `claimedBy`, `claimedUntil`.

**Ejemplo**
```bash
curl -X POST "https://api-sales-agents.molanosoft.com/api/public/payments/<id>/claim?phone=+51928018265" \
  -H "Content-Type: application/json" \
  -d '{"claimedBy":"n8n-runA","claimTtlSeconds":120}'
```

**Respuesta**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "EN_REVISION",
    "claimedBy": "n8n-runA",
    "claimedUntil": "2026-05-29T15:32:00.000Z",
    "...": "resto del modelo común"
  }
}
```

---

### 4) `GET /:id`

Detalle de un comprobante. Valida pertenencia a la company.

```bash
curl "https://api-sales-agents.molanosoft.com/api/public/payments/<id>?phone=+51928018265"
```

---

### 5) `PATCH /:id/status`

Aprueba o rechaza. **Body 100% retrocompatible**: solo agrega campos opcionales.

`?phone=+51...`

**Body**
```json
{
  "status": "APROBADO",
  "reason": "opcional (alias: rejectionReason), recomendado en RECHAZADO",
  "rejectionReason": "alias de reason — cualquiera de los dos funciona",

  "customerPhone": "+51999999999",
  "customerName": "Juan Pérez",

  "productId": "uuid-real",
  "productIds": ["uuid-1", "uuid-2"],
  "orderId": "ORD-2026-0001",
  "expectedAmount": "19.99",

  "validationMode": "AUTO",
  "matchScore": 95,
  "matchStrategy": "amount_name_time",
  "matchedPayerNameInput": "Juan Perez",

  "note": "Aprobado automáticamente por n8n",
  "metadata": {
    "conversationKey": "company:phone",
    "waPhone": "+51999999999",
    "cartTotal": "19.99",
    "matchedBy": "n8n"
  }
}
```

**Reglas**
- `status` ∈ `APROBADO | RECHAZADO`. Para `EN_REVISION` usar `/claim`.
- Solo se acepta si el receipt está en `PENDIENTE` o `EN_REVISION` con TTL no expirado.
- Si el claim expiró, devuelve `409` indicando re-claim.
- `productIds` toma prioridad sobre `productId`. `productId` se setea al primer elemento de `productIds` para compatibilidad.
- Todos los `productIds` deben pertenecer a la company.
- Si `customerPhone` no existe en la company, se crea Customer con `metadata.origin = "n8n-public-api"`.
- `expectedAmount` no es columna; se persiste dentro de `metadata.expectedAmount` (auditoría de diferencia con `amountPaid`).
- Al cerrar (APROBADO/RECHAZADO) se libera el claim (`claimedBy`/`claimedUntil` → `null`).
- `metadata` hace **merge** con la metadata existente (no la reemplaza).

**Ejemplos**

Aprobar carrito multi-producto:
```bash
curl -X PATCH "https://api-sales-agents.molanosoft.com/api/public/payments/<id>/status?phone=+51928018265" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "APROBADO",
    "customerPhone": "+51999111222",
    "customerName": "Juan Pérez",
    "productIds": ["uuid-prod-1", "uuid-prod-2"],
    "orderId": "ORD-2026-0001",
    "expectedAmount": "19.99",
    "validationMode": "AUTO",
    "matchScore": 95,
    "matchStrategy": "amount_name_time",
    "matchedPayerNameInput": "Juan Perez",
    "metadata": {"conversationKey": "company:phone", "matchedBy": "n8n"}
  }'
```

Rechazar:
```bash
curl -X PATCH "https://api-sales-agents.molanosoft.com/api/public/payments/<id>/status?phone=+51928018265" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "RECHAZADO",
    "reason": "Monto no coincide con la compra pendiente",
    "validationMode": "MANUAL"
  }'
```

---

## Errores comunes

Todas las respuestas de error siguen el mismo shape:

```json
{
  "success": false,
  "message": "Mensaje legible",
  "code": "CODIGO_ESTANDAR",
  "errors": [
    { "field": "productId", "message": "'slug-inexistente' no pertenece a esta compañía o no existe" }
  ]
}
```

`code` y `errors` solo aparecen cuando corresponde.

### Tabla de códigos

| HTTP | `code`                    | Causa |
|------|---------------------------|-------|
| 400  | `USE_CLAIM_ENDPOINT`      | Se intentó `status=EN_REVISION` en PATCH `/status` |
| 403  | `PHONE_NOT_AUTHORIZED`    | El phone no pertenece a un usuario admin activo |
| 404  | `RECEIPT_NOT_FOUND`       | Comprobante no existe o no es de esta company |
| 404  | `PRODUCT_NOT_FOUND`       | Uno o más `productId`/`productIds` no existen para esta company |
| 409  | `PAYMENT_ALREADY_APPROVED`| El comprobante ya está APROBADO |
| 409  | `PAYMENT_ALREADY_REJECTED`| El comprobante ya está RECHAZADO |
| 409  | `CLAIM_EXPIRED`           | El TTL del claim expiró antes de cerrar; hay que reclamar de nuevo |
| 409  | `CLAIM_HELD_BY_OTHER`     | El comprobante tiene claim vigente de otro proceso |
| 422  | `VALIDATION_FAILED`       | Fallo de validación Zod; `errors[]` detalla campo y mensaje |

---

## Notas de seguridad / multi-tenant

- Todos los endpoints filtran por `companyId` resuelto desde `phone`.
- `productId` y cada `productIds[i]` se validan que pertenecen a la company.
- El `PaymentReceipt` resuelto debe pertenecer a la company del `phone`.
- Idempotencia del webhook garantizada por `(source, externalId)`. Reintentos de ValidPay no duplican.

---

## Migración / compatibilidad

- `amountExpected` sigue presente y refleja `amountPaid` en webhooks nuevos.
- Body antiguo de `PATCH /:id/status` (`status`+`customerPhone`+`customerName`+`productId`+`note`) sigue funcionando sin cambios.
- `GET /pending` sin filtros nuevos sigue funcionando idéntico.

---

## Contrato `/api/bot/config` (productos)

> **⚠️ BREAKING** (mayo 2026): el campo `id` de cada producto en la respuesta de
> `/api/bot/config` cambió de **slug** (ej: `"pack-mundial-2026-pdf"`) a **UUID real**
> (ej: `"6dc6dbcd-c775-4ae5-965a-bf2df4654d20"`).

### Shape de producto en `/api/bot/config`

```json
{
  "id": "6dc6dbcd-c775-4ae5-965a-bf2df4654d20",
  "slug": "pack-mundial-2026-pdf",
  "code": "pack-mundial-2026-pdf",
  "name": "Pack de Álbum del Mundial 2026 en PDF",
  "productType": "digital",
  "active": true,
  "price": "5",
  "priceText": "S/ 5",
  "regularPrice": "69",
  "regularPriceText": "S/ 69",
  "aliases": ["mundial", "album mundial", "pack mundial pdf"],
  "shortDescription": "...",
  "fullDescription": "...",
  "digitalDelivery": {
    "link": "https://drive.google.com/...",
    "instructions": "Mensaje postventa"
  }
}
```

### Guía de uso en n8n

| Campo | Uso recomendado |
|-------|----------------|
| `id`  | Usar como `productId`/`productIds` en `PATCH /payments/:id/status` |
| `slug` / `code` | Identificación textual/conversacional, URLs, alias |
| `name` / `aliases` | Detección de intención del cliente por texto |
| `priceText` / `regularPriceText` | Mostrar precio formateado al cliente en WhatsApp |

> `priceText` y `regularPriceText` usan símbolo `S/` (soles peruanos).
> Cuando se agregue `Company.currencySymbol` a la DB, se leerá automáticamente.
