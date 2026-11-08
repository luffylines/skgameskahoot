-- SKVASRA Live Games - install in a NEW, separate Supabase project.
-- Run this file once in the Supabase SQL Editor as an administrator.
-- No SKVASRA production tables or accounts are modified.

create extension if not exists pgcrypto;

create table if not exists public.sk_hosts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users(id) on delete cascade,
  pin text not null unique check (pin ~ '^[0-9]{6}$'),
  title text not null check (char_length(trim(title)) between 3 and 90),
  status text not null default 'draft' check (status in ('draft', 'lobby', 'live', 'ended')),
  fb_video_url text,
  verified_video_url text,
  facebook_live boolean not null default false,
  live_checked_at timestamptz,
  test_mode boolean not null default false,
  current_question integer not null default 0 check (current_question >= 0),
  question_ends_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  position integer not null check (position > 0),
  prompt text not null check (char_length(trim(prompt)) between 3 and 220),
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 4),
  correct_index integer not null check (correct_index between 0 and 3),
  seconds integer not null default 20 check (seconds between 5 and 90),
  points integer not null default 1000 check (points between 100 and 2000),
  unique (game_id, position)
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null check (char_length(trim(nickname)) between 2 and 28),
  score integer not null default 0 check (score >= 0),
  joined_at timestamptz not null default now(),
  unique (game_id, user_id)
);

create unique index if not exists players_game_nickname_ci on public.players (game_id, lower(nickname));
create index if not exists players_game_score on public.players (game_id, score desc);

create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  choice integer not null check (choice between 0 and 3),
  is_correct boolean not null,
  points_awarded integer not null default 0 check (points_awarded >= 0),
  created_at timestamptz not null default now(),
  unique (question_id, player_id)
);

create index if not exists answers_player_question on public.answers (player_id, question_id);
alter table public.sk_hosts enable row level security;
alter table public.games enable row level security;
alter table public.questions enable row level security;
alter table public.players enable row level security;
alter table public.answers enable row level security;

-- An anonymous PLAYER is a real auth.users row created via Supabase Anonymous Sign-ins.
-- Public (unauthenticated) users cannot read or mutate game data.
create policy "hosts can see their account" on public.sk_hosts
  for select to authenticated using (user_id = (select auth.uid()));

create policy "hosts and event participants can read games" on public.games
  for select to authenticated using (
    host_id = (select auth.uid())
    or status = 'ended'
    or (status in ('lobby', 'live') and (facebook_live or test_mode))
  );

create policy "approved SK officers create draft games" on public.games
  for insert to authenticated with check (
    host_id = (select auth.uid())
    and exists (select 1 from public.sk_hosts h where h.user_id = (select auth.uid()))
    and status = 'draft' and facebook_live = false and test_mode = false
    and current_question = 0 and question_ends_at is null
  );

create policy "game owner edits own games" on public.games
  for update to authenticated
  using (host_id = (select auth.uid()) and exists (select 1 from public.sk_hosts h where h.user_id = (select auth.uid())))
  with check (host_id = (select auth.uid()) and exists (select 1 from public.sk_hosts h where h.user_id = (select auth.uid())));

-- Keep correct answers PRIVATE until a timed round expires. The public_round RPC
-- exposes only the current prompt/options before the deadline.
create policy "SK owners can read their questions" on public.questions
  for select to authenticated using (
    exists (select 1 from public.games g where g.id = game_id and g.host_id = (select auth.uid()))
  );

create policy "SK owners can add draft questions" on public.questions
  for insert to authenticated with check (
    exists (select 1 from public.games g where g.id = game_id and g.host_id = (select auth.uid()) and g.status = 'draft')
  );

create policy "participants and hosts see public rankings" on public.players
  for select to authenticated using (
    user_id = (select auth.uid()) or exists (
      select 1 from public.games g where g.id = game_id
      and (g.host_id = (select auth.uid()) or g.status = 'ended'
           or (g.status in ('lobby', 'live') and (g.facebook_live or g.test_mode)))
    )
  );

create policy "players can see only their submissions" on public.answers
  for select to authenticated using (
    exists (select 1 from public.players p where p.id = player_id and p.user_id = (select auth.uid()))
    or exists (select 1 from public.games g where g.id = game_id and g.host_id = (select auth.uid()))
  );

-- Lock Data API writes to the exact columns used by the SK editor.
-- The service key is used server-side ONLY to set facebook_live/verified_video_url.
revoke all on public.sk_hosts, public.games, public.questions, public.players, public.answers from anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.sk_hosts, public.games, public.questions, public.players, public.answers to authenticated;
grant insert (host_id, pin, title, fb_video_url) on public.games to authenticated;
grant update (title, fb_video_url, status, test_mode) on public.games to authenticated;
grant insert (game_id, position, prompt, options, correct_index, seconds, points) on public.questions to authenticated;

-- Private-answers and scoring operations run through tightly checked RPCs.
create or replace function public.join_game(p_pin text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_game public.games%rowtype;
  v_player uuid;
  v_nick text := trim(p_nickname);
begin
  if v_uid is null then raise exception 'Please enable guest login first.'; end if;
  if p_pin !~ '^[0-9]{6}$' or char_length(v_nick) not between 2 and 28 then
    raise exception 'Invalid PIN or nickname.';
  end if;
  select * into v_game from public.games where pin = p_pin;
  if not found then raise exception 'Game PIN not found.'; end if;
  if v_game.status not in ('lobby', 'live') then raise exception 'This event is not open for joining.'; end if;
  if not (v_game.facebook_live or v_game.test_mode) then
    raise exception 'This game only opens while SK Vasra is live on Facebook.';
  end if;
  insert into public.players (game_id, user_id, nickname)
  values (v_game.id, v_uid, v_nick)
  on conflict (game_id, user_id) do update set nickname = excluded.nickname
  returning id into v_player;
  return jsonb_build_object('game_id', v_game.id, 'player_id', v_player, 'status', v_game.status);
exception when unique_violation then
  raise exception 'That nickname is already taken in this game. Choose another.';
end;
$$;

create or replace function public.public_round(p_pin text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_g public.games%rowtype;
  v_q public.questions%rowtype;
  v_player uuid;
  v_choice integer;
  v_over boolean;
  v_allowed boolean;
  v_count integer;
begin
  if v_uid is null then raise exception 'Sign in as a guest to play.'; end if;
  select * into v_g from public.games where pin = p_pin;
  if not found then raise exception 'Game not found.'; end if;
  select id into v_player from public.players where game_id = v_g.id and user_id = v_uid;
  if v_player is null and v_g.host_id <> v_uid then raise exception 'Join the game first.'; end if;
  v_allowed := (v_g.facebook_live or v_g.test_mode);
  select count(*) into v_count from public.questions where game_id = v_g.id;
  if not v_allowed and v_g.status <> 'ended' then
    return jsonb_build_object('status', 'off_air', 'facebook_live', false, 'test_mode', false,
       'allowed', false, 'current_question', v_g.current_question, 'total_questions', v_count,
       'question', null, 'your_answer', null, 'round_over', false);
  end if;
  if v_g.current_question < 1 then
    return jsonb_build_object('status', v_g.status, 'facebook_live', v_g.facebook_live,
       'test_mode', v_g.test_mode, 'allowed', v_allowed, 'current_question', 0,
       'total_questions', v_count, 'question', null, 'your_answer', null, 'round_over', false);
  end if;
  select * into v_q from public.questions where game_id = v_g.id and position = v_g.current_question;
  if not found then raise exception 'Current question missing.'; end if;
  select a.choice into v_choice from public.answers a where a.player_id = v_player and a.question_id = v_q.id;
  v_over := v_g.status = 'ended' or clock_timestamp() >= v_g.question_ends_at;
  return jsonb_build_object(
    'status', v_g.status, 'facebook_live', v_g.facebook_live, 'test_mode', v_g.test_mode,
    'allowed', v_allowed, 'current_question', v_g.current_question, 'total_questions', v_count,
    'ends_at', v_g.question_ends_at, 'round_over', v_over, 'your_answer', v_choice,
    'correct_index', case when v_over then v_q.correct_index else null end,
    'question', jsonb_build_object('id', v_q.id, 'prompt', v_q.prompt, 'options', v_q.options, 'seconds', v_q.seconds)
  );
end;
$$;

create or replace function public.submit_answer(p_pin text, p_choice integer)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_g public.games%rowtype;
  v_q public.questions%rowtype;
  v_player uuid;
  v_answer uuid;
  v_right boolean;
  v_award integer := 0;
  v_remaining numeric;
begin
  if v_uid is null then raise exception 'Sign in to answer.'; end if;
  if p_choice not between 0 and 3 then raise exception 'Invalid answer.'; end if;
  select * into v_g from public.games where pin = p_pin;
  if not found or v_g.status <> 'live' or not (v_g.facebook_live or v_g.test_mode)
     or v_g.question_ends_at is null or clock_timestamp() >= v_g.question_ends_at then
    raise exception 'This question is closed.';
  end if;
  select * into v_q from public.questions where game_id = v_g.id and position = v_g.current_question;
  if not found then raise exception 'Question not found.'; end if;
  select id into v_player from public.players where game_id = v_g.id and user_id = v_uid;
  if v_player is null then raise exception 'Join the game before answering.'; end if;
  v_right := (p_choice = v_q.correct_index);
  if v_right then
    v_remaining := greatest(0, least(1, extract(epoch from (v_g.question_ends_at - clock_timestamp())) / v_q.seconds));
    v_award := ceil(v_q.points * (0.4 + 0.6 * v_remaining));
  end if;
  insert into public.answers (game_id, question_id, player_id, choice, is_correct, points_awarded)
  values (v_g.id, v_q.id, v_player, p_choice, v_right, v_award)
  on conflict (question_id, player_id) do nothing returning id into v_answer;
  if v_answer is null then raise exception 'You already answered this question.'; end if;
  update public.players set score = score + v_award where id = v_player;
  return jsonb_build_object('correct', v_right, 'points', v_award, 'accepted', true);
end;
$$;

create or replace function public.host_next_question(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_g public.games%rowtype;
  v_q public.questions%rowtype;
  v_next integer;
begin
  if auth.uid() is null then raise exception 'Sign in as an SK officer.'; end if;
  select * into v_g from public.games where id = p_game_id for update;
  if not found or v_g.host_id <> auth.uid() or
     not exists (select 1 from public.sk_hosts h where h.user_id = auth.uid()) then
    raise exception 'SK officer permission required.';
  end if;
  if v_g.status not in ('lobby','live') then raise exception 'Event is not in the lobby or live.'; end if;
  if not (v_g.facebook_live or v_g.test_mode) then raise exception 'Facebook Live is off. Sync the live stream, or enable rehearsal mode.'; end if;
  v_next := v_g.current_question + 1;
  select * into v_q from public.questions where game_id = p_game_id and position = v_next;
  if not found then
    update public.games set status = 'ended', question_ends_at = clock_timestamp() where id = p_game_id;
    return jsonb_build_object('status', 'ended');
  end if;
  update public.games
  set status = 'live', current_question = v_next, question_ends_at = clock_timestamp() + make_interval(secs => v_q.seconds)
  where id = p_game_id;
  return jsonb_build_object('status','live','current_question', v_next);
end;
$$;

-- SECURITY DEFINER functions are not callable by the public anon role.
revoke all on function public.join_game(text,text) from public, anon;
revoke all on function public.public_round(text) from public, anon;
revoke all on function public.submit_answer(text,integer) from public, anon;
revoke all on function public.host_next_question(uuid) from public, anon;
grant execute on function public.join_game(text,text) to authenticated;
grant execute on function public.public_round(text) to authenticated;
grant execute on function public.submit_answer(text,integer) to authenticated;
grant execute on function public.host_next_question(uuid) to authenticated;

-- Subscribe to real-time game status and leaderboard updates.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games') then
      alter publication supabase_realtime add table public.games;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players') then
      alter publication supabase_realtime add table public.players;
    end if;
  end if;
end $$;

-- AFTER creating a real SK officer in Authentication > Users, approve them:
-- insert into public.sk_hosts (user_id)
-- select id from auth.users where email = 'actual-sk-officer@example.com'
-- on conflict do nothing;
