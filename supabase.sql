-- Mi Bolsillo: tablas y seguridad.
-- Pegar completo en Supabase → SQL Editor → New query → Run.
-- Se puede volver a correr sin romper nada.

create table if not exists public.movimientos (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tipo        text not null check (tipo in ('gasto', 'ingreso')),
  monto       bigint not null check (monto > 0),
  categoria   text not null,
  fecha       date not null,
  nota        text not null default '',
  ejemplo     boolean not null default false,
  actualizado timestamptz not null default now()
);
create index if not exists movimientos_usuario_fecha on public.movimientos (user_id, fecha);

create table if not exists public.presupuestos (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  topes       jsonb not null default '{}'::jsonb,
  ejemplo     boolean not null default false,
  actualizado timestamptz not null default now()
);

-- Seguridad por usuario: cada cuenta solo ve y cambia lo suyo
alter table public.movimientos enable row level security;
alter table public.presupuestos enable row level security;

drop policy if exists "movimientos_leer" on public.movimientos;
drop policy if exists "movimientos_crear" on public.movimientos;
drop policy if exists "movimientos_cambiar" on public.movimientos;
drop policy if exists "movimientos_borrar" on public.movimientos;
create policy "movimientos_leer" on public.movimientos for select using (auth.uid() = user_id);
create policy "movimientos_crear" on public.movimientos for insert with check (auth.uid() = user_id);
create policy "movimientos_cambiar" on public.movimientos for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "movimientos_borrar" on public.movimientos for delete using (auth.uid() = user_id);

drop policy if exists "presupuestos_leer" on public.presupuestos;
drop policy if exists "presupuestos_crear" on public.presupuestos;
drop policy if exists "presupuestos_cambiar" on public.presupuestos;
drop policy if exists "presupuestos_borrar" on public.presupuestos;
create policy "presupuestos_leer" on public.presupuestos for select using (auth.uid() = user_id);
create policy "presupuestos_crear" on public.presupuestos for insert with check (auth.uid() = user_id);
create policy "presupuestos_cambiar" on public.presupuestos for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "presupuestos_borrar" on public.presupuestos for delete using (auth.uid() = user_id);
