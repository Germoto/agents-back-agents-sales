// Correos transaccionales de auth (recuperación de contraseña).

const wrap = (inner: string) => `
<div style="background:#0d1220;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#151b2e;border-radius:16px;padding:32px 28px;color:#e7eaf3;">
    ${inner}
    <p style="margin-top:28px;font-size:12px;color:#8a93ab;">
      Si no solicitaste este cambio, puedes ignorar este correo: tu contraseña actual sigue vigente.
    </p>
  </div>
</div>`;

export function passwordResetCodeEmail(params: { name: string; code: string }) {
  return {
    subject: "Restablece tu contraseña",
    html: wrap(`
      <h2 style="margin:0 0 8px;font-size:20px;color:#ffffff;">Hola, ${params.name} 👋</h2>
      <p style="margin:0 0 20px;font-size:14px;color:#b7bfd4;">
        Usa este código para restablecer tu contraseña:
      </p>
      <p style="margin:0 0 20px;text-align:center;font-size:34px;font-weight:bold;letter-spacing:10px;color:#8b7bff;">
        ${params.code}
      </p>
      <p style="margin:0;font-size:13px;color:#8a93ab;">El código vence en 15 minutos.</p>
    `),
  };
}
