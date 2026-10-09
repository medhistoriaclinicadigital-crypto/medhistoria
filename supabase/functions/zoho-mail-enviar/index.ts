// ─────────────────────────────────────────────────────────────────────────────
// zoho-mail-enviar — responder mails desde Panel Admin → Mensajes.
//
// Responde desde UNA de las tres casillas (admin@, consultas@, soporte@), cada
// una con sus propios secretos de Zoho. Si una casilla falla, las otras no se
// enteran: cada llamada usa solo los secretos de la casilla pedida.
//
// Seguridad (todo del lado del servidor, nada se confía al navegador):
//  1. Sesión válida + 2FA (AAL2) + rol admin — igual de estricto que zoho-mail-inbox.
//  2. El remitente lo define esta función según la casilla; el cliente no lo manda.
//  3. El destinatario tiene que ser quien escribió el mail al que se responde:
//     se comprueba contra la lista cacheada de esa casilla (zoho_mail_cache).
//  4. Límite de envíos por hora y POR CASILLA (secreto opcional ZOHO_ENVIOS_POR_HORA,
//     por defecto 10).
//  5. Cada envío queda registrado en public.zoho_mail_envios (casilla, quién,
//     destinatario, asunto, resultado) — sin cuerpo del mensaje ni secretos. El
//     registro se escribe ANTES de enviar: si no se puede registrar, no se envía.
//  6. Texto plano (sin HTML), con largos máximos y asunto sin saltos de línea.
//
// Secretos por casilla (ya cargados para la lectura, pero el refresh token tiene
// que haberse generado con ZohoMail.messages.CREATE además de accounts.READ y
// messages.READ): ver _DEPLOY-zoho.md.
//
// Deploy:   supabase functions deploy zoho-mail-enviar --project-ref <ref>
// SQL:      supabase/sql/zoho-enviar/01_zoho_mail_envios.sql (antes del primer envío)
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  limiteDesdeEntorno,
  remitenteDeMensaje,
  superaLimite,
  validarEntrada,
} from "./validar.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CASILLAS = {
  consultas: {
    email: "consultas@medhistoriaclinicaonline.com",
    clientIdVar: "ZOHO_CLIENT_ID",
    clientSecretVar: "ZOHO_CLIENT_SECRET",
    refreshTokenVar: "ZOHO_REFRESH_TOKEN",
    accountId: "8164665000000008002",
  },
  soporte: {
    email: "soporte@medhistoriaclinicaonline.com",
    clientIdVar: "ZOHO_CLIENT_ID_SOPORTE",
    clientSecretVar: "ZOHO_CLIENT_SECRET_SOPORTE",
    refreshTokenVar: "ZOHO_REFRESH_TOKEN_SOPORTE",
    accountId: "8141534000000008002",
  },
  admin: {
    email: "admin@medhistoriaclinicaonline.com",
    clientIdVar: "ZOHO_CLIENT_ID_ADMIN",
    clientSecretVar: "ZOHO_CLIENT_SECRET_ADMIN",
    refreshTokenVar: "ZOHO_REFRESH_TOKEN_ADMIN",
    accountId: "7453360000000008002",
  },
} as const;
type NombreCasilla = keyof typeof CASILLAS;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Rechazos "de negocio" (límite, validación, destinatario): HTTP 200 con ok:false
// y un mensaje claro para mostrar en pantalla. Los de sesión/permisos usan 401/403.
function rechazo(error: string) {
  return json({ ok: false, error });
}

function aalDelToken(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded.aal ?? null;
  } catch {
    return null;
  }
}

// Largo y primeros 8 caracteres del SHA-256 de un valor: sirven para diagnosticar
// qué secreto está viendo la función sin exponer el valor (no se puede revertir).
async function huellaCorta(v: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  const hex = [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `largo ${v.length}, huella ${hex.slice(0, 8)}`;
}

async function obtenerAccessToken(c: (typeof CASILLAS)[NombreCasilla]): Promise<string> {
  const refreshToken = (Deno.env.get(c.refreshTokenVar) ?? "").trim();
  const clientId = (Deno.env.get(c.clientIdVar) ?? "").trim();
  const clientSecret = (Deno.env.get(c.clientSecretVar) ?? "").trim();
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Zoho OAuth falló (HTTP ${res.status}): ` + JSON.stringify(data).slice(0, 200) +
        ` [${c.clientIdVar}: ${await huellaCorta(clientId)}; ${c.clientSecretVar}: ${await huellaCorta(clientSecret)}; ` +
        `${c.refreshTokenVar}: ${await huellaCorta(refreshToken)}]`,
    );
  }
  return data.access_token;
}

async function enviarPorZoho(
  c: (typeof CASILLAS)[NombreCasilla],
  destinatario: string,
  asunto: string,
  texto: string,
): Promise<string | null> {
  const accessToken = await obtenerAccessToken(c);
  const res = await fetch(`https://mail.zoho.com/api/accounts/${c.accountId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": "Zoho-oauthtoken " + accessToken,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      fromAddress: c.email, // fijo: lo define el servidor según la casilla
      toAddress: destinatario,
      subject: asunto,
      content: texto,
      mailFormat: "plaintext",
      askReceipt: "no",
    }),
  });
  const body = await res.json().catch(() => ({}));
  const codigo = body?.status?.code;
  if (!res.ok || (codigo !== undefined && codigo !== 200)) {
    throw new Error("Zoho no aceptó el envío: " + JSON.stringify(body).slice(0, 250));
  }
  const id = body?.data?.messageId;
  return id ? String(id) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

  try {
    // 1. Sesión + 2FA + rol admin, verificado acá (no en el navegador).
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: uErr } = await supabase.auth.getUser();
    if (uErr || !user) return json({ error: "No autenticado." }, 401);

    if (aalDelToken(token) !== "aal2") {
      return json({ error: "Requiere verificación en dos pasos (AAL2)." }, 403);
    }

    const { data: perfil } = await supabase
      .from("usuarios").select("rol").eq("auth_id", user.id).maybeSingle();
    if (!perfil || perfil.rol !== "admin") {
      return json({ error: "Solo un administrador puede acceder a esto." }, 403);
    }

    // 2. Validar lo que mandó el navegador.
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const v = validarEntrada(body, Object.keys(CASILLAS));
    if (!v.ok) return rechazo(v.error);
    const { casilla, messageId, destinatario, asunto, texto } = v.datos;
    const cfg = CASILLAS[casilla as NombreCasilla];

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 3. El destinatario debe ser quien escribió ese mail (según la lista cacheada
    //    de la casilla, que escribe esta misma familia de funciones).
    const { data: cache } = await admin
      .from("zoho_mail_cache").select("mensajes").eq("casilla", casilla).maybeSingle();
    const remitente = remitenteDeMensaje(cache?.mensajes, messageId);
    if (!remitente) {
      return rechazo("No encontré ese mensaje en la lista de " + cfg.email +
        ". Tocá «Actualizar» en Mensajes y probá de nuevo.");
    }
    if (remitente !== destinatario) {
      return rechazo("Solo se puede responder a quien escribió el mail original.");
    }

    // 4. Límite por hora, por casilla (cuenta los envíos pendientes, ok y con error).
    const limite = limiteDesdeEntorno(Deno.env.get("ZOHO_ENVIOS_POR_HORA"));
    const desde = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: cErr } = await admin
      .from("zoho_mail_envios").select("id", { count: "exact", head: true })
      .eq("casilla", casilla).gte("creado_en", desde);
    if (cErr) {
      console.error("zoho-mail-enviar: no se pudo contar los envíos:", cErr.message);
      return rechazo("No se pudo verificar el límite de envíos. No se envió nada.");
    }
    if (superaLimite(count ?? 0, limite)) {
      return rechazo(`Llegaste al límite de ${limite} envíos por hora desde ${cfg.email}. Probá más tarde.`);
    }

    // 5. Registrar ANTES de enviar: si no se puede registrar, no se envía.
    const { data: fila, error: iErr } = await admin.from("zoho_mail_envios").insert({
      casilla,
      admin_auth_id: user.id,
      destinatario,
      asunto,
      message_id_origen: messageId,
      estado: "pendiente",
    }).select("id").single();
    if (iErr || !fila) {
      console.error("zoho-mail-enviar: no se pudo registrar el envío:", iErr?.message);
      return rechazo("No se pudo registrar el envío. No se envió nada.");
    }

    // 6. Enviar con los secretos de ESTA casilla.
    try {
      const idEnviado = await enviarPorZoho(cfg, destinatario, asunto, texto);
      await admin.from("zoho_mail_envios").update({ estado: "ok", detalle: idEnviado }).eq("id", fila.id);
      return json({ ok: true, casilla, destinatario });
    } catch (e) {
      const detalle = String(e).slice(0, 600);
      await admin.from("zoho_mail_envios").update({ estado: "error", detalle }).eq("id", fila.id);
      console.error("zoho-mail-enviar: falló el envío desde", casilla, detalle);
      return rechazo("Zoho no pudo enviar el mail desde " + cfg.email +
        ". Revisá que el refresh token de esa casilla tenga el permiso de enviar. Detalle técnico (sin secretos): " + detalle);
    }
  } catch (e) {
    console.error("zoho-mail-enviar: error inesperado:", String(e));
    return json({ error: "Error inesperado." }, 500);
  }
});
