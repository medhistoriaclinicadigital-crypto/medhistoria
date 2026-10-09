// ─────────────────────────────────────────────────────────────────────────────
// Validaciones puras de zoho-mail-enviar (sin red, sin Deno): se pueden probar
// con Node (ver scratchpad/zoho-enviar-test.mjs).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_ASUNTO = 200;
export const MAX_TEXTO = 10000;
export const LIMITE_POR_HORA_DEFECTO = 10;

const EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i;
const MESSAGE_ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;

// Saca la dirección de un texto tipo "Nombre <a@b.com>" o "a@b.com".
export function extraerEmail(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

export interface Entrada {
  casilla: string;
  messageId: string;
  destinatario: string;
  asunto: string;
  texto: string;
}

export type Resultado<T> = { ok: true; datos: T } | { ok: false; error: string };

export function validarEntrada(
  body: Record<string, unknown>,
  casillasValidas: readonly string[],
): Resultado<Entrada> {
  const casilla = typeof body.casilla === "string" ? body.casilla : "";
  if (!casillasValidas.includes(casilla)) return { ok: false, error: "Casilla inválida." };

  const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
  if (!MESSAGE_ID_RE.test(messageId)) return { ok: false, error: "Mensaje inválido." };

  const destinatario = extraerEmail(body.destinatario);
  if (!destinatario) return { ok: false, error: "Destinatario inválido." };

  // Sin saltos de línea en el asunto: evita inyectar encabezados de mail.
  const asunto = (typeof body.asunto === "string" ? body.asunto : "")
    .replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  if (!asunto) return { ok: false, error: "Falta el asunto." };
  if (asunto.length > MAX_ASUNTO) {
    return { ok: false, error: `El asunto supera los ${MAX_ASUNTO} caracteres.` };
  }

  const texto = (typeof body.texto === "string" ? body.texto : "").replace(/\r\n/g, "\n").trim();
  if (!texto) return { ok: false, error: "Falta el texto de la respuesta." };
  if (texto.length > MAX_TEXTO) {
    return { ok: false, error: `El texto supera los ${MAX_TEXTO} caracteres.` };
  }

  return { ok: true, datos: { casilla, messageId, destinatario, asunto, texto } };
}

// Busca el mensaje en la lista cacheada de la casilla (dato del servidor, no del
// navegador) y devuelve la dirección de quien lo escribió.
export function remitenteDeMensaje(mensajes: unknown, messageId: string): string | null {
  if (!Array.isArray(mensajes)) return null;
  for (const m of mensajes) {
    if (m && typeof m === "object" && String((m as Record<string, unknown>).messageId) === messageId) {
      return extraerEmail((m as Record<string, unknown>).fromAddress);
    }
  }
  return null;
}

export function superaLimite(cantidadUltimaHora: number, limite: number): boolean {
  return cantidadUltimaHora >= limite;
}

export function limiteDesdeEntorno(valor: string | undefined | null): number {
  const n = Number.parseInt((valor ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 && n <= 200 ? n : LIMITE_POR_HORA_DEFECTO;
}
