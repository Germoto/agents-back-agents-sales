# API pública de pagos para n8n

API HTTP sin token. Identifica la compañía con `?phone=+51...` (teléfono de
un usuario admin activo), mismo mecanismo que `/api/bot/config`.

Base URL prod: `https://api-sales-agents.molanosoft.com/api/public/payments`

---

## Flujo general

1. ValidPay emite webhook → backend agents-sales registra un `PaymentReceipt`
   con `source="validpay"`, `status="PENDIENTE"`, sin cliente ni producto.
2. n8n consulta periódicamente (o por trigger) los comprobantes pendientes.
3. n8n cruza con su conversación de WhatsApp para decidir aprobar/rechazar,
   y opcionalmente envía `customerPhone` + `productId` para asociar el
   comprobante al cliente y producto reales.

---

## Endpoints

### `GET /pending`

Lista comprobantes con `status=PENDIENTE` de la compañía resuelta por `phone`.

**Query params**
| Campo  | Tipo    | Requerido | Notas |
|--------|---------|-----------|-------|
| phone  | string  | sí        | Phone admin (con o sin `+`) |
| limit  | number  | no        | 1–200, default 50 |
| since  | string  | no        | ISO datetime, filtra `createdAt >= since` |
| source | string  | no        | Ej. `validpay` |

**Ejemplo**
```bash
curl "https://api-sales-agents.molanosoft.com/api/public/payments/pending?phone=+51928018265&source=validpay&limit=20"
```

**Respuesta**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "companyId": "uuid",
      "source": "validpay",
      "externalId": "cmprbfe0s00372vqe60zme6ls",
      "amountExpected": "49.90",
      "status": "PENDIENTE",
      "payerName": "JUAN PEREZ",
      "paymentSource": "YAPE",
      "occurredAt": "2026-05-29T15:30:00.000Z",
      "validatedAt": null,
      "validationNote": null,
      "rejectionReason": null,
      "customerId": null,
      "productId": null,
      "customer": null,
      "product": null,
      "createdAt": "2026-05-29T15:30:05.123Z",
      "updatedAt": "2026-05-29T15:30:05.123Z"
    }
  ]
}
```

---

### `GET /:id`

Detalle de un comprobante. Valida que pertenece a la company del `phone`.

```bash
curl "https://api-sales-agents.molanosoft.com/api/public/payments/<id>?phone=+51928018265"
```

---

### `PATCH /:id/status`

Aprueba o rechaza el comprobante. n8n puede asociar customer y product en el
mismo request.

**Body**
```json
{
  "status": "APROBADO" | "RECHAZADO",
  "reason": "opcional, requerido en la práctica si RECHAZADO",
  "customerPhone": "+51999999999",
  "customerName": "Juan Pérez",
  "productId": "uuid-del-producto",
  "note": "nota libre opcional"
}
```

- Solo se permite actualizar comprobantes en estado `PENDIENTE`.
- Si `customerPhone` viene y no existe un Customer con ese phone en la
  compañía, se crea uno con `origin=n8n-public-api`.
- Si `productId` viene, debe pertenecer a la misma compañía.
- `validatedAt` se setea automáticamente al momento del request.

**Ejemplo aprobar**
```bash
curl -X PATCH "https://api-sales-agents.molanosoft.com/api/public/payments/<id>/status?phone=+51928018265" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "APROBADO",
    "customerPhone": "+51999111222",
    "customerName": "Juan Pérez",
    "productId": "uuid-del-producto"
  }'
```

**Ejemplo rechazar**
```bash
curl -X PATCH "https://api-sales-agents.molanosoft.com/api/public/payments/<id>/status?phone=+51928018265" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "RECHAZADO",
    "reason": "Monto no coincide con la compra pendiente"
  }'
```

---

## Errores comunes

| HTTP | Causa |
|------|-------|
| 400  | Body/query inválido (zod) |
| 403  | El phone no pertenece a un usuario admin activo |
| 404  | Comprobante no existe o no es de esta company |
| 409  | El comprobante ya no está en estado PENDIENTE |
| 422  | productId no pertenece a la company |

---

## Notas para integración n8n

- El webhook de ValidPay crea siempre el comprobante en `PENDIENTE` y huérfano
  (sin product/customer). La lógica de matching la decide n8n.
- Idempotencia garantizada en backend por `(source, externalId)`; reintentos
  desde ValidPay no duplican.
- Para evitar carreras, conviene pollear `GET /pending?since=...` con marca de
  tiempo de la última lectura procesada por n8n.
