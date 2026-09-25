-- Límite de archivos, paso 2: la subida directa a Storage (bucket estudios-adjuntos) de los pacientes PROPIOS del médico.
-- No se reemplaza la política de subida: se le AGREGA (AND) el chequeo de cupo con ALTER POLICY, que conserva rol y comando.
-- La condición de dispositivo/paciente propio (centro_id IS NULL) queda EXACTAMENTE igual. Los pacientes de centro siguen entrando
-- solo por la Edge Function estudio-gestion-centro (sin tope de archivos).
--   Prueba Gratuita 50 · Starter 1.500 · Pro 5.000 · Premium 15.000 · ilimitado: sin límite.
--
-- MARCHA ATRÁS (deja la política como estaba):
--   alter policy estudios_storage_insert on storage.objects with check (
--     (bucket_id = 'estudios-adjuntos'::text) AND (((storage.foldername(name))[1])::bigint IN (
--       SELECT p.id FROM (pacientes p JOIN usuarios u ON ((u.id = p.medico_id)))
--       WHERE ((u.auth_id = auth.uid()) AND (p.centro_id IS NULL)))));

create or replace function public._limite_archivos_plan(p_plan text)
returns integer language sql immutable set search_path = public as $$
  select case
    when lower(coalesce(p_plan,'trial')) ~ '(ilimitado|unlimited)' then null
    when lower(coalesce(p_plan,'trial')) like '%premium%' then 15000
    when lower(coalesce(p_plan,'trial')) like '%pro%' then 5000
    when lower(coalesce(p_plan,'trial')) like '%starter%' then 1500
    else 50
  end
$$;

-- Para el aviso "X / N archivos" de la app (cuenta las filas de estudios de sus pacientes propios).
create or replace function public.mi_cupo_archivos()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_med bigint; v_plan text; v_usado integer;
begin
  select id, plan into v_med, v_plan from usuarios where auth_id = auth.uid();
  if v_med is null then return null; end if;
  select count(*) into v_usado from estudios e join pacientes p on p.id = e.paciente_id
    where p.medico_id = v_med and p.centro_id is null;
  return jsonb_build_object('usado', v_usado, 'limite', public._limite_archivos_plan(v_plan));
end $$;

-- Para la política de Storage: ¿le queda cupo? Cuenta los archivos que existen hoy en el bucket, de sus pacientes propios,
-- así también frena a quien suba a Storage sin registrar la fila.
create or replace function public.puede_subir_estudio()
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_med bigint; v_plan text; v_lim integer; v_usado integer;
begin
  select id, plan into v_med, v_plan from usuarios where auth_id = auth.uid();
  if v_med is null then return false; end if;
  v_lim := public._limite_archivos_plan(v_plan);
  if v_lim is null then return true; end if;
  select count(*) into v_usado from storage.objects o
    where o.bucket_id = 'estudios-adjuntos'
      and (storage.foldername(o.name))[1] in (select p.id::text from pacientes p where p.medico_id = v_med and p.centro_id is null);
  return v_usado < v_lim;
end $$;

-- Las dos las llama el propio médico logueado (la política y la app), nunca anon.
revoke execute on function public.mi_cupo_archivos() from anon, authenticated, public;
revoke execute on function public.puede_subir_estudio() from anon, authenticated, public;
revoke execute on function public._limite_archivos_plan(text) from anon, authenticated, public;
grant execute on function public.mi_cupo_archivos() to authenticated;
grant execute on function public.puede_subir_estudio() to authenticated;
grant execute on function public._limite_archivos_plan(text) to authenticated;

alter policy estudios_storage_insert on storage.objects
with check (
  (bucket_id = 'estudios-adjuntos'::text) AND (((storage.foldername(name))[1])::bigint IN (
    SELECT p.id FROM (pacientes p JOIN usuarios u ON ((u.id = p.medico_id)))
    WHERE ((u.auth_id = auth.uid()) AND (p.centro_id IS NULL))))
  AND public.puede_subir_estudio()
);
