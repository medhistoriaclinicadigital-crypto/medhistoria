# Zoho Mail — inbox de soporte@/consultas@ en el Panel Admin

Guía para configurar o regenerar la integración con Zoho Mail que trae los mails
de `soporte@` y `consultas@medhistoriaclinicaonline.com` a la pestaña
"📧 Mensajes" del Panel Admin, sin loguearse en Zoho aparte.

## Los 6 secretos necesarios

consultas@ y soporte@ son **cuentas Zoho separadas** (misma organización,
pero cada una con su propia API Console vacía) — no comparten Self Client.
Cada casilla tiene su propio trío client_id/client_secret/refresh_token.

| Secreto | Qué es |
|---|---|
| `ZOHO_CLIENT_ID` | Self Client creado en la cuenta **consultas@**. |
| `ZOHO_CLIENT_SECRET` | Ídem. |
| `ZOHO_REFRESH_TOKEN` | Autorizado como **consultas@**. Ve solo esa casilla. |
| `ZOHO_CLIENT_ID_SOPORTE` | Self Client creado en la cuenta **soporte@**. |
| `ZOHO_CLIENT_SECRET_SOPORTE` | Ídem. |
| `ZOHO_REFRESH_TOKEN_SOPORTE` | Autorizado como **soporte@**. Ve solo esa casilla. |

**Gotcha importante:** un Refresh Token de Zoho Self Client solo ve la cuenta
con la que se autorizó — **no** ve todo el dominio aunque las casillas
compartan organización. Y como son cuentas Zoho separadas, tampoco comparten
Client ID/Secret: cada una necesita su propio Self Client creado desde cero,
logueado como esa casilla. (Se intentó antes un token único de organización
con el scope `ZohoMail.organization.accounts.READ` — dio `invalid_code` al
combinarlo con los otros scopes; posiblemente porque la cuenta admin@ no
tiene asignado el rol "Administrator" dentro de Zoho, a diferencia de
simplemente llamarse así. No se investigó más a fondo.)

## Cómo generar (o regenerar) un Refresh Token

Repetir esto **una vez por casilla** (logueado en Zoho como esa casilla
específica — soporte@ o consultas@, no como admin@):

1. Entrar a [Zoho API Console](https://api-console.zoho.com/) → si no hay
   ningún cliente creado todavía en esa cuenta, crear uno nuevo tipo
   "Self Client".
2. Pestaña **Client Secret** → confirmar Client ID y Client Secret (van en
   `ZOHO_CLIENT_ID`/`ZOHO_CLIENT_SECRET` para consultas@, o
   `ZOHO_CLIENT_ID_SOPORTE`/`ZOHO_CLIENT_SECRET_SOPORTE` para soporte@).
3. Pestaña **Generate Code** → en el campo de scope, pegar exactamente:
   ```
   ZohoMail.accounts.READ,ZohoMail.messages.READ
   ```
   (con coma, sin espacios — separado por comas es el formato que espera Zoho).
4. Generar el código (vence en minutos) y hacer el intercambio por un
   Refresh Token: POST a `https://accounts.zoho.com/oauth/v2/token` con
   `grant_type=authorization_code`, `client_id`, `client_secret` y `code`.
5. Guardar ese Refresh Token en Supabase como `ZOHO_REFRESH_TOKEN` (si es
   consultas@) o `ZOHO_REFRESH_TOKEN_SOPORTE` (si es soporte@).

## Cargar los secretos en Supabase

**Siempre uno por uno, directo en el Dashboard — nunca los 4 juntos en un
solo comando de CLI.** Un intento por terminal dejó Client ID y Client
Secret como string vacío sin ningún error visible (un carácter especial del
Client Secret rompió el parseo de la consola a mitad de comando).

- Staging: https://supabase.com/dashboard/project/zkppmeayukqxavknhsoe/settings/functions
- Producción: https://supabase.com/dashboard/project/rgwqiguojmwmkifrxfra/settings/functions

## Deploy de la función

```bash
supabase functions deploy zoho-mail-inbox --project-ref <ref-del-proyecto>
```

## accountId ya confirmados (no deberían cambiar)

- `consultas@medhistoriaclinicaonline.com` → `8164665000000008002`
- `soporte@medhistoriaclinicaonline.com` → `8141534000000008002`

(Están hardcodeados en `zoho-mail-inbox/index.ts` — si se agrega una casilla
nueva, hay que resolver su accountId contra `GET /api/accounts` con su propio
Refresh Token y agregarlo al array `CASILLAS` del código.)

## Tabla de caché

`public.zoho_mail_cache` (`casilla` PK, `mensajes` jsonb, `actualizado_en`) —
sin ningún grant a `anon`/`authenticated`, mismo criterio que
`consentimientos_legales`. TTL de 3 minutos en el código de la función, para
no acercarse al límite de Zoho (30 llamadas/min en el plan gratis). Si se
crea el proyecto de producción desde cero, hay que crear esta tabla ahí
también (ver el SQL usado en staging en el historial de la conversación, o
simplemente recrearla con la misma estructura).
