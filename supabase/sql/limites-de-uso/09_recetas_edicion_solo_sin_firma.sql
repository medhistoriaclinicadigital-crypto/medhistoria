-- Recetas: un médico solo puede EDITAR (por la app o por la API) una receta PROPIA que todavía NO está firmada.
-- Motivo: que la fila de `recetas` coincida siempre con lo que dice el documento firmado. Hasta ahora la política de
-- edición solo pedía que la receta fuera del médico, así que se podían cambiar por API los datos de una receta ya firmada
-- (el PDF firmado no cambia, pero la fila sí). La app no modifica nunca una receta después de crearla (solo hace insert y
-- delete de recetas sin firmar), y la Edge Function firma-receta solo lee la receta y escribe en firmas_recetas (service_role).
--
-- Criterio de "firmada": la función public.receta_firmada(id) (SQL 08): existe una fila en firmas_recetas con ese id_receta.
-- El UPDATE manual desde el SQL Editor (rol postgres) o con service_role no se ve afectado.
-- Sin cláusula WITH CHECK explícita se aplica la misma condición a la fila nueva (id no cambia, así que sigue sin firma).
--
-- MARCHA ATRÁS (deja todo como estaba) — ⚠️ SOLO SI HACE FALTA, NO CORRER EN CONDICIONES NORMALES:
--   drop policy if exists medicos_editan_sus_recetas_sin_firma on public.recetas;
--   create policy medicos_editan_sus_recetas on public.recetas for update to public
--     using (medico_id in (select usuarios.id from usuarios where usuarios.auth_id = auth.uid()));

drop policy if exists medicos_editan_sus_recetas on public.recetas;
create policy medicos_editan_sus_recetas_sin_firma on public.recetas
  for update to authenticated
  using (
    medico_id in (select usuarios.id from usuarios where usuarios.auth_id = auth.uid())
    and not public.receta_firmada(id)
  );
