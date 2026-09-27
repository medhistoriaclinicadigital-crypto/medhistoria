-- Recetas: un médico solo puede borrar (por la app o por la API) una receta PROPIA que todavía NO está firmada.
-- Motivo: el límite mensual de la Prueba Gratuita (SQL 04) cuenta las filas que EXISTEN, y una receta firmada es un
-- documento con validez que no debería poder borrarse desde el cliente. La app solo borra recetas sin firmar
-- (si falló la generación del PDF, o una emisión anterior que nunca se firmó), así que no se rompe la corrección de errores.
--
-- Criterio de "firmada": existe una fila en public.firmas_recetas con id_receta = recetas.id. Esa tabla la escribe únicamente
-- la Edge Function firma-receta (service_role), es inmutable y los médicos no pueden leerla ni escribirla; por eso la consulta
-- va en una función SECURITY DEFINER (la política se evalúa con los permisos del médico, que no puede leer firmas_recetas).
-- El borrado manual desde el SQL Editor (rol postgres) o con service_role no se ve afectado.
--
-- MARCHA ATRÁS (deja todo como estaba) — ⚠️ SOLO SI HACE FALTA, NO CORRER EN CONDICIONES NORMALES:
--   drop policy if exists medicos_borran_sus_recetas_sin_firma on public.recetas;
--   create policy medicos_borran_sus_recetas on public.recetas for delete to public
--     using (medico_id in (select usuarios.id from usuarios where usuarios.auth_id = auth.uid()));
--   drop function if exists public.receta_firmada(bigint);

create or replace function public.receta_firmada(p_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.firmas_recetas where id_receta = p_id)
$$;
revoke execute on function public.receta_firmada(bigint) from anon, authenticated, public;
grant execute on function public.receta_firmada(bigint) to authenticated;

drop policy if exists medicos_borran_sus_recetas on public.recetas;
create policy medicos_borran_sus_recetas_sin_firma on public.recetas
  for delete to authenticated
  using (
    medico_id in (select usuarios.id from usuarios where usuarios.auth_id = auth.uid())
    and not public.receta_firmada(id)
  );
