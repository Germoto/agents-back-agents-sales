// Plantilla del correo de entrega del producto digital (misma card oscura que
// los correos de registro). El cuerpo lo escribe el dueño (emailBody) o se
// deriva del mensaje de entrega de WhatsApp (instructions): texto plano →
// HTML escapado con saltos de línea y URLs clicables.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Texto plano → HTML: escapa, linkifica URLs y respeta saltos de línea. */
export function plainTextToHtml(text: string): string {
  const escaped = escapeHtml(text.trim());
  const linked = escaped.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" style="color:#8b7bff;word-break:break-all;">${url}</a>`,
  );
  return linked.replace(/\r?\n/g, "<br>");
}

export interface DeliveryEmailSection {
  productName: string;
  bodyText: string;
  /** Archivos que NO pudieron ir adjuntos (exceso de tamaño): se listan como links. */
  links: Array<{ name: string; url: string }>;
}

export function digitalDeliveryEmail(params: {
  companyName: string;
  customerName?: string | null;
  sections: DeliveryEmailSection[];
  attachmentCount: number;
}) {
  const greeting = params.customerName ? `Hola, ${escapeHtml(params.customerName)} 👋` : "Hola 👋";
  const sectionsHtml = params.sections
    .map((s) => {
      const links = s.links.length
        ? `<p style="margin:14px 0 4px;font-size:13px;color:#8a93ab;">Archivos (por tamaño van como enlaces):</p><ul style="margin:0;padding-left:18px;font-size:13px;">${s.links
            .map((l) => `<li><a href="${l.url}" style="color:#8b7bff;">${escapeHtml(l.name)}</a></li>`)
            .join("")}</ul>`
        : "";
      return `
      <div style="margin:0 0 22px;padding:16px 18px;background:#0f1424;border-radius:12px;">
        <h3 style="margin:0 0 10px;font-size:15px;color:#ffffff;">${escapeHtml(s.productName)}</h3>
        <div style="font-size:14px;line-height:1.55;color:#d7dcea;">${plainTextToHtml(s.bodyText)}</div>
        ${links}
      </div>`;
    })
    .join("");
  const attachNote =
    params.attachmentCount > 0
      ? `<p style="margin:0 0 16px;font-size:13px;color:#8a93ab;">📎 Este correo incluye ${params.attachmentCount} archivo(s) adjunto(s).</p>`
      : "";
  const text = params.sections
    .map((s) => `${s.productName}\n\n${s.bodyText}${s.links.length ? `\n\nArchivos:\n${s.links.map((l) => `- ${l.name}: ${l.url}`).join("\n")}` : ""}`)
    .join("\n\n----------------\n\n");
  return {
    html: `
<div style="background:#0d1220;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#151b2e;border-radius:16px;padding:32px 28px;color:#e7eaf3;">
    <h2 style="margin:0 0 6px;font-size:19px;color:#ffffff;">${greeting}</h2>
    <p style="margin:0 0 20px;font-size:14px;color:#b7bfd4;">Aquí tienes tu acceso de <strong style="color:#e7eaf3;">${escapeHtml(params.companyName)}</strong>, tal como lo pediste.</p>
    ${attachNote}
    ${sectionsHtml}
    <p style="margin:8px 0 0;font-size:12px;color:#8a93ab;">Si tienes dudas, respóndenos por WhatsApp. Este correo fue enviado por ${escapeHtml(params.companyName)} a través de FlowApp.</p>
  </div>
</div>`,
    text: `${params.customerName ? `Hola, ${params.customerName}` : "Hola"}\n\nAquí tienes tu acceso de ${params.companyName}.\n\n${text}\n\n— ${params.companyName} (vía FlowApp)`,
  };
}
