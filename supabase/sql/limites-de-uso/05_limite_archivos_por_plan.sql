-- Límite de ARCHIVOS (tabla estudios) por plan individual. Reemplaza el cuerpo de la función que ya usa el trigger
-- existente trg_verificar_limite_archivos (BEFORE INSERT ON estudios) — no crea otro trigger.
--   Prueba Gratuita 50 · Starter 1.500 · Pro 5.000 · Premium 15.000 · ilimitado (cuentas viejas): sin límite.
--   * Cuenta los archivos que existen hoy en estudios (sin mirar historial de borrados).
--   * Solo bloquea altas nuevas: al bajar de plan se conserva lo que ya tiene (nunca se borra nada).
--   * Pacientes de Centro Médico: con el centro 'activo' no hay límite; sin activar, el tope gratuito (50), igual que pacientes.
create or replace function public.verificar_limite_archivos()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_centro_id bigint;
  v_medico_id bigint;
  v_plan text;
  v_estado text;
  v_limite integer;
  v_actual integer;
begin
  select centro_id, medico_id into v_centro_id, v_medico_id from pacientes where id = NEW.paciente_id;

  if v_centro_id is not null then
    select coalesce(plan_estado, 'activo') into v_estado from centros_medicos where id = v_centro_id;
    if coalesce(v_estado, 'activo') = 'activo' then
      return NEW;
    end if;
    perform pg_advisory_xact_lock(hashtext('arch_lim_centro_' || v_centro_id));
    select count(*) into v_actual from estudios e join pacientes p on p.id = e.paciente_id where p.centro_id = v_centro_id;
    if v_actual >= 50 then
      raise exception 'Se alcanzó el límite de archivos del centro (50): el plan todavía no fue activado.';
    end if;
  else
    select lower(coalesce(plan, 'trial')) into v_plan from usuarios where id = v_medico_id;
    v_plan := coalesce(v_plan, 'trial');
    v_limite := case
      when v_plan ~ '(ilimitado|unlimited)' then null
      when v_plan like '%premium%' then 15000
      when v_plan like '%pro%' then 5000
      when v_plan like '%starter%' then 1500
      else 50
    end;
    if v_limite is not null then
      perform pg_advisory_xact_lock(hashtext('arch_lim_medico_' || coalesce(v_medico_id::text, '')));
      select count(*) into v_actual from estudios e join pacientes p on p.id = e.paciente_id
        where p.medico_id = v_medico_id and p.centro_id is null;
      if v_actual >= v_limite then
        raise exception 'Se alcanzó el límite de archivos de tu plan (%).', v_limite;
      end if;
    end if;
  end if;
  return NEW;
end $$;

revoke execute on function public.verificar_limite_archivos() from anon, authenticated, public;
