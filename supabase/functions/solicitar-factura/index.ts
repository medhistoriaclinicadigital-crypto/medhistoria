// ─────────────────────────────────────────────────────────────────────────────
// solicitar-factura — "Solicitar Factura de Suscripción" (Facturación → Suscripción).
//
// Reemplaza el envío que hacía el NAVEGADOR con EmailJS (credenciales públicas dentro
// del HTML: cualquiera podía usarlas para mandar mails a cualquier destinatario con
// cualquier texto). Ahora el envío se hace acá, en el servidor:
//  1. Hace falta una sesión válida (médico logueado): sin sesión, no hay nada.
//  2. El DESTINATARIO lo fija el servidor (nunca viene del navegador): el buzón del
//     administrador. El remitente es admin@ (cuenta de Zoho ya conectada).
//  3. El texto del aviso se arma acá con los datos del formulario ya limpiados
//     (largos máximos, sin saltos de línea falsos, CUIT de 11 dígitos, email válido).
//  4. Tope de solicitudes PENDIENTES por médico (5): una cuenta no puede inundar de
//     avisos al administrador.
//  5. La solicitud también queda guardada en public.solicitudes_factura (con el id del
//     médico tomado de la sesión, no del navegador), igual que antes.
//
// Orden: primero se manda el aviso; si falla, no se guarda nada y el médico puede
// reintentar sin duplicar. Si el aviso salió y el guardado falla, se avisa igual
// (el mail es lo que mira el administrador) y el error queda en el log.
//
// Secretos que usa (ya existen): los de la casilla admin@ de Zoho (ZOHO_*_ADMIN; el
// refresh token necesita el permiso ZohoMail.messages.CREATE, como zoho-mail-enviar).
// Secreto opcional: FACTURA_AVISO_DESTINO (por defecto, el buzón de siempre).
//
// Deploy:   supabase functions deploy solicitar-factura --project-ref <ref>
//           (verify_jwt activo: sin sesión ni siquiera entra)
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  asuntoAviso,
  destinoDesdeEntorno,
  MAX_PENDIENTES_POR_MEDICO,
  textoAviso,
  validarSolicitud,
} from "./validar.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Casilla desde la que sale el aviso (la misma configuración que zoho-mail-enviar).
const ADMIN = {
  email: "admin@medhistoriaclinicaonline.com",
  clientIdVar: "ZOHO_CLIENT_ID_ADMIN",
  clientSecretVar: "ZOHO_CLIENT_SECRET_ADMIN",
  refreshTokenVar: "ZOHO_REFRESH_TOKEN_ADMIN",
  accountId: "7453360000000008002",
} as const;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Rechazos "de negocio": HTTP 200 con ok:false y un mensaje para mostrar en pantalla.
function rechazo(error: string) {
  return json({ ok: false, error });
}

async function huellaCorta(v: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  const hex = [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `largo ${v.length}, huella ${hex.slice(0, 8)}`;
}

async function obtenerAccessToken(): Promise<string> {
  const refreshToken = (Deno.env.get(ADMIN.refreshTokenVar) ?? "").trim();
  const clientId = (Deno.env.get(ADMIN.clientIdVar) ?? "").trim();
  const clientSecret = (Deno.env.get(ADMIN.clientSecretVar) ?? "").trim();
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
        ` [${ADMIN.clientIdVar}: ${await huellaCorta(clientId)}; ${ADMIN.clientSecretVar}: ${await huellaCorta(clientSecret)}; ` +
        `${ADMIN.refreshTokenVar}: ${await huellaCorta(refreshToken)}]`,
    );
  }
  return data.access_token;
}

async function enviarAviso(destinatario: string, asunto: string, texto: string): Promise<void> {
  const accessToken = await obtenerAccessToken();
  const res = await fetch(`https://mail.zoho.com/api/accounts/${ADMIN.accountId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": "Zoho-oauthtoken " + accessToken,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      fromAddress: ADMIN.email, // fijo
      toAddress: destinatario, // fijo (lo decide el servidor)
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
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);

  try {
    // 1. Sesión válida (médico logueado), verificada acá.
    const authHeader = req.headers.get("Authorization") || "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: uErr } = await supabase.auth.getUser();
    if (uErr || !user) return json({ error: "No autenticado." }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // El médico se identifica por la sesión, nunca por lo que mande el navegador.
    const { data: medico } = await admin
      .from("usuarios").select("id, nombre").eq("auth_id", user.id).maybeSingle();
    if (!medico) return json({ error: "No se encontró tu cuenta." }, 403);

    // 2. Validar y limpiar lo que mandó el formulario.
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const v = validarSolicitud(body);
    if (!v.ok) return rechazo(v.error);
    const s = v.datos;

    // 3. Tope de solicitudes pendientes por médico.
    const { count, error: cErr } = await admin
      .from("solicitudes_factura").select("id", { count: "exact", head: true })
      .eq("medico_id", medico.id).eq("estado", "pendiente");
    if (cErr) {
      console.error("solicitar-factura: no se pudo contar las pendientes:", cErr.message);
      return rechazo("No se pudo verificar tus solicitudes anteriores. No se envió nada.");
    }
    if ((count ?? 0) >= MAX_PENDIENTES_POR_MEDICO) {
      return rechazo("Ya tenés varias solicitudes de factura pendientes. Esperá a que las procesemos o escribinos a consultas@medhistoriaclinicaonline.com.");
    }

    // 4. Primero el aviso al administrador (destinatario fijado por el servidor).
    const destino = destinoDesdeEntorno(Deno.env.get("FACTURA_AVISO_DESTINO"));
    try {
      await enviarAviso(destino, asuntoAviso(s.nombre), textoAviso(s, medico));
    } catch (e) {
      console.error("solicitar-factura: falló el aviso:", String(e).slice(0, 600));
      return rechazo("No pudimos enviar la solicitud en este momento. Probá de nuevo en unos minutos o escribinos a consultas@medhistoriaclinicaonline.com.");
    }

    // 5. Guardar la solicitud (mismas columnas que antes; medico_id sale de la sesión).
    const { error: iErr } = await admin.from("solicitudes_factura").insert({
      medico_id: medico.id,
      nombre: s.nombre,
      cuit: s.cuit,
      email: s.email,
      condicion_iva: s.condicion_iva,
      plan: s.plan,
      periodo: s.periodo,
      observaciones: s.observaciones,
      domicilio: s.domicilio,
      estado: "pendiente",
    });
    if (iErr) console.error("solicitar-factura: el aviso salió pero no se pudo guardar:", iErr.message);

    return json({ ok: true });
  } catch (e) {
    console.error("solicitar-factura: error inesperado:", String(e).slice(0, 300));
    return json({ error: "Error inesperado." }, 500);
  }
});
