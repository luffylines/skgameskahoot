# SKVASRA Live Games 🎮

**A separate, SKVASRA-branded Kahoot-style multiplayer quiz site for official Facebook Live events.**

For **Sangguniang Kabataan — Barangay Vasra, Quezon City**. This is independent from the existing [SKVASRA Community Portal](https://skvasra.app); its existing code and database are not modified. The design uses the recognizable navy-blue identity and public seal from [the SKVASRA source repository](https://github.com/luffylines/vasra).

## What's included

- Responsive SKVASRA landing page with Facebook Live player and real OFF AIR / LIVE NOW states.
- Approved **SK officer account**: email/password authentication and a database host allowlist.
- SK Game Studio: create games, add four-option questions, choose correct answers and timers, open lobby, advance rounds, end games, see scores.
- Players enter a **six-digit Game PIN + nickname**, no separate player registration form.
- Server-timed trivia, server-calculated scores, real-time leaderboard and final rankings.
- Labeled rehearsal mode for testing without Facebook Live.
- Server-side Facebook Page Live checker with optional automatic checks every five minutes.
- Vercel-friendly frontend and serverless functions, using a **separate** Supabase project.

**This is source code, not a fully connected production deployment.** For real multiplayer games and automatic Facebook Live detection you must provide your own Supabase project, authorized Facebook Page API credentials and Vercel environment settings. No passwords or secret keys are committed.

## Step 1 — Create a separate Supabase project

1. Create a new project at https://supabase.com/dashboard. **Do not run the SQL in the existing SKVASRA production database.**
2. Open SQL Editor, paste the content of **database/schema.sql**, and run it once.
3. In Authentication settings, enable **Anonymous Sign-ins** for nickname-only players and keep **Email** enabled for SK officers.
4. In Authentication → Users, create a legitimate SK officer's email/password user.
5. Add that user to the SK host allowlist by running the SQL below, replacing the example email:

~~~sql
insert into public.sk_hosts (user_id)
select id from auth.users
where email = 'real-sk-officer@example.com'
on conflict do nothing;
~~~

The database enforces Row Level Security, private correct answers, one answer per question, and server-side scoring. It does not allow public players to create SK hosts.

## Step 2 — Deploy to Vercel

1. Import [luffylines/skgameskahoot](https://github.com/luffylines/skgameskahoot) at https://vercel.com/new as a new independent project.
2. Set framework preset **Other**, root directory **/**, no build command. The HTML, CSS and JS are static; the **api/** files are Vercel Functions.
3. Add the following in Vercel → Project → Settings → Environment Variables:

| Environment variable | Required value |
| --- | --- |
| SUPABASE_URL | URL of your NEW Supabase project |
| SUPABASE_PUBLISHABLE_KEY | Public browser-safe Supabase publishable key |
| SUPABASE_SECRET_KEY | **Private server-only** Supabase secret key |
| FACEBOOK_PAGE_ID | Numeric Facebook Page ID for the official SK Vasra Page |
| FACEBOOK_PAGE_ACCESS_TOKEN | Authorized Meta Page Access Token |
| FACEBOOK_GRAPH_VERSION | Current supported Meta Graph version, e.g. v24.0; verify with Meta |
| CRON_SECRET | Long random secret shared with the scheduler (32+ characters recommended) |

4. Redeploy after saving settings. Visit your new deployment URL. The **/api/config** endpoint should return only the Supabase URL and *publishable* key; never the secret key.

The server-only Meta Page token and Supabase secret key must never be pasted into public HTML, JavaScript, or GitHub files.

## Step 3 — Connect official Facebook Live

This website **does not broadcast to Facebook**. SK officers start Facebook Live on the official SK Vasra Page as usual. The app then checks the official Page via Meta Graph API, embeds its eligible public video with Facebook's video plugin, and activates gameplay only when the Page is confirmed live.

1. Create or use an authorized Meta Developers app. Obtain a Page Access Token for the **official SK Page** you manage, with the permissions necessary to read its Live videos. These permissions or app review may be required by Meta.
2. Set FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN on Vercel.
3. Log in to SK Game Studio, create a quiz, add questions and open its lobby.
4. When the Facebook Page starts broadcasting, click **Check Facebook Live** for an immediate verification. When verified, the public page switches to LIVE NOW and players can join by PIN.
5. The participation gate also closes when the broadcast stops and a check confirms OFF AIR. If no checks succeed for 15 minutes, server-side gameplay blocks automatically rather than keeping an old live status active.

### Automatic checks without paid Vercel Cron

Included GitHub Actions workflow: **.github/workflows/sync-live.yml**

The schedule requests a live check **approximately every 5 minutes**, although GitHub scheduled workflow runs can be delayed. This is useful on Vercel Hobby, where frequent built-in Cron schedules may not be available.

In this repository, go to **Settings → Secrets and variables → Actions**, and add these two GitHub Actions repository secrets:

- **SKGAMES_DEPLOYMENT_URL** — complete deployed Vercel URL, like https://YOUR-SITE.vercel.app
- **SKGAMES_CRON_SECRET** — exactly the same random secret as Vercel's CRON_SECRET.

Test it using **Actions → Sync SKVASRA Facebook Live status → Run workflow**. A Meta API error means the Page token/permissions need attention; do not claim that a video was successfully detected.

## Step 4 — Host and play

1. SK Officer opens **/officer** on the deployed website (unlisted staff entry point) and signs in using the approved account. The public homepage does not show the officer login button.
2. Click **Create new game**, add questions or use the sample SK question set, and open the lobby.
3. Share the six-digit PIN or **Copy join link**.
4. Start the Facebook Live, confirm the live gate is open, and click **Start first question**.
5. Players join on their phones using PIN + nickname and answer questions live. Scores reflect correct answers and remaining time.
6. The SK officer clicks **Next question** after each round, then **Finish event** for the final scoreboard.

**Rehearsal mode** can be switched on by an SK officer for testing without Facebook Live. This mode is clearly labeled NOT FB LIVE, and must never be represented as a verified public broadcast.

## Technology and limitations

- Frontend: plain HTML/CSS/JavaScript; Supabase JS 2.x browser SDK; Facebook video plugin iframe.
- Backend: Supabase Authentication, PostgreSQL, RLS, secure RPCs and Realtime Postgres Changes.
- Serverless: Vercel Functions for public config and authorized Facebook Live checks.
- Player login uses Supabase Anonymous Sign-ins (enable it in Auth settings).
- SK officer accounts are **separate from SKVASRA portal credentials**. Single sign-on is not yet implemented.
- Facebook may refuse embedding of restricted/private videos, and Meta may require additional app permissions.
- Round progression is **host-controlled**; questions automatically close on their server-side deadline.
- Real livestreams can be delayed relative to gameplay. Players should answer using the actual quiz UI, not only the Facebook video.
- For very large crowds, move from Postgres Changes to Supabase Realtime Broadcast for scalability.
- If prizes have real value, add stronger identity checks, abuse controls and audit logs.

## Local development

Run the project with **Vercel CLI / vercel dev** and the same environment variables to support the API functions. Opening index.html by itself only shows the interface, because login and quiz require a configured backend.

Never commit passwords, Meta tokens, Supabase secret keys or your CRON_SECRET. The sample values in **.env.example** are placeholders only.

**Arangkada, Kabataang VASRA!**


## Hidden/public access settings

- **Regular visitors:** The SK Officer Login control is hidden from the public website. Off-air visitors see an OFF AIR banner; the game PIN and nickname form is hidden until the official Facebook Live is confirmed. An exact invitation link containing a game PIN can reveal the join form for rehearsals, but the backend still enforces its live/test-mode gate.
- **Authorized SK Officers:** Sign in at **https://YOUR-DEPLOYED-DOMAIN/officer**. The `/officer` page is deliberately not linked from the public navigation; an authorized account from `sk_hosts` is still required, since a hidden URL is *not* a security mechanism.
- **GitHub repository privacy:** To hide source code from other people, change repository visibility at GitHub → **Settings** → **General** → **Danger Zone** → **Change repository visibility** → **Make private**. This action is not controlled by the website's UI settings. Confirm Vercel's GitHub permissions still allow it to deploy from a private repository.
- **Public website visibility:** Hiding buttons does not make the deployed domain itself private. Full website access restriction would require an additional server-side authentication gate.

