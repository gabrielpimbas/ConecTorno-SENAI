-- CONECTORNO / MUNDO SENAI — PROJETO NOVO, UMA CONTA ADMINISTRADORA
-- Rodar em SQL Editor de um NOVO projeto Supabase, uma única vez.
-- Não é um script de migração para o projeto antigo.

create table public.administradores (
  usuario_id uuid primary key references auth.users(id) on delete cascade
);

create table public.conteudos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('imagem','pdf','mensagem')),
  titulo text not null check (char_length(titulo) between 1 and 500),
  caminho text,
  mime text,
  autor uuid not null references auth.users(id),
  criado_em timestamptz not null default now(),
  constraint arquivo_ou_mensagem check (
    (tipo = 'mensagem' and caminho is null)
    or (tipo in ('imagem','pdf') and caminho is not null)
  )
);

alter table public.administradores enable row level security;
alter table public.conteudos enable row level security;

-- O site só usa autenticação com e-mail e senha.
grant select on public.administradores to authenticated;
grant select, insert, delete on public.conteudos to authenticated;

create policy "Admin consulta sua autorização"
on public.administradores for select to authenticated
using (usuario_id = (select auth.uid()));

create policy "Admin consulta conteúdos"
on public.conteudos for select to authenticated
using (exists (select 1 from public.administradores a where a.usuario_id = (select auth.uid())));

create policy "Admin publica conteúdos"
on public.conteudos for insert to authenticated
with check (autor = (select auth.uid()) and exists (select 1 from public.administradores a where a.usuario_id = (select auth.uid())));

create policy "Admin remove conteúdos"
on public.conteudos for delete to authenticated
using (exists (select 1 from public.administradores a where a.usuario_id = (select auth.uid())));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'conectorno-arquivos', 'conectorno-arquivos', false, 20971520,
  array['application/pdf','image/png','image/jpeg','image/webp']
);

create policy "Admin envia arquivos"
on storage.objects for insert to authenticated
with check (bucket_id = 'conectorno-arquivos' and exists (select 1 from public.administradores a where a.usuario_id = (select auth.uid())));

create policy "Admin lê arquivos"
on storage.objects for select to authenticated
using (bucket_id = 'conectorno-arquivos' and exists (select 1 from public.administradores a where a.usuario_id = (select auth.uid())));

create policy "Admin remove arquivos"
on storage.objects for delete to authenticated
using (bucket_id = 'conectorno-arquivos' and exists (select 1 from public.administradores a where a.usuario_id = (select auth.uid())));

-- Atualizações em tempo real: cliente também consulta a cada 5 segundos.
alter publication supabase_realtime add table public.conteudos;

-- APÓS convidar/criar usuário em Authentication > Users, execute em UMA NOVA QUERY:
-- insert into public.administradores (usuario_id) values ('UID_DO_USUARIO_AQUI');
