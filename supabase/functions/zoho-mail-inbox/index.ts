// ─────────────────────────────────────────────────────────────────────────────
// Edge Function: zoho-mail-inbox
// Trae los mails de las casillas soporte@/consultas@/admin@ (Zoho Mail) para mostrarlos
// en la pestaña "📧 Mensajes" del Panel Admin, sin que el admin tenga que
// loguearse en Zoho aparte.
//
// Solo admin autenticado con 2FA (AAL2) puede llamarla — se verifica acá,
// server-side, no solo escondido en la interfaz.
//
// Cada casilla tiene su propio Refresh Token (un token de Zoho solo ve la
// cuenta con la que se autorizó, no todo el dominio) — ver accountId fijos
// abajo, ya confirmados contra la API.
//
// Caché en la tabla zoho_mail_cache (service role, sin acceso de clientes):
// evita pegarle a Zoho en cada apertura del panel — límite real del plan
// gratis: 30 llamadas/min. TTL acá: 3 minutos.
//
// consultas@, soporte@ y admin@ son cuentas Zoho separadas (misma organización, pero
// cada una con su propio Self Client en la API Console) — por eso cada una
// tiene su propio trío client_id/client_secret/refresh_token, no comparten
// credenciales de OAuth.
//
// Deploy:   supabase functions deploy zoho-mail-inbox
// Secretos: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN (consultas@),
//           ZOHO_CLIENT_ID_SOPORTE, ZOHO_CLIENT_SECRET_SOPORTE,
//           ZOHO_REFRESH_TOKEN_SOPORTE (soporte@) — ya cargados, no viven acá.
//           ZOHO_CLIENT_ID_ADMIN, ZOHO_CLIENT_SECRET_ADMIN, ZOHO_REFRESH_TOKEN_ADMIN (admin@) —
//           ya cargados en staging y producción (ver _DEPLOY-zoho.md).
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CACHE_TTL_MS = 3 * 60 * 1000;

const CASILLAS = [
  {
    casilla: "consultas",
    clientIdVar: "ZOHO_CLIENT_ID",
    clientSecretVar: "ZOHO_CLIENT_SECRET",
    refreshTokenVar: "ZOHO_REFRESH_TOKEN",
    accountId: "8164665000000008002",
  },
  {
    casilla: "soporte",
    clientIdVar: "ZOHO_CLIENT_ID_SOPORTE",
    clientSecretVar: "ZOHO_CLIENT_SECRET_SOPORTE",
    refreshTokenVar: "ZOHO_REFRESH_TOKEN_SOPORTE",
    accountId: "8141534000000008002",
  },
  {
    casilla: "admin",
    clientIdVar: "ZOHO_CLIENT_ID_ADMIN",
    clientSecretVar: "ZOHO_CLIENT_SECRET_ADMIN",
    refreshTokenVar: "ZOHO_REFRESH_TOKEN_ADMIN",
    accountId: "7453360000000008002",
  },
] as const;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// El JWT de Supabase trae el nivel de autenticación (aal) como claim propio —
// lo leemos directo del token en vez de pedirle a Supabase que lo resuelva,
// para no depender de una sesión de cliente completa acá adentro.
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

async function obtenerAccessToken(
  clientIdVar: string,
  clientSecretVar: string,
  refreshTokenVar: string,
): Promise<string> {
  const refreshToken = (Deno.env.get(refreshTokenVar) ?? "").trim();
  const clientId = (Deno.env.get(clientIdVar) ?? "").trim();
  const clientSecret = (Deno.env.get(clientSecretVar) ?? "").trim();
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
    // El error incluye el código HTTP y la huella de lo que la función leyó (sin exponer
    // valores): ayudó a descartar secretos mal cargados. Un solo intento por llamada.
    throw new Error(
      `Zoho OAuth falló (HTTP ${res.status}): ` + JSON.stringify(data) +
        ` [${clientIdVar}: ${await huellaCorta(clientId)}; ${clientSecretVar}: ${await huellaCorta(clientSecret)}; ` +
        `${refreshTokenVar}: ${await huellaCorta(refreshToken)}]`,
    );
  }
  return data.access_token;
}

// deno-lint-ignore no-explicit-any
function mapearMensaje(m: any, casilla: string) {
  return {
    casilla,
    messageId: m.messageId,
    sender: m.sender || m.fromAddress,
    fromAddress: m.fromAddress,
    subject: m.subject || "(sin asunto)",
    summary: m.summary || "",
    receivedTime: Number(m.receivedTime || m.sentDateInGMT || 0),
    // Hace falta para pedir el contenido completo al responder (ver accion "contenido").
    folderId: m.folderId ? String(m.folderId) : "",
  };
}

// Pasa el HTML de un mail a texto plano corto, para citarlo en una respuesta.
function htmlATexto(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function traerContenido(
  clientIdVar: string,
  clientSecretVar: string,
  refreshTokenVar: string,
  accountId: string,
  folderId: string,
  messageId: string,
): Promise<string> {
  const accessToken = await obtenerAccessToken(clientIdVar, clientSecretVar, refreshTokenVar);
  const url = `https://mail.zoho.com/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`;
  const res = await fetch(url, { headers: { "Authorization": "Zoho-oauthtoken " + accessToken } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Zoho /content falló: " + JSON.stringify(body).slice(0, 200));
  return htmlATexto(String(body?.data?.content ?? "")).slice(0, 4000);
}

async function traerMensajes(
  clientIdVar: string,
  clientSecretVar: string,
  refreshTokenVar: string,
  accountId: string,
  casilla: string,
) {
  const accessToken = await obtenerAccessToken(clientIdVar, clientSecretVar, refreshTokenVar);
  const url = `https://mail.zoho.com/api/accounts/${accountId}/messages/view` +
    `?limit=25&sortBy=date&sortorder=false`;
  const res = await fetch(url, {
    headers: { "Authorization": "Zoho-oauthtoken " + accessToken },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Zoho /messages/view falló: " + JSON.stringify(body));
  const data = (body.data ?? []) as unknown[];
  // deno-lint-ignore no-explicit-any
  return data.map((m) => mapearMensaje(m as any, casilla));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // 1. Verificar admin real + 2FA (AAL2) — igual de estricto que Consentimientos.
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

    // 2. Traer mensajes de cada casilla, con caché (service role — bypassea RLS,
    //    es la única forma de leer/escribir esta tabla).
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const forzarActualizacion = body.forzar === true;

    // Acción "contenido": texto completo de UN mail (para citarlo al responder).
    // Misma verificación de admin + AAL2 de arriba; solo lectura.
    if (body.accion === "contenido") {
      const cfg = CASILLAS.find((c) => c.casilla === body.casilla);
      const messageId = String(body.messageId ?? "");
      const folderId = String(body.folderId ?? "");
      const idOk = /^[A-Za-z0-9_\-]{1,64}$/;
      if (!cfg || !idOk.test(messageId) || !idOk.test(folderId)) {
        return json({ ok: false, error: "Datos inválidos." });
      }
      try {
        const contenido = await traerContenido(
          cfg.clientIdVar, cfg.clientSecretVar, cfg.refreshTokenVar, cfg.accountId, folderId, messageId,
        );
        return json({ ok: true, contenido });
      } catch (e) {
        return json({ ok: false, error: String(e).slice(0, 200) });
      }
    }

    const resultados = await Promise.all(CASILLAS.map(async ({ casilla, clientIdVar, clientSecretVar, refreshTokenVar, accountId }) => {
      try {
        if (!forzarActualizacion) {
          const { data: cache } = await admin
            .from("zoho_mail_cache").select("mensajes, actualizado_en")
            .eq("casilla", casilla).maybeSingle();
          if (cache && Date.now() - new Date(cache.actualizado_en).getTime() < CACHE_TTL_MS) {
            return { casilla, mensajes: cache.mensajes, deCache: true, actualizado_en: cache.actualizado_en };
          }
        }
        const mensajes = await traerMensajes(clientIdVar, clientSecretVar, refreshTokenVar, accountId, casilla);
        await admin.from("zoho_mail_cache").upsert({
          casilla, mensajes, actualizado_en: new Date().toISOString(),
        });
        return { casilla, mensajes, deCache: false, actualizado_en: new Date().toISOString() };
      } catch (e) {
        // Si Zoho falla, devolver lo último cacheado (si hay) en vez de nada.
        const { data: cache } = await admin
          .from("zoho_mail_cache").select("mensajes, actualizado_en")
          .eq("casilla", casilla).maybeSingle();
        return {
          casilla, error: String(e),
          mensajes: cache?.mensajes ?? [], deCache: true, actualizado_en: cache?.actualizado_en ?? null,
        };
      }
    }));

    return json({ ok: true, resultados });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
