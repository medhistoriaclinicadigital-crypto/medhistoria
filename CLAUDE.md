# CLAUDE.md — MedHistoriaClinicaOnline

Instrucciones de proyecto para trabajar acá de forma segura y eficiente. Esto complementa (no reemplaza) la memoria de sesiones anteriores.

## 1. Qué es el proyecto

PWA de historia clínica digital para médicos (recetas, agenda, facturación, centros médicos). Todo el frontend vive en un único archivo, **`index.html`** (~15.600 líneas) — sin build, sin framework, sin bundler. Vanilla JS + Supabase (auth/DB) + jsPDF + JsBarcode + EmailJS, todo cargado por CDN directo en el `<head>`.

No hay `package.json` ni test suite automatizado. "Probar" un cambio significa verificarlo a mano en el navegador (ver sección 3), no correr un comando de tests.

Archivo grande: para ubicar código, usar Grep por nombre de función/variable en vez de leer el archivo entero de punta a punta.

## 2. Los dos entornos — la regla más importante del proyecto

- **`staging`** → Supabase staging, proyecto `zkppmeayukqxavknhsoe` — SQL Editor: https://supabase.com/dashboard/project/zkppmeayukqxavknhsoe/sql/new
- **`main`** → Supabase producción, proyecto `rgwqiguojmwmkifrxfra` — servido en https://medhistoriaclinicadigital-crypto.github.io/medhistoria/ — SQL Editor: https://supabase.com/dashboard/project/rgwqiguojmwmkifrxfra/sql/new

El único diff esperado entre las dos ramas es el bloque `SUPABASE_URL`/`SUPABASE_KEY` (cerca de la línea 670, con un comentario que dice a qué proyecto apunta). Antes de tocar lógica, confirmar en qué rama se está parado (`git branch`) y leer ese comentario para saber a qué proyecto real apunta ese checkout.

Flujo de cambios: la lógica arranca siempre en `staging`, se prueba ahí, y recién después se promueve a `main` con un **cherry-pick del commit puntual** (no merge de la rama entera, para no arrastrar el bloque de Supabase de staging a producción).

**Receta de promoción a producción:**
1. `git checkout main`
2. `git cherry-pick <hash del commit en staging>`
3. `git push origin main`
4. `git checkout staging` — no terminar nunca parado en `main`.
5. Confirmar que GitHub Pages ya sirve el cambio (ej. `curl` a la URL de producción buscando algo del cambio nuevo) antes de avisar que ya está listo — el deploy no es instantáneo.

Los scripts `.sql` de las migraciones no viven en este repo — están en una carpeta local separada, hermana a este repositorio (su nombre menciona "staging" pero ahí van los scripts para los dos entornos, no solo staging).

## 3. Cómo probar en local

Netlify de staging puede estar caído/pausado por créditos — no asumir que ya volvió sin confirmarlo con la usuaria. Alternativa: levantar `serve.ps1` (servidor estático nativo de PowerShell, sin dependencias) — ya está configurado en `.claude/launch.json` como `medhistoria-local`, puerto 8080.

**Gotcha de recarga:** para forzar una recarga genuina (no una restauración desde bfcache, que da falsos positivos/negativos) no alcanza con `navigate` a la misma URL ni `location.reload()` — hay que navegar a otra URL del mismo origen primero (ej. `/manifest.json`) y volver a `/index.html`.

**Para probar un PDF sin pasar por toda la UI:** inyectar `usuarioActual` + un objeto de datos de prueba por consola (`javascript_tool`), llamar directo a la función generadora (ej. `_generarPDFRecetaReNaPDiS`), convertir el resultado a base64 (`doc.output('datauristring')`), mandarlo por `POST /save` (endpoint que ofrece `serve.ps1`, guarda `scratch_output.pdf` en la raíz), leerlo con la herramienta Read (muestra texto y la imagen de la página), y borrar el archivo al terminar.

No commitear `scratch_output.pdf` ni otros archivos de prueba generados durante el testing — borrarlos apenas se terminan de revisar.

## 4. Seguridad en Supabase — errores ya cometidos, no repetir

- Supabase le da permisos a `anon`/`authenticated` **automáticamente** en cada tabla/función nueva, de forma directa (no vía `PUBLIC`). Un `REVOKE ... FROM PUBLIC` **no alcanza** para sacar ese acceso — hay que revocar explícito de los tres: `REVOKE ... FROM anon, authenticated, PUBLIC;`.
- Nunca asumir que un `.sql` local o un esquema recordado de una sesión anterior refleja la base real — confirmar en vivo (`information_schema.columns`, `information_schema.column_privileges`, `pg_proc`) antes de escribir SQL nuevo.
- Un error `42883 function does not exist` al aplicar un fix de permisos puede significar que la función nunca se aplicó en ese entorno — no asumir que es solo un error de URL/proyecto equivocado.
- Toda función `SECURITY DEFINER` pensada para que la llame solo el propio backend/cron (nunca un cliente directo) necesita `REVOKE EXECUTE ... FROM anon, authenticated, PUBLIC;` explícito.
- Después de correr SQL y que diga "Success", **confirmar explícitamente con la usuaria la URL exacta** donde lo corrió antes de dar el cambio por aplicado — no confiar ciegamente en el mensaje.
- **Nunca ejecutar `DELETE`, `DROP`, `TRUNCATE` o `UPDATE` sin `WHERE` en la base de producción sin pedir confirmación explícita de la usuaria antes de correrlo** — hay datos reales de pacientes de por medio.

## 5. Cómo pedirle SQL a la usuaria

Siempre con el **link directo y clicable** a la pestaña correcta (ver sección 2) **en el mismo mensaje** que el código SQL — nunca en un mensaje aparte, nunca asumiendo que ya sabe cuál pestaña usar. Esto es una instrucción a seguir siempre, no algo para reconfirmar cada vez.

## 6. Datos sensibles / IA

Es una app de historia clínica real, con datos de pacientes. Tiene funciones de IA (consulta clínica, chat asistente, dictado por voz) que mandan el texto ingresado a un servicio de terceros — por política propia de la app, el profesional no debe ingresar ahí nombre, apellido, DNI, domicilio u otro dato identificatorio del paciente. Si se toca esa parte del código, preservar esa regla.

Las claves embebidas en el HTML (Supabase *publishable key*, EmailJS *public key*) son públicas por diseño, pensadas para vivir en el cliente — no son un hallazgo de seguridad por sí solas. La protección real de los datos es Row Level Security (RLS) del lado de Supabase.

## 7. Pendientes conocidos — no resolver sin avisar primero

- **EmailJS:** posible envío de mail a destinatario arbitrario sin login, vía la función de "Solicitar Factura". Depende de que la usuaria revise una restricción de dominio en su panel de EmailJS — todavía no lo hizo.
- **Clave de API de IA en `localStorage`:** cada médico guarda su propia clave ahí. Pausado hasta que la usuaria contrate ese servicio.
- **Firma Digital Remota (PFDR):** integración investigada (documentación oficial de Argentina) pero no implementada. Falta trámite oficial + dominio propio + endpoint de callback. No arrancar a programar esto sin confirmar que esos pasos previos ya se hicieron.

## 8. Cómo prefiere trabajar la usuaria

- Respuestas cortas y directas.
- Probar los cambios de verdad (navegador/PDF real) antes de decir "ya está" — la revisión de código sola no alcanza; ya pasó que algo parecía aplicado y nunca había llegado a producción.
- Cuando algo queda listo para que ella lo vea, pasarle el link de producción directo.
- Ante un bug esquivo (varios intentos fallidos), mejor pedir evidencia real (logs con timestamps, grabación de pantalla, capturas de Network) antes de seguir asumiendo la causa — funcionó mejor que rondas sucesivas de "arreglo y probamos".
