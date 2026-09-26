-- Cierra el borrado de pacientes por API: ningún médico (anon/authenticated) puede borrar filas de `pacientes`.
-- Motivo: el trigger del límite de la Prueba Gratuita (35) cuenta las filas que EXISTEN; con la política de borrado
-- un médico podía liberar cupo con una llamada directa a la API (sb.from('pacientes').delete()). Además, las historias
-- clínicas no deberían poder borrarse desde el cliente. El borrado queda solo manual, por SQL Editor (rol postgres) o
-- por una Edge Function con service_role — ninguno de los dos se ve afectado.
-- No cambia lo que hace la app: no hay ningún delete sobre `pacientes` en index.html (el botón "Borrar" solo tocaba el navegador).
--
-- MARCHA ATRÁS (deja todo como estaba) — ⚠️ SOLO SI HACE FALTA, NO CORRER EN CONDICIONES NORMALES:
--   grant delete on public.pacientes to anon, authenticated;
--   create policy medicos_borran_sus_pacientes on public.pacientes for delete to public
--     using (medico_id in (select usuarios.id from usuarios where usuarios.auth_id = auth.uid()));

drop policy if exists medicos_borran_sus_pacientes on public.pacientes;
revoke delete on public.pacientes from anon, authenticated, public;
