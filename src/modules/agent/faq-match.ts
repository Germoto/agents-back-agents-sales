/**
 * Match determinístico consulta ↔ FAQ/objeción configurada del producto.
 *
 * El modelo a veces ignora la FAQ aunque esté en el prompt (las reglas de
 * herramientas capturan la intención — pasó en prod: pedía una "muestra" de un
 * tema y el modelo enviaba un archivo de OTRO tema con enviar_multimedia). Igual
 * que la validación forzada de pagos, esto no puede depender solo del modelo:
 * si la consulta del cliente coincide claramente con una FAQ, se inyecta un
 * mensaje de sistema AL FINAL del turno (recency) con la respuesta configurada
 * y la instrucción de usarla. 100% genérico: puro solapamiento de tokens, sin
 * ningún tema/nicho hardcodeado.
 */

// Palabras funcionales del español (y ruido típico de chat) que no aportan tema.
const STOPWORDS = new Set([
  "que", "qué", "como", "cómo", "cual", "cuál", "cuales", "cuáles", "quien", "quién",
  "donde", "dónde", "cuando", "cuándo", "cuanto", "cuánto", "cuanta", "cuánta",
  "los", "las", "les", "una", "uno", "unos", "unas", "del", "por", "para", "con",
  "sin", "sobre", "entre", "desde", "hasta", "este", "esta", "esto", "estos", "estas",
  "ese", "esa", "eso", "esos", "esas", "aquel", "aquella", "hay", "tiene", "tienes",
  "tengo", "tienen", "quiero", "quieres", "quisiera", "puedo", "puede", "pueden",
  "podria", "podría", "algun", "algún", "alguna", "alguno", "algunos", "algunas",
  "mas", "más", "pero", "porque", "por que", "por qué", "también", "tambien",
  "ustedes", "usted", "ellos", "ellas", "nosotros", "vos", "the", "and", "for",
  "son", "está", "esta", "están", "estan", "ser", "estar", "hacer", "dame", "pasa",
  "pasame", "pásame", "manda", "mandame", "mándame", "envia", "envía", "enviame",
  "favor", "porfa", "hola", "buenas", "buenos", "dias", "días", "tardes", "noches",
]);

/** Normaliza y tokeniza: minúsculas, sin tildes, stem ligero (plural + vocal final). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map((t) => t.replace(/(?:es|s)$/, "").replace(/[aoe]$/, ""))
    .filter((t) => t.length >= 3);
}

interface KnowledgeItem {
  question: string;
  answer: string;
}

interface KnowledgeProduct {
  id: string;
  name: string;
  faqs?: KnowledgeItem[];
  objections?: KnowledgeItem[];
}

/**
 * Busca la FAQ/objeción cuya pregunta mejor cubre la consulta del cliente.
 * Devuelve el mensaje de sistema a inyectar, o null si nada matchea con
 * suficiente confianza (≥2 tokens significativos y ≥60% de la pregunta cubierta).
 */
export function buildKnowledgeHint(
  products: KnowledgeProduct[],
  selectedProductId: string | null | undefined,
  inboundText: string,
): string | null {
  const inbound = new Set(tokenize(inboundText));
  if (inbound.size === 0) return null;

  let best: { score: number; item: KnowledgeItem; product: KnowledgeProduct; kind: string } | null = null;

  for (const p of products) {
    const focusBoost = p.id === selectedProductId ? 0.05 : 0;
    const sources: Array<{ items: KnowledgeItem[]; kind: string }> = [
      { items: p.faqs ?? [], kind: "FAQ" },
      { items: p.objections ?? [], kind: "objeción" },
    ];
    for (const src of sources) {
      for (const item of src.items) {
        const qTokens = tokenize(item.question);
        if (!qTokens.length) continue;
        const matched = qTokens.filter((t) => inbound.has(t)).length;
        const coverage = matched / qTokens.length;
        const minMatched = qTokens.length <= 2 ? 1 : 2;
        if (matched < minMatched || coverage < 0.6) continue;
        const score = coverage + focusBoost;
        if (!best || score > best.score) best = { score, item, product: p, kind: src.kind };
      }
    }
  }

  if (!best) return null;

  return [
    `CONTEXTO DEL SISTEMA (no menciones este bloque): la consulta del cliente corresponde a esta ${best.kind} configurada del producto "${best.product.name}":`,
    `Pregunta configurada: ${best.item.question}`,
    `Respuesta configurada: ${best.item.answer}`,
    "",
    "Instrucción OBLIGATORIA para este turno: responde al cliente usando ESA respuesta configurada como base. Transmite su contenido COMPLETO, incluyendo TODOS los enlaces/URLs tal cual aparecen (cópialos carácter por carácter). Puedes adaptar el tono, NO el contenido. NO llames a enviar_multimedia en este turno salvo que el cliente haya pedido explícitamente un archivo del catálogo cuyo tema coincida con su pedido. Cierra con UNA pregunta breve que avance la venta.",
  ].join("\n");
}

/** Texto de los mensajes USER consecutivos del final del historial (ráfaga del debounce). */
export function trailingUserText(history: Array<{ role: string; content?: unknown }>): string {
  const parts: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user") break;
    if (typeof m.content === "string" && m.content.trim()) parts.unshift(m.content.trim());
  }
  return parts.join("\n");
}
