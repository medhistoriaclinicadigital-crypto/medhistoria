-- Límite de RECETAS POR MES solo en Prueba Gratuita (20). Starter/Pro/Premium/ilimitado: sin límite.
--   * Mes calendario, corte en America/Argentina/Buenos_Aires.
--   * Cuenta las recetas que existen hoy en `recetas` para ese médico en el mes (si una se borra, libera cupo).
--   * Solo bloquea altas nuevas (BEFORE INSERT): las recetas ya emitidas no se tocan.
--   * Un médico de un Centro Médico con plan activo queda sin límite (igual que en pacientes).
create or replace function public.verificar_limite_recetas_mes()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_plan text;
  v_desde timestamptz;
  v_actual integer;
  v_limite constant integer := 20;
  v_tz constant text := 'America/Argentina/Buenos_Aires';
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
  v_desde := date_trunc('month', now() at time zone v_tz) at time zone v_tz;
  select count(*) into v_actual from recetas where medico_id = NEW.medico_id and created_at >= v_desde;
  if v_actual >= v_limite then
    raise exception 'Se alcanzó el límite de recetas de la Prueba Gratuita (% por mes).', v_limite;
  end if;
  return NEW;
end $$;

revoke execute on function public.verificar_limite_recetas_mes() from anon, authenticated, public;

drop trigger if exists trg_verificar_limite_recetas_mes on public.recetas;
create trigger trg_verificar_limite_recetas_mes
  before insert on public.recetas
  for each row execute function public.verificar_limite_recetas_mes();
