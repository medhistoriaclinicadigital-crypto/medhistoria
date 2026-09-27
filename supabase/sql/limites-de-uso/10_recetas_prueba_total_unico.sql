-- Recetas: el límite de 20 de la Prueba Gratuita pasa a ser un TOTAL ÚNICO para toda la prueba (30 días),
-- sin resetearse por mes calendario. Antes se calculaba "por mes" (date_trunc('month', ...)), lo cual reinicia
-- el cupo a mitad de la prueba si el médico se registró cerca de fin de mes — la Prueba Gratuita es un período
-- único, no una suscripción recurrente (mismo criterio ya aplicado al límite de 35 pacientes, que tampoco tiene
-- ventana de tiempo). Ver supabase/DISENO-limites-de-uso-por-plan.md §5 (resuelto 2026-09-27): los planes pagos
-- (Starter/Pro/Premium) seguirán reseteándose cada mes cuando se implemente su cupo — esto NO les aplica, siguen
-- ilimitados en recetas hoy.
--
-- Se renombra la función a verificar_limite_recetas_prueba (ya no es "por mes"): se crea la nueva, se repunta
-- el trigger, y se borra la vieja. El criterio de exención (starter/pro/premium/ilimitado, Centro Médico activo)
-- y el mensaje de bloqueo quedan iguales; solo se saca el filtro de fecha.
--
-- MARCHA ATRÁS (deja todo como estaba) — ⚠️ SOLO SI HACE FALTA, NO CORRER EN CONDICIONES NORMALES:
--   create or replace function public.verificar_limite_recetas_mes()
--   returns trigger language plpgsql security definer set search_path = public as $$
--   declare
--     v_plan text;
--     v_desde timestamptz;
--     v_actual integer;
--     v_limite constant integer := 20;
--     v_tz constant text := 'America/Argentina/Buenos_Aires';
--   begin
--     select lower(coalesce(plan, 'trial')) into v_plan from usuarios where id = NEW.medico_id;
--     v_plan := coalesce(v_plan, 'trial');
--     if v_plan ~ '(ilimitado|unlimited|starter|pro|premium)' then
--       return NEW;
--     end if;
--     if exists (
--       select 1 from centro_medicos_usuarios cu
--       join centros_medicos c on c.id = cu.centro_id
--       where cu.medico_id = NEW.medico_id and coalesce(c.plan_estado, 'activo') = 'activo'
--     ) then
--       return NEW;
--     end if;
--     perform pg_advisory_xact_lock(hashtext('rec_lim_' || coalesce(NEW.medico_id::text, '')));
--     v_desde := date_trunc('month', now() at time zone v_tz) at time zone v_tz;
--     select count(*) into v_actual from recetas where medico_id = NEW.medico_id and created_at >= v_desde;
--     if v_actual >= v_limite then
--       raise exception 'Se alcanzó el límite de recetas de la Prueba Gratuita (% por mes).', v_limite;
--     end if;
--     return NEW;
--   end $$;
--   drop trigger if exists trg_verificar_limite_recetas_mes on public.recetas;
--   create trigger trg_verificar_limite_recetas_mes before insert on public.recetas
--     for each row execute function public.verificar_limite_recetas_mes();
--   drop function if exists public.verificar_limite_recetas_prueba();
--   drop trigger if exists trg_verificar_limite_recetas_prueba on public.recetas;

create or replace function public.verificar_limite_recetas_prueba()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_plan text;
  v_actual integer;
  v_limite constant integer := 20;
begin
  select lower(coalesce(plan, 'trial')) into v_plan from usuarios where id = NEW.medico_id;
  v_plan := coalesce(v_plan, 'trial');
  if v_plan ~ '(ilimitado|unlimited|starter|pro|premium)' then
    return NEW;
  end if;
  if exists (
    select 1 from centro_medicos_usuarios cu
    join centros_medicos c on c.id = cu.centro_id
    where cu.medico_id = NEW.medico_id and coalesce(c.plan_estado, 'activo') = 'activo'
  ) then
    return NEW;
  end if;

  perform pg_advisory_xact_lock(hashtext('rec_lim_' || coalesce(NEW.medico_id::text, '')));
  select count(*) into v_actual from recetas where medico_id = NEW.medico_id;
  if v_actual >= v_limite then
    raise exception 'Se alcanzó el límite de recetas de la Prueba Gratuita (%).', v_limite;
  end if;
  return NEW;
end $$;

revoke execute on function public.verificar_limite_recetas_prueba() from anon, authenticated, public;

drop trigger if exists trg_verificar_limite_recetas_mes on public.recetas;
create trigger trg_verificar_limite_recetas_prueba
  before insert on public.recetas
  for each row execute function public.verificar_limite_recetas_prueba();

drop function if exists public.verificar_limite_recetas_mes();
