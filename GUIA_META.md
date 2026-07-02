# Guía: conectar WhatsApp con la API oficial de Meta (Cloud API)

Guía desde cero para quien nunca trabajó con la API de Meta. La plataforma
soporta **dos proveedores** de WhatsApp por cliente (tenant), y solo uno está
activo a la vez:

- **SMS Tools** (lo actual): se conecta escaneando un QR, como WhatsApp Web.
- **API oficial de Meta** (esta guía): número dedicado conectado a la nube de Meta.

---

## Lo más importante: hay DOS niveles de configuración

| Nivel | Qué es | Dónde se configura | ¿Por cliente? |
|---|---|---|---|
| **SISTEMA** | UNA app de Meta para TODA la plataforma (es tuya, del dueño) | Variables del `.env` | ❌ No. Una sola, para todos |
| **CLIENTE** | El número de WhatsApp de cada cliente | Panel → WhatsApp API → API oficial de Meta | ✅ Sí. Uno por tenant |

**Analogía:** tu app de Meta es el *edificio* (una, tuya). El número de cada
cliente es un *departamento* dentro del edificio (uno por inquilino). El `.env`
son las llaves maestras del edificio; el formulario del panel es la llave de
cada departamento.

---

## Parte 1 — Variables del `.env` (nivel SISTEMA, se hace UNA vez)

Estas 4 variables describen **tu única app de Meta**. Son iguales para todos los
clientes. No van por tenant.

| Variable | Qué es | De dónde sale |
|---|---|---|
| `META_GRAPH_VERSION` | Versión de la API de Meta | Déjala en `v21.0` |
| `META_APP_SECRET` | La "contraseña" de tu app de Meta. Verifica que los webhooks vengan de verdad de Meta | Meta for Developers → tu App → Configuración → Básico → "Clave secreta de la app" |
| `META_WEBHOOK_VERIFY_TOKEN` | Un texto secreto que **tú inventas**. Meta lo usa para confirmar que la URL del webhook es tuya | Lo inventas tú (cualquier texto largo) |
| `CREDENTIALS_ENC_KEY` | Llave para cifrar en la base de datos los tokens de tus clientes (AES-256) | Se genera con el comando de abajo |

Generar la clave de cifrado:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ En producción usa una `CREDENTIALS_ENC_KEY` **distinta** a la de local, y no
> la cambies después: si la cambias, los tokens ya cifrados dejan de poder
> descifrarse y los clientes tendrían que volver a pegar sus credenciales.

---

## Parte 2 — Crear tu app de Meta (nivel SISTEMA, se hace UNA vez)

1. **Cuenta de Meta Business**: entra a https://business.facebook.com y crea o usa
   tu cuenta de empresa.
2. **Crear la app**: ve a https://developers.facebook.com → "Mis apps" → "Crear
   app" → tipo **"Empresa"** → agrégale el producto **"WhatsApp"**.
3. **Copiar el App Secret**: en tu app → Configuración → Básico → copia la "Clave
   secreta de la app" → pégala en `META_APP_SECRET`.
4. **Número de prueba gratis**: al agregar WhatsApp, Meta te da un número de
   prueba + un token temporal. Sirve para probar **sin costo** y sin verificar tu
   negocio (envía a hasta 5 números que registres). Perfecto para empezar.

---

## Parte 3 — Conectar el webhook (nivel SISTEMA, se hace UNA vez)

Para que Meta avise a tu backend cuando llega un mensaje, tu backend debe ser
accesible por internet con HTTPS.

**En local** se usa un túnel. Con [ngrok](https://ngrok.com):

```bash
ngrok http 3000
# te da una URL tipo https://abc123.ngrok.io
```

En tu app de Meta → WhatsApp → Configuración → **Webhooks**:

- **URL de callback:** `https://abc123.ngrok.io/api/meta/webhook`
  (en producción: `https://TU-DOMINIO/api/meta/webhook`)
- **Token de verificación:** el MISMO valor de `META_WEBHOOK_VERIFY_TOKEN`.
- **Suscribirse al campo:** `messages`.

Meta hará una llamada de verificación; si el token coincide, queda conectado.

> Comprobar el webhook manualmente (debe responder `12345`):
> ```bash
> curl "http://localhost:3000/api/meta/webhook?hub.mode=subscribe&hub.verify_token=TU_VERIFY_TOKEN&hub.challenge=12345"
> ```

---

## Parte 4 — Conectar el número de UN cliente (se repite POR CADA cliente)

Esto es lo que se llena en el panel: **Panel → WhatsApp API → pestaña "API oficial
de Meta"**. Se necesitan 3 datos, todos de la pantalla de Meta (WhatsApp →
Configuración de la API):

1. **Phone Number ID** — aparece debajo del número del cliente.
2. **WABA ID** (WhatsApp Business Account ID) — en la misma pantalla.
3. **Access token (permanente)** — ⚠️ el token que Meta muestra "a la mano" es
   **temporal (24h)**. Para uno permanente:
   - Meta Business → Configuración → **Usuarios del sistema** → crear uno.
   - Generar token con permisos **`whatsapp_business_messaging`** y
     **`whatsapp_business_management`**.
   - Ese token no expira → es el que se pega en el panel.

Con los 3 datos → botón **"Guardar y validar"**. El backend valida el token
contra Meta **antes** de guardar; si está bien, el semáforo "Estado de la
conexión" se pone verde y ese cliente ya envía/recibe por Meta en vez de SMS Tools.

---

## Parte 5 — La ventana de 24 horas y las plantillas

Regla de Meta (no es opcional, es de Meta): **solo puedes enviar mensajes libres
dentro de las 24 horas siguientes al último mensaje del cliente.**

- El **agente/chatbot** casi nunca se ve afectado: responde a un mensaje que
  acaba de llegar, o sea dentro de la ventana.
- Los **recordatorios** y las **campañas** a clientes que no escribieron en 24h
  SÍ se ven afectados: fuera de ventana, Meta exige una **plantilla aprobada**.

Qué hace la plataforma (configurado por el dueño/cliente):
- Si hay una **plantilla configurada** (en Recordatorios → Horario, y en cada
  campaña), fuera de ventana se envía esa plantilla.
- Si **no hay plantilla**, el envío se **omite** y queda registrado con el motivo
  (no se pierde silenciosamente).

Las plantillas se crean y se aprueban **en Meta** (WhatsApp Manager → Plantillas
de mensajes). Una vez aprobadas, aparecen en los selectores del panel.

---

## Diferencias clave: SMS Tools vs Meta oficial

| | SMS Tools | Meta oficial |
|---|---|---|
| Conexión | QR en 2 minutos | Crear app + credenciales + webhook |
| Verificación del negocio | No | Sí (para pasar del número de prueba a producción) |
| Número | Cualquiera, con la app normal | Número **dedicado** (no se usa en la app de WhatsApp) |
| Costo | Sin costo por mensaje | Costo por conversación (según categoría) |
| Ventana 24h / plantillas | No aplica | Aplica |
| Riesgo de baneo | Sí (es no oficial) | No (es oficial) |
| Escribir en frío | Libre | Solo con plantillas aprobadas |

---

## Checklist rápido

**Una vez (sistema):**
- [ ] Crear cuenta Meta Business + app con producto WhatsApp
- [ ] `META_APP_SECRET` en el `.env` (Configuración → Básico)
- [ ] `META_WEBHOOK_VERIFY_TOKEN` en el `.env` (lo inventas tú)
- [ ] `CREDENTIALS_ENC_KEY` en el `.env` (generada con el comando)
- [ ] Webhook en Meta apuntando a `/api/meta/webhook`, suscrito a `messages`
- [ ] `PUBLIC_BASE_URL` debe ser HTTPS público (Meta descarga la multimedia por link)

**Por cada cliente (tenant):**
- [ ] Phone Number ID, WABA ID y Access token permanente (System User)
- [ ] Pegarlos en Panel → WhatsApp API → API oficial de Meta → "Guardar y validar"
- [ ] (Opcional) Plantillas aprobadas para recordatorios/campañas fuera de ventana
