-- Límite de pacientes SOLO en Prueba Gratuita (35). Reemplaza el cuerpo de la función que ya usa
-- el trigger existente trg_verificar_limite_pacientes (BEFORE INSERT ON pacientes) — no crea otro trigger.
--   * Médico individual: 35 solo si su plan NO es starter/pro/premium/ilimitado (trial u otro valor no reconocido).
--   * Paciente de centro: 35 solo si el centro NO está 'activo'; con centro activo no hay límite.
--   * Solo bloquea altas nuevas: los pacientes que ya excedan el límite no se tocan.
create or replace function public.verificar_limite_pacientes()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_plan text;
  v_estado text;
  v_actual integer;
  v_limite constant integer := 35;
begin
  if NEW.centro_id is not null then
    select coalesce(plan_estado, 'activo') into v_estado from centros_medicos where id = NEW.centro_id;
    if coalesce(v_estado, 'activo') = 'activo' then
      return NEW;
    end if;
    perform pg_advisory_xact_lock(hashtext('pac_lim_centro_' || NEW.centro_id));
    select count(*) into v_actual from pacientes where centro_id = NEW.centro_id;
    if v_actual >= v_limite then
      raise exception 'Se alcanzó el límite de pacientes del centro (%): el plan todavía no fue activado.', v_limite;
    end if;
  else
    select lower(coalesce(plan, 'trial')) into v_plan from usuarios where id = NEW.medico_id;
    v_plan := coalesce(v_plan, 'trial');
    if v_plan ~ '(ilimitado|unlimited|starter|pro|premium)' then
      return NEW;
    end if;
    perform pg_advisory_xact_lock(hashtext('pac_lim_medico_' || coalesce(NEW.medico_id::text, '')));
    select count(*) into v_actual from pacientes where medico_id = NEW.medico_id and centro_id is null;
    if v_actual >= v_limite then
      raise exception 'Se alcanzó el límite de pacientes de la Prueba Gratuita (%).', v_limite;
    end if;
  end if;
  return NEW;
end $$;

-- La función la dispara el trigger, nadie la llama directo.
revoke execute on function public.verificar_limite_pacientes() from anon, authenticated, public;
