// Plantillas de correo del pre-registro (HTML inline simple, card oscura).

/** Aviso AL DUEÑO DE LA PLATAFORMA: pre-registro con correo verificado, listo para aprobar. */
export function newPreRegistrationAdminEmail(params: {
  companyName: string;
  fullName: string;
  email: string;
  phone: string;
  planName: string;
  vertical: string;
  consoleUrl?: string;
}) {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#8a93ab;font-size:13px;">${label}</td><td style="padding:4px 0;color:#e7eaf3;font-size:13px;font-weight:bold;">${value}</td></tr>`;
  return {
    subject: `🔔 Nuevo pre-registro listo para aprobar: ${params.companyName}`,
    html: `
<div style="background:#0d1220;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#151b2e;border-radius:16px;padding:32px 28px;color:#e7eaf3;">
    <h2 style="margin:0 0 6px;font-size:18px;">🔔 Nuevo pre-registro verificado</h2>
    <p style="margin:0 0 16px;color:#8a93ab;font-size:13px;">Un cliente completó su registro en el landing y verificó su correo. Está listo para que lo actives.</p>
    <table style="border-collapse:collapse;">
      ${row("Empresa", params.companyName)}
      ${row("Contacto", params.fullName)}
      ${row("Email", params.email)}
      ${row("Teléfono", `+${params.phone}`)}
      ${row("Plan", params.planName)}
      ${row("Rubro", params.vertical)}
    </table>
    ${
      params.consoleUrl
        ? `<a href="${params.consoleUrl}" style="display:inline-block;margin-top:20px;background:#7c5cff;color:#fff;text-decoration:none;border-radius:10px;padding:10px 18px;font-size:14px;font-weight:bold;">Revisar en el Control Room</a>`
        : ""
    }
  </div>
</div>`,
  };
}

const wrap = (inner: string) => `
<div style="background:#0d1220;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#151b2e;border-radius:16px;padding:32px 28px;color:#e7eaf3;">
    ${inner}
    <p style="margin-top:28px;font-size:12px;color:#8a93ab;">
      Si no solicitaste este registro, puedes ignorar este correo.
    </p>
  </div>
</div>`;

export function verificationCodeEmail(params: { name: string; code: string }) {
  return {
    subject: "Tu código de verificación",
    html: wrap(`
      <h2 style="margin:0 0 8px;font-size:20px;color:#ffffff;">Hola, ${params.name} 👋</h2>
      <p style="margin:0 0 20px;font-size:14px;color:#b7bfd4;">
        Usa este código para verificar tu correo y completar tu registro:
      </p>
      <p style="margin:0 0 20px;text-align:center;font-size:34px;font-weight:bold;letter-spacing:10px;color:#8b7bff;">
        ${params.code}
      </p>
      <p style="margin:0;font-size:13px;color:#8a93ab;">El código vence en 15 minutos.</p>
    `),
  };
}

export function accountActivatedEmail(params: { name: string; username: string; loginUrl?: string }) {
  const button = params.loginUrl
    ? `<p style="margin:24px 0 0;text-align:center;">
         <a href="${params.loginUrl}" style="display:inline-block;background:#6d5cff;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:10px;font-size:14px;font-weight:bold;">
           Iniciar sesión
         </a>
       </p>`
    : "";
  return {
    subject: "¡Tu cuenta está activa! 🎉",
    html: wrap(`
      <h2 style="margin:0 0 8px;font-size:20px;color:#ffffff;">¡Bienvenido, ${params.name}!</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#b7bfd4;">
        Nuestro equipo activó tu cuenta. Ya puedes ingresar al panel con tu celular
        o tu usuario <strong style="color:#e7eaf3;">${params.username}</strong> y la contraseña que elegiste al registrarte.
      </p>
      <p style="margin:0;font-size:13px;color:#8a93ab;">
        Dentro del panel encontrarás la guía de Activación paso a paso y el Centro de ayuda.
      </p>
      ${button}
    `),
  };
}
