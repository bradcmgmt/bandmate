-- ============================================================
-- PATCH 012 · Skip demo tour seeding on signup
--
-- Previously the handle_new_user trigger auto-created a "Demo Tour ·
-- Wayfinder" with 4 dates whenever a user signed up. For paid TMs
-- subscribing to the production app this is the wrong UX — they
-- subscribed to run their own tour, not browse a demo.
--
-- This patch replaces the trigger so it only creates the profile row.
-- New users land on the onboarding overlay (which already exists)
-- where they choose: load sample tour, upload documents, or build
-- from scratch.
--
-- Safe to re-run. Doesn't touch existing tours.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'role', 'tm')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;
