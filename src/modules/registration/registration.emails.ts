// Plantillas de correo del pre-registro (HTML inline simple, card oscura).

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
