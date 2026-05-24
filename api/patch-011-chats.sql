-- ============================================================
-- PATCH 011 · Messaging / Group Chat layer
--
-- Adds a Slack-style chat system scoped to tours. Crew + TM can
-- have group chats and 1-on-1 DMs. TM-created chats can be flagged
-- is_official=true to render with the gold/copper accent and sort
-- to the top of every member's chat list.
--
-- Tables:
--   chats          — one row per conversation thread
--   chat_members   — who's in each chat (incl. last_read_at for unread counts)
--   chat_messages  — every message body
--   chat_reactions — emoji reactions on messages
--
-- All four are realtime-enabled so messages, reactions, and read
-- receipts propagate to every device on the chat instantly.
--
-- Safe to re-run.
-- ============================================================

-- ─── Tables ───────────────────────────────────────────────────────

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  tour_id uuid not null references public.tours(id) on delete cascade,
  name text not null,
  is_official boolean default false,
  is_dm boolean default false,
  created_by uuid not null references auth.users(id),
  created_at timestamptz default now(),
  archived boolean default false
);

create table if not exists public.chat_members (
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz default now(),
  last_read_at timestamptz default now(),
  muted boolean default false,
  primary key (chat_id, user_id)
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  sender_id uuid not null references auth.users(id),
  body text not null,
  mentions uuid[] default '{}',
  is_broadcast boolean default false,
  created_at timestamptz default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create table if not exists public.chat_reactions (
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz default now(),
  primary key (message_id, user_id, emoji)
);

-- ─── Indexes ──────────────────────────────────────────────────────

create index if not exists idx_chats_tour on public.chats(tour_id);
create index if not exists idx_chat_messages_chat_created on public.chat_messages(chat_id, created_at desc);
create index if not exists idx_chat_members_user on public.chat_members(user_id);
create index if not exists idx_chat_reactions_msg on public.chat_reactions(message_id);

-- ─── RLS helper functions (SECURITY DEFINER) ─────────────────────
-- Avoid recursive RLS on chat_members by pushing checks through
-- a security-definer function. Standard pattern in Supabase.

create or replace function public.is_chat_member(_chat_id uuid)
returns boolean
language sql security definer set search_path = public
stable
as $$
  select exists(
    select 1 from public.chat_members
    where chat_id = _chat_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_chat_tour_owner(_chat_id uuid)
returns boolean
language sql security definer set search_path = public
stable
as $$
  select exists(
    select 1 from public.chats c
    join public.tours t on t.id = c.tour_id
    where c.id = _chat_id and t.owner_id = auth.uid()
  );
$$;

-- tours.member_ids is stored as JSONB in this schema (not uuid[]), so we
-- use the jsonb containment operator `?` which returns true when the
-- given string exists as a top-level array element. auth.uid()::text
-- gives us the user's uuid as a string for the lookup.
create or replace function public.is_tour_member_or_owner(_tour_id uuid)
returns boolean
language sql security definer set search_path = public
stable
as $$
  select exists(
    select 1 from public.tours t
    where t.id = _tour_id and (
      t.owner_id = auth.uid() or
      coalesce(t.member_ids ? auth.uid()::text, false)
    )
  );
$$;

-- ─── RLS policies ─────────────────────────────────────────────────

alter table public.chats          enable row level security;
alter table public.chat_members   enable row level security;
alter table public.chat_messages  enable row level security;
alter table public.chat_reactions enable row level security;

-- chats
drop policy if exists "chats_select"        on public.chats;
drop policy if exists "chats_insert"        on public.chats;
drop policy if exists "chats_update"        on public.chats;
drop policy if exists "chats_delete"        on public.chats;

create policy "chats_select" on public.chats for select
  to authenticated using (
    public.is_chat_member(id) or public.is_chat_tour_owner(id)
  );

create policy "chats_insert" on public.chats for insert
  to authenticated with check (
    public.is_tour_member_or_owner(tour_id) and
    -- Only the TM (tour owner) can flag is_official
    (not is_official or exists(select 1 from public.tours where id = tour_id and owner_id = auth.uid()))
  );

create policy "chats_update" on public.chats for update
  to authenticated using (
    created_by = auth.uid() or public.is_chat_tour_owner(id)
  );

create policy "chats_delete" on public.chats for delete
  to authenticated using (
    created_by = auth.uid() or public.is_chat_tour_owner(id)
  );

-- chat_members
drop policy if exists "chat_members_select"           on public.chat_members;
drop policy if exists "chat_members_insert"           on public.chat_members;
drop policy if exists "chat_members_update_self"      on public.chat_members;
drop policy if exists "chat_members_delete"           on public.chat_members;

create policy "chat_members_select" on public.chat_members for select
  to authenticated using (
    user_id = auth.uid() or public.is_chat_member(chat_id) or public.is_chat_tour_owner(chat_id)
  );

create policy "chat_members_insert" on public.chat_members for insert
  to authenticated with check (
    public.is_chat_tour_owner(chat_id) or
    exists(select 1 from public.chats c where c.id = chat_id and c.created_by = auth.uid())
  );

create policy "chat_members_update_self" on public.chat_members for update
  to authenticated using (
    user_id = auth.uid() or public.is_chat_tour_owner(chat_id)
  );

create policy "chat_members_delete" on public.chat_members for delete
  to authenticated using (
    user_id = auth.uid() or public.is_chat_tour_owner(chat_id)
  );

-- chat_messages
drop policy if exists "chat_messages_select" on public.chat_messages;
drop policy if exists "chat_messages_insert" on public.chat_messages;
drop policy if exists "chat_messages_update" on public.chat_messages;
drop policy if exists "chat_messages_delete" on public.chat_messages;

create policy "chat_messages_select" on public.chat_messages for select
  to authenticated using (
    public.is_chat_member(chat_id) or public.is_chat_tour_owner(chat_id)
  );

create policy "chat_messages_insert" on public.chat_messages for insert
  to authenticated with check (
    sender_id = auth.uid() and public.is_chat_member(chat_id)
  );

create policy "chat_messages_update" on public.chat_messages for update
  to authenticated using (sender_id = auth.uid());

create policy "chat_messages_delete" on public.chat_messages for delete
  to authenticated using (
    sender_id = auth.uid() or public.is_chat_tour_owner(chat_id)
  );

-- chat_reactions
drop policy if exists "chat_reactions_select" on public.chat_reactions;
drop policy if exists "chat_reactions_insert" on public.chat_reactions;
drop policy if exists "chat_reactions_delete" on public.chat_reactions;

create policy "chat_reactions_select" on public.chat_reactions for select
  to authenticated using (
    exists(
      select 1 from public.chat_messages m
      where m.id = message_id and (public.is_chat_member(m.chat_id) or public.is_chat_tour_owner(m.chat_id))
    )
  );

create policy "chat_reactions_insert" on public.chat_reactions for insert
  to authenticated with check (
    user_id = auth.uid() and
    exists(
      select 1 from public.chat_messages m
      where m.id = message_id and public.is_chat_member(m.chat_id)
    )
  );

create policy "chat_reactions_delete" on public.chat_reactions for delete
  to authenticated using (user_id = auth.uid());

-- ─── Realtime publication ────────────────────────────────────────

do $$
begin
  begin alter publication supabase_realtime add table public.chats;          exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.chat_members;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.chat_messages;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.chat_reactions; exception when duplicate_object then null; end;
end $$;
