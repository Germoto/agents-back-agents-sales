/**
 * Guion del Copiloto en el ASISTENTE DE ARRANQUE (/bienvenida): qué preguntar en
 * cada paso según el rubro, qué herramientas usar y qué no hacer. Se agrega al
 * system prompt solo cuando el front manda mode="onboarding".
 * También da las sugerencias (chips) iniciales por paso y rubro.
 */
import type { BusinessVertical } from "@prisma/client";

export type OnboardingStep = 1 | 2 | 3 | 4;

type V = BusinessVertical;

const STEP1_FIELDS: Record<V, string> = {
  RESTAURANT: "horario de atención por día (businessHours), si hace delivery y a qué zonas, costo y tiempo de envío, si hay recojo en local y la dirección (deliveryConfig: {cost, time, areas[], pickupAvailable, requiresAddress})",
  PHYSICAL_GOODS: "horario de atención, si hace envíos y a qué zonas, costo y tiempo de envío, si hay recojo en tienda y la dirección (deliveryConfig), y si envía a provincias por AGENCIA (Shalom): en ese caso quién paga el flete (va incluido en el precio, es un monto fijo que se suma, o el cliente lo paga al recoger) → proponer_formulario agencyShipping {enabled: true, costMode: 'INCLUIDO' | 'FIJO' | 'PAGA_EN_DESTINO', cost?}",
  SERVICE: "modalidad (presencial, videollamada o ambas), dirección del local, enlace fijo de videollamada (meetingUrl), días y horario de citas (businessHours), duración por defecto de la cita y anticipación mínima",
  REAL_ESTATE: "zonas donde opera, modalidad de visitas, días y horario para visitas (businessHours), duración de una visita",
  INFOPRODUCT: "horario de atención (businessHours) y por qué canal entrega los accesos (WhatsApp, correo o ambos)",
  STREAMER: "horario de atención (businessHours) y cómo entrega las credenciales",
  OTHER: "horario de atención (businessHours) y, si entrega físicamente, zonas, costo y tiempo (deliveryConfig)",
};

const STEP2_HINT: Record<V, string> = {
  RESTAURANT: "platos con sección de la carta (category) y precio; cremas, tamaños y extras van como verticalData.modifierGroups o se proponen después",
  PHYSICAL_GOODS: "productos con precio, categoría y, si aplica, tallas/colores como variantes",
  SERVICE: "servicios con precio y duración en minutos (durationMin); si es online, verticalData.modality",
  REAL_ESTATE: "inmuebles con precio, operación (venta/alquiler), tipo, zona, área y dormitorios (verticalData)",
  INFOPRODUCT: "productos digitales con precio y qué incluye; el link o instrucciones de entrega se piden después",
  STREAMER: "planes con precio y duración en días (verticalData.durationDays)",
  OTHER: "productos o servicios con precio y una línea de descripción",
};

const STEP_NAMES: Record<OnboardingStep, string> = { 1: "Tu negocio", 2: "Tus productos", 3: "Cómo cobras", 4: "Pruébalo" };

export function onboardingScript(vertical: V, step: OnboardingStep): string {
  const common = [
    "=== MODO ASISTENTE DE ARRANQUE ===",
    `El dueño está en el asistente de arranque (/bienvenida), paso ${step} de 4: «${STEP_NAMES[step]}». A la izquierda ve un formulario del paso; tú eres el panel derecho.`,
    "Reglas del modo: UNA pregunta a la vez, frases cortas, cero jerga. No propongas nada fuera del paso actual (ni flujos, ni campañas, ni tienda web). Si el dueño pregunta por otra cosa, respóndele en una línea y vuelve al paso.",
    "Cuando el dueño te DICTE datos del formulario (horario, zonas, Yape…), NO los guardes tú: llama proponer_formulario con los campos para que aparezcan llenos en el formulario; él los confirma con «Continuar». Solo cuando te pida explícitamente guardarlos usa configurar_empresa/configurar_pagos.",
    "Para ofrecer alternativas cortas (sí/no, opciones) usa ofrecer_opciones: el panel las muestra como botones.",
    "La cuenta ya nació con prompt del rubro, tablero de CRM, respuestas rápidas y recordatorios: no los vuelvas a crear; menciónalos solo si ayuda.",
  ];
  const byStep: Record<OnboardingStep, string[]> = {
    1: [
      `Paso 1 — Tu negocio (rubro ${vertical}). Pide, de a uno, estos datos si no están: ${STEP1_FIELDS[vertical]}. Si el dueño te lo dice todo junto, llama proponer_formulario una sola vez con todo.`,
      "Si el rubro no es el correcto, dile que puede cambiarlo con «Cambiar rubro» en este paso (solo mientras no tenga productos).",
      "Termina sugiriendo «Continuar» cuando el formulario tenga lo esencial.",
    ],
    2: [
      `Paso 2 — Tus productos. Pide la FOTO de la carta/lista de precios o la lista en texto. Al recibirla, léela con cuidado y llama proponer_productos con TODOS los ítems (${STEP2_HINT[vertical]}). En este paso NO existe crear_producto: la tabla de la izquierda se llena con tu propuesta y el dueño confirma con «Crear N productos». Tras proponer, responde en UNA frase («Ya están en la tabla: revisa precios y toca Crear») y ofrece botones con ofrecer_opciones: «Están bien» / «Corregir algo».`,
      "Si falta un precio o un nombre no se lee, márcalo en la propuesta con precio vacío y pregunta por ese ítem en una línea.",
      "Correcciones del dueño («el cuarto está a 18») → vuelve a llamar proponer_productos con la lista completa corregida.",
      ...(vertical === "INFOPRODUCT" || vertical === "STREAMER"
        ? ["Después de la lista pregunta UNA vez: «¿Me pasas el link o mensaje de entrega de cada uno, o los entregas tú a mano?». Si te los da, vuelve a proponer con `entrega` por ítem; si los entrega a mano, dile que el agente venderá igual y le avisará a él para entregar."]
        : []),
    ],
    3: [
      "Paso 3 — Cómo cobras. Pide: método (Yape, Plin, transferencia, Mercado Pago), número y nombre del titular tal como aparece en la app (el titular es OBLIGATORIO en cada método: sin él no se guarda), cuándo cobra (antes con captura, contra entrega o que elija el cliente) y el WhatsApp de avisos. Puede tener varios bancos: manda cada uno como un método (method = nombre del banco). Llama proponer_formulario con {methods:[{method, number, holder}], paymentMode, notificationPhone}.",
      "Explica en una línea que el agente lee la captura y valida el pago solo. No pidas datos bancarios completos por chat si el dueño no quiere: puede escribirlos en el formulario.",
      ...(vertical === "PHYSICAL_GOODS"
        ? ["Rubro comercial: pregunta UNA vez si cobra un ADELANTO al tomar el pedido y el saldo después (común en envíos por agencia). Si dice que sí, pide cuánto (monto fijo o porcentaje) y llama proponer_formulario con advance {enabled: true, mode: 'FIXED' | 'PERCENT', value}. Si no, no insistas. Lo fino (avisos al cliente por estado, clave de recojo, cobro distinto por tipo de entrega) se ajusta después en Empresa → Envíos: dilo en una línea solo si usó agencia o adelanto."]
        : []),
    ],
    4: [
      "Paso 4 — Pruébalo. El dueño está chateando con su agente en el simulador. Si te cuenta algo que no le gustó de una respuesta, propón el ajuste concreto (regla o frase del prompt) y aplícalo con configurar_agente SOLO tras su confirmación. Recuérdale que el último paso es conectar WhatsApp con el QR.",
    ],
  };
  return [...common, "", ...byStep[step]].join("\n");
}

export function onboardingSuggestions(vertical: V, step: OnboardingStep): string[] {
  const s1: Record<V, string[]> = {
    RESTAURANT: ["Atiendo de lunes a sábado de 11 a 11", "Hago delivery a 3 distritos y recojo en local", "Solo delivery, sin recojo"],
    PHYSICAL_GOODS: ["Envío a todo Lima, S/ 10, llega en 24 h", "Tengo tienda física para recojo", "Envío a provincias por agencia"],
    SERVICE: ["Atiendo presencial de lunes a viernes de 9 a 7", "Algunas citas son por videollamada", "Mis citas duran 45 minutos"],
    REAL_ESTATE: ["Trabajo venta y alquiler en Lima Sur", "Hago visitas de lunes a sábado por la mañana", "Las visitas duran 30 minutos"],
    INFOPRODUCT: ["Atiendo todos los días de 8 am a 10 pm", "Entrego el acceso por WhatsApp y correo", "Respondo solo en horario de oficina"],
    STREAMER: ["Atiendo todos los días hasta la medianoche", "Entrego las cuentas por WhatsApp", "Tengo stock de cuentas listo"],
    OTHER: ["Atiendo de lunes a sábado", "Hago entregas a domicilio", "Solo atiendo en mi local"],
  };
  const s2: Record<V, string[]> = {
    RESTAURANT: ["Te mando la foto de mi carta", "Te dicto mis platos con precios", "Vendo pollo a la brasa y combos"],
    PHYSICAL_GOODS: ["Te mando la foto de mi lista de precios", "Te dicto mis productos", "Tengo tallas y colores"],
    SERVICE: ["Te dicto mis servicios con precio y duración", "Te mando mi lista de servicios", "Tengo un servicio de diagnóstico gratis"],
    REAL_ESTATE: ["Te paso mis inmuebles con precio y zona", "Tengo 3 departamentos en venta", "Alquilo locales comerciales"],
    INFOPRODUCT: ["Vendo un curso y un pack de recursos", "Te mando mi lista de productos", "Tengo un solo producto"],
    STREAMER: ["Vendo Netflix, Disney y HBO por mes", "Te mando mi lista de planes", "Tengo combos de dos plataformas"],
    OTHER: ["Te mando la foto de mi lista de precios", "Te dicto mis productos", "Tengo pocos productos"],
  };
  const s3 = ["Cobro por Yape y Plin", "También acepto contra entrega", "Avísame de cada pago a otro número"];
  const s4 = ["Me gustó, ¿qué sigue?", "Respondió muy largo, que sea más breve", "No mencionó el tiempo de entrega"];
  return step === 1 ? s1[vertical] : step === 2 ? s2[vertical] : step === 3 ? s3 : s4;
}
