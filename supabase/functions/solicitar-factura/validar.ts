// ─────────────────────────────────────────────────────────────────────────────
// Validaciones puras de solicitar-factura (sin red, sin Deno): se prueban con Node
// (ver scratchpad/solicitar-factura-test.mjs).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_PENDIENTES_POR_MEDICO = 5;

// Largos máximos (caracteres) de cada campo del formulario.
const MAX = { nombre: 120, domicilio: 160, email: 120, iva: 60, plan: 60, periodo: 40, obs: 500 };

// Caracteres de control (salvo salto de línea y tabulación) y separadores de línea Unicode.
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g;

const EMAIL_RE = /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]{2,}$/;

// Una sola línea: sin saltos ni caracteres de control (evita inyectar líneas falsas en el aviso).
export function limpiarLinea(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(CONTROL_RE, "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

// Texto libre: conserva los saltos de línea, saca los caracteres de control.
export function limpiarTexto(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n/g, "\n").replace(CONTROL_RE, "").trim().slice(0, max);
}

export interface Solicitud {
  nombre: string;
  cuit: string; // 11 dígitos, sin guiones
  email: string;
  domicilio: string;
  condicion_iva: string;
  plan: string;
  periodo: string;
  observaciones: string;
}

export type Resultado<T> = { ok: true; datos: T } | { ok: false; error: string };

export function validarSolicitud(body: Record<string, unknown>): Resultado<Solicitud> {
  const nombre = limpiarLinea(body.nombre, MAX.nombre);
  if (!nombre) return { ok: false, error: "Ingresá el nombre o razón social." };

  const cuit = (typeof body.cuit === "string" ? body.cuit : "").replace(/[\s.\-]/g, "");
  if (!/^\d{11}$/.test(cuit)) return { ok: false, error: "El CUIT tiene que tener 11 números (por ejemplo 20-12345678-9)." };

  const email = limpiarLinea(body.email, MAX.email);
  if (!EMAIL_RE.test(email)) return { ok: false, error: "El email de facturación no es válido." };

  const domicilio = limpiarLinea(body.domicilio, MAX.domicilio);
  if (!domicilio) return { ok: false, error: "Ingresá el domicilio comercial." };

  return {
    ok: true,
    datos: {
      nombre,
      cuit,
      email,
      domicilio,
      condicion_iva: limpiarLinea(body.condicion_iva, MAX.iva),
      plan: limpiarLinea(body.plan, MAX.plan),
      periodo: limpiarLinea(body.periodo, MAX.periodo),
      observaciones: limpiarTexto(body.observaciones, MAX.obs),
    },
  };
}

export function formatearCuit(c: string): string {
  return c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c;
}

export function asuntoAviso(nombre: string): string {
  return ("🔔 NUEVA SOLICITUD DE FACTURA — " + nombre).slice(0, 200);
}

// Texto del aviso al administrador. Todo lo que viene del usuario ya pasó por limpiarLinea /
// limpiarTexto; el destinatario NO sale de acá: lo fija el servidor.
export function textoAviso(s: Solicitud, cuenta: { id: unknown; nombre: string }): string {
  return "SOLICITUD DE FACTURA DE SUSCRIPCIÓN\n\n" +
    "Nombre / Razón Social: " + s.nombre + "\n" +
    "CUIT: " + formatearCuit(s.cuit) + "\n" +
    "Email de facturación: " + s.email + "\n" +
    "Domicilio comercial: " + s.domicilio + "\n" +
    "Condición IVA: " + s.condicion_iva + "\n" +
    "Plan contratado: " + s.plan + "\n" +
    "Período: " + s.periodo + "\n" +
    "Observaciones: " + (s.observaciones || "(ninguna)") + "\n\n" +
    "Cuenta que hizo la solicitud: " + limpiarLinea(cuenta.nombre, 120) + " (id " + String(cuenta.id).slice(0, 20) + ")";
}

// A dónde llega el aviso. Por defecto, el mismo buzón que usaba el envío anterior desde el
// navegador; se puede cambiar con el secreto opcional FACTURA_AVISO_DESTINO (por ejemplo a
// admin@medhistoriaclinicaonline.com, que se lee desde Panel Admin → Mensajes).
export const DESTINO_AVISO_DEFECTO = "medhistoriaclinicaonline@gmail.com";

export function destinoDesdeEntorno(valor: string | undefined | null): string {
  const v = (valor ?? "").trim();
  return EMAIL_RE.test(v) ? v : DESTINO_AVISO_DEFECTO;
}
