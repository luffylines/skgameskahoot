import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.90.1/+esm";

const $ = (id) => document.getElementById(id);
const escapeHTML = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let db = null;
let account = null;
let isHost = false;
let hostGames = [];
let activeGame = null;
let questions = [];
let hostChannel = null;
let playerChannel = null;
let joinedPin = "";
let joinedGameId = "";
let playerRound = null;
let roundRenderedKey = "";
let playerFeedback = "";
let ticking = null;
let busy = false;

function notice(message, error = false) {
  const node = $("hostMessage");
  node.textContent = message;
  node.classList.toggle("error", error);
}
function setJoinError(message) { $("joinError").textContent = message || ""; }
function shortStatus(game) {
  if (game.test_mode) return "REHEARSAL";
  if (game.facebook_live) return "FB LIVE";
  return "OFF AIR";
}
function allowed(game) { return Boolean(game && (game.facebook_live || game.test_mode)); }
function validFacebookURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && (u.hostname === "facebook.com" || u.hostname === "www.facebook.com" || u.hostname === "m.facebook.com" || u.hostname === "web.facebook.com" || u.hostname === "fb.watch");
  } catch { return false; }
}
function setVideo(url) {
  const frame = $("videoFrame");
  const live = Boolean(url && validFacebookURL(url));
  if (!live) {
    frame.innerHTML = '<div class="video-art"><span class="orb one"></span><span class="orb two"></span><div class="video-art-text"><div class="video-play">▶</div><b>SK VASRA</b><strong>LIVE TRIVIA</strong><small>THE GAME STARTS WHEN WE GO LIVE</small></div><div class="video-lines"></div></div>';
    $("facebookLink").href = "https://www.facebook.com/skbrgyvasra";
    return;
  }
  const iframe = "https://www.facebook.com/plugins/video.php?href=" + encodeURIComponent(url) + "&show_text=false&width=780";
  frame.innerHTML = '<iframe title="SK Vasra Facebook Live video" src="' + escapeHTML(iframe) + '" loading="lazy" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share" allowfullscreen></iframe>';
  $("facebookLink").href = url;
}
function showLive(game) {
  const active = Boolean(game);
  $("liveBadge").className = "live-badge " + (active ? "online" : "offline");
  $("liveBadge").innerHTML = '<span class="status-dot"></span> ' + (active ? "LIVE NOW" : "OFF AIR");
  $("liveTitle").textContent = active ? game.title : "Waiting for the next live event";
  $("liveDescription").textContent = active ? "Official SK Vasra Facebook Live · Join the real-time quiz!" : "Follow the official SK Vasra Facebook Page for announcements.";
  $("stageStatus").textContent = active ? "Broadcast is live" : "Live-event access";
  $("stagePin").textContent = active ? "GAME PIN  " + game.pin : "Community-first gaming";
  setVideo(active ? (game.verified_video_url || game.fb_video_url) : "");
}
async function refreshLive() {
  if (!db) { showLive(null); return; }
  const { data, error } = await db.from("games").select("id,pin,title,status,facebook_live,verified_video_url,fb_video_url").eq("facebook_live", true).in("status", ["lobby", "live"]).order("created_at", { ascending: false }).limit(1);
  if (!error) showLive(data && data[0] ? data[0] : null);
}
function startTimer() {
  if (ticking) window.clearInterval(ticking);
  ticking = window.setInterval(() => {
    if (!playerRound || !playerRound.ends_at || playerRound.status !== "live") { $("countdown").textContent = "—"; return; }
    const seconds = Math.max(0, Math.ceil((new Date(playerRound.ends_at).getTime() - Date.now()) / 1000));
    $("countdown").textContent = seconds + "s";
    if (seconds === 0 && playerRound.question && !playerRound.round_over) refreshPlayer();
  }, 450);
}
async function ensureUser() {
  const { data: current } = await db.auth.getUser();
  if (current.user) return current.user;
  const { data, error } = await db.auth.signInAnonymously();
  if (error) throw new Error("Guest access is unavailable. Enable Anonymous Sign-ins in Supabase Auth. " + error.message);
  return data.user;
}
async function joinGame(event) {
  if (event) event.preventDefault();
  if (!db) { setJoinError("Game server is not configured yet. Please ask the SK administrator."); return; }
  const pin = $("pinInput").value.replace(/\s+/g, "").trim();
  const nickname = $("nicknameInput").value.trim();
  if (!/^[0-9]{6}$/.test(pin)) { setJoinError("Enter a valid six-digit Game PIN."); return; }
  if (nickname.length < 2 || nickname.length > 28) { setJoinError("Nickname must have 2–28 characters."); return; }
  if (busy) return;
  busy = true; setJoinError("");
  const button = $("joinForm").querySelector("button[type=submit]");
  button.disabled = true; button.textContent = "Joining…";
  try {
    await ensureUser();
    const { data, error } = await db.rpc("join_game", { p_pin: pin, p_nickname: nickname });
    if (error) throw error;
    joinedPin = pin;
    joinedGameId = data.game_id;
    roundRenderedKey = "";
    playerFeedback = "";
    localStorage.setItem("skvasra_live_player", JSON.stringify({ pin, nickname }));
    $("gameSection").hidden = false;
    await subscribeGame();
    await refreshPlayer();
    $("gameSection").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) { setJoinError(err.message || "Unable to join this event."); }
  finally { busy = false; button.disabled = false; button.innerHTML = "Join Game <span aria-hidden='true'>→</span>"; }
}
async function subscribeGame() {
  if (playerChannel) await db.removeChannel(playerChannel);
  playerChannel = db.channel("game-player-" + joinedGameId)
    .on("postgres_changes", { event: "*", schema: "public", table: "games", filter: "id=eq." + joinedGameId }, () => refreshPlayer())
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: "game_id=eq." + joinedGameId }, () => refreshLeaderboard())
    .subscribe();
}
async function refreshPlayer() {
  if (!db || !joinedPin) return;
  const { data, error } = await db.rpc("public_round", { p_pin: joinedPin });
  if (error) { $("gameSubtitle").textContent = error.message; return; }
  if (!data) return;
  playerRound = data;
  $("gameModeBadge").textContent = data.test_mode ? "REHEARSAL • NOT FB LIVE" : (data.facebook_live ? "FACEBOOK LIVE" : "OFF AIR");
  $("gameModeBadge").className = "tag " + (data.test_mode ? "test" : data.facebook_live ? "live" : "");
  $("gameRound").textContent = data.current_question ? ("QUESTION " + data.current_question + " / " + data.total_questions) : "WAITING ROOM";
  if (!data.allowed && data.status !== "ended") {
    $("gameTitle").textContent = "Waiting for Facebook Live";
    $("gameSubtitle").textContent = "SK Vasra has not started its official live event. Please check again when the broadcast begins.";
    $("answersGrid").innerHTML = "";
    $("answerFeedback").textContent = "";
    $("countdown").textContent = "—";
  } else if (data.status === "lobby" || data.status === "draft") {
    $("gameTitle").textContent = "You're in the lobby!";
    $("gameSubtitle").textContent = "The SK host is getting everything ready. Stay here for the first question.";
    $("answersGrid").innerHTML = "";
    $("answerFeedback").textContent = "";
  } else if (data.status === "ended") {
    $("gameTitle").textContent = "That's a wrap! 🏆";
    $("gameSubtitle").textContent = "Thanks for joining SKVASRA Live Games. See the final standings!";
    $("answersGrid").innerHTML = "";
    $("answerFeedback").textContent = "GG, Kabataang Vasra!";
  } else if (data.question) {
    const q = data.question;
    $("gameTitle").textContent = q.prompt;
    $("gameSubtitle").textContent = data.round_over ? "Round complete! See how you did below." : "Choose your answer before time runs out.";
    const key = String(q.id) + "-" + data.round_over + "-" + String(data.your_answer);
    if (key !== roundRenderedKey) {
      roundRenderedKey = key;
      $("answersGrid").innerHTML = q.options.map((option, i) => {
        const selected = data.your_answer === i;
        const disabled = data.round_over || data.your_answer !== null;
        return '<button type="button" class="answer-btn ' + (selected ? "selected" : "") + '" data-choice="' + i + '" ' + (disabled ? "disabled" : "") + '><b>' + ["▲","◆","●","■"][i] + '</b><span>' + escapeHTML(option) + "</span></button>";
      }).join("");
      $("answersGrid").querySelectorAll("button[data-choice]").forEach((button) => {
        button.addEventListener("click", () => submitAnswer(Number(button.dataset.choice)));
      });
    }
    if (data.round_over) {
      const correct = q.options[data.correct_index];
      $("answerFeedback").textContent = "✓ Correct answer: " + correct + (data.your_answer === null ? " · Time is up!" : data.your_answer === data.correct_index ? " · You got it!" : " · Better luck next round!");
    } else $("answerFeedback").textContent = data.your_answer !== null ? (playerFeedback || "Answer submitted! Await the results.") : "";
  }
  startTimer();
  await refreshLeaderboard();
}
async function submitAnswer(choice) {
  if (!db || !joinedPin || !playerRound || playerRound.round_over) return;
  const buttons = $("answersGrid").querySelectorAll("button");
  buttons.forEach((b) => { b.disabled = true; });
  const { data, error } = await db.rpc("submit_answer", { p_pin: joinedPin, p_choice: choice });
  if (error) playerFeedback = error.message;
  else playerFeedback = data.correct ? "✓ Correct! +" + data.points + " points" : "Answer submitted! Keep going.";
  await refreshPlayer();
}
async function refreshLeaderboard() {
  if (!db || !joinedGameId || !playerRound || (!playerRound.allowed && playerRound.status !== "ended")) return;
  const { data, error } = await db.from("players").select("nickname,score").eq("game_id", joinedGameId).order("score", { ascending: false }).limit(10);
  if (error) return;
  $("leaderboardList").innerHTML = data && data.length ? data.map((p, i) => '<li><span>' + (["🥇","🥈","🥉"][i] || "#" + (i + 1)) + " " + escapeHTML(p.nickname) + "</span><b>" + Number(p.score || 0).toLocaleString() + " pts</b></li>").join("") : "<li>Waiting for players…</li>";
  const podium = $("podium");
  if (playerRound.status === "ended" && data && data.length) {
    podium.hidden = false;
    podium.innerHTML = '<h4>🏆 THE PODIUM</h4><div class="podium-places">' + [1, 0, 2].map((i) => data[i] ? '<div class="podium-place p' + (i + 1) + '"><span>' + ["🥇","🥈","🥉"][i] + '</span><strong>' + escapeHTML(data[i].nickname) + '</strong><small>' + Number(data[i].score).toLocaleString() + ' pts</small></div>' : "").join("") + '</div>';
  } else podium.hidden = true;
}
async function leaveGame() {
  if (playerChannel) await db.removeChannel(playerChannel);
  playerChannel = null;
  joinedGameId = ""; joinedPin = ""; playerRound = null; roundRenderedKey = "";
  localStorage.removeItem("skvasra_live_player");
  $("gameSection").hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
}
async function checkHost() {
  if (!db) return false;
  const { data: userData } = await db.auth.getUser();
  account = userData.user;
  if (!account || account.is_anonymous) return false;
  const { data, error } = await db.from("sk_hosts").select("user_id").eq("user_id", account.id).maybeSingle();
  isHost = !error && Boolean(data);
  if (isHost) { $("hostSection").hidden = false; $("hostOpen").textContent = "SK Game Studio"; await refreshHostGames(); }
  return isHost;
}
async function loginHost(event) {
  event.preventDefault();
  if (!db) { $("loginError").textContent = "Admin login isn't configured. See the README."; return; }
  const email = $("hostEmail").value.trim(), password = $("hostPassword").value;
  $("loginError").textContent = "";
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) { $("loginError").textContent = error.message; return; }
  const authorized = await checkHost();
  if (!authorized) {
    $("loginError").textContent = "This account is not an approved SK Games host. Ask your system administrator to add it to sk_hosts.";
    await db.auth.signOut();
    return;
  }
  $("hostDialog").close();
  $("hostSection").scrollIntoView({ behavior: "smooth" });
}
async function logOut() {
  if (hostChannel) await db.removeChannel(hostChannel);
  await db.auth.signOut();
  account = null; isHost = false; activeGame = null; hostGames = [];
  $("hostSection").hidden = true;
  $("hostOpen").textContent = "SK Officer Login ↗";
  window.scrollTo({ top: 0, behavior: "smooth" });
}
async function refreshHostGames(preferredId) {
  if (!isHost || !account) return;
  const { data, error } = await db.from("games").select("*").eq("host_id", account.id).order("created_at", { ascending: false }).limit(50);
  if (error) { notice(error.message, true); return; }
  hostGames = data || [];
  $("hostGameList").innerHTML = hostGames.length ? hostGames.map((g) => '<button type="button" class="host-game-option ' + (activeGame && activeGame.id === g.id ? "active" : "") + '" data-game="' + g.id + '"><strong>' + escapeHTML(g.title) + '</strong><small>PIN ' + escapeHTML(g.pin) + " · " + escapeHTML(g.status.toUpperCase()) + " · " + shortStatus(g) + "</small></button>").join("") : '<p style="font-size:12px;color:#8390a4">No events created yet.</p>';
  $("hostGameList").querySelectorAll("[data-game]").forEach((button) => button.addEventListener("click", () => selectGame(button.dataset.game)));
  const nextId = preferredId || (activeGame && activeGame.id) || (hostGames[0] && hostGames[0].id);
  if (nextId) await selectGame(nextId);
}
async function selectGame(id) {
  const game = hostGames.find((g) => g.id === id);
  if (!game) return;
  activeGame = game;
  const { data, error } = await db.from("questions").select("id,position,prompt,options,correct_index,seconds,points").eq("game_id", game.id).order("position", { ascending: true });
  if (error) { notice(error.message, true); return; }
  questions = data || [];
  renderEditor();
  $("hostGameList").querySelectorAll("[data-game]").forEach((b) => b.classList.toggle("active", b.dataset.game === id));
  if (hostChannel) await db.removeChannel(hostChannel);
  hostChannel = db.channel("sk-host-" + game.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "games", filter: "id=eq." + game.id }, () => refreshHostGames(game.id))
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: "game_id=eq." + game.id }, () => refreshHostPlayers())
    .subscribe();
  await refreshHostPlayers();
}
function renderNewGameForm() {
  activeGame = null;
  $("editorPanel").innerHTML = '<h3>New trivia event</h3><p class="editor-notice">Create a game now, then add questions and publish the lobby before your next Facebook Live.</p><form id="createGameForm"><label class="field-label">EVENT TITLE<input name="title" maxlength="90" required placeholder="SKVASRA Youth Trivia Night"></label><label class="field-label">FACEBOOK VIDEO LINK (OPTIONAL BACKUP)<input name="video" placeholder="https://www.facebook.com/.../videos/..."></label><button type="submit" class="btn btn-primary">Create event →</button></form>';
  $("createGameForm").addEventListener("submit", createGame);
}
async function createGame(event) {
  event.preventDefault();
  if (!db || !isHost) return;
  const form = new FormData(event.currentTarget);
  const title = String(form.get("title") || "").trim();
  const video = String(form.get("video") || "").trim();
  if (video && !validFacebookURL(video)) { notice("Use an official Facebook video URL.", true); return; }
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  const pin = String(100000 + (values[0] % 900000));
  const { data, error } = await db.from("games").insert({ title, pin, host_id: account.id, fb_video_url: video || null }).select("id").single();
  if (error) { notice(error.message + " (If the PIN exists, try again.)", true); return; }
  notice("Game created. Add at least one question.");
  await refreshHostGames(data.id);
}
function renderEditor() {
  if (!activeGame) return;
  const g = activeGame;
  const editable = g.status === "draft";
  const current = questions.find((q) => q.position === g.current_question);
  const state = g.test_mode ? "REHEARSAL / TEST" : g.facebook_live ? "FACEBOOK LIVE VERIFIED" : "WAITING FOR FACEBOOK LIVE";
  const action = g.status === "draft" ? '<button data-action="lobby" class="btn btn-primary" type="button" ' + (!questions.length ? "disabled" : "") + '>Open lobby →</button>' :
    g.status === "lobby" ? '<button data-action="next" class="btn btn-primary" type="button" ' + (!allowed(g) ? "disabled" : "") + '>Start first question ▶</button>' :
    g.status === "live" ? '<button data-action="next" class="btn btn-primary" type="button" ' + (!allowed(g) ? "disabled" : "") + '>' + (g.current_question >= questions.length ? "Finish event 🏆" : "Next question →") + '</button><button data-action="end" class="btn btn-quiet" type="button">End event</button>' : '<span class="tag">Event completed</span>';
  const qrows = questions.map((q) => '<li><strong>Q' + q.position + '. ' + escapeHTML(q.prompt) + '</strong><small>Correct: ' + escapeHTML(q.options[q.correct_index]) + " · " + q.seconds + " seconds · " + q.points + " points</small></li>").join("");
  $("editorPanel").innerHTML =
    '<div class="editor-header"><div><div class="section-caption">EVENT CONTROL ROOM</div><h3>' + escapeHTML(g.title) + '</h3><small>Game PIN: <strong style="font-size:18px;color:#142b91;letter-spacing:3px">' + escapeHTML(g.pin) + '</strong></small></div><span class="tag ' + (g.test_mode ? "test" : g.facebook_live ? "live" : "") + '">' + escapeHTML(state) + '</span></div>' +
    '<div class="status-line"><span class="tag">Status: ' + escapeHTML(g.status.toUpperCase()) + '</span><span class="tag">Round ' + g.current_question + "/" + questions.length + '</span><span class="tag">Question: ' + (current ? escapeHTML(current.prompt.slice(0, 30)) : "Not started") + '</span></div>' +
    '<div class="editor-actions">' + action + (g.status !== "ended" ? '<button data-action="test" class="btn btn-outline" type="button">' + (g.test_mode ? "Disable rehearsal mode" : "Enable rehearsal mode") + '</button>' : "") + '<button data-action="copy" class="btn btn-outline" type="button">Copy join link</button></div>' +
    '<div class="editor-notice">' + (g.test_mode ? "⚠ REHEARSAL MODE: This allows testing without Facebook Live. It does not mean your Facebook Page is broadcasting." : g.facebook_live ? "● Official Facebook Live confirmed by the server. Players may join the event." : "○ Public gameplay stays locked until the configured official Facebook Page is broadcasting. Use Check Facebook Live to refresh.") + '</div>' +
    '<form id="settingsForm"><h4>Game information</h4><div class="form-two"><label>EVENT TITLE<input name="title" value="' + escapeHTML(g.title) + '" maxlength="90" required></label><label>FACEBOOK VIDEO URL (FALLBACK)<input name="video" value="' + escapeHTML(g.fb_video_url || "") + '" placeholder="https://www.facebook.com/..."></label></div><button class="btn btn-outline" style="margin-top:11px" type="submit">Save game details</button></form>' +
    '<h4>Questions (' + questions.length + ')</h4><ol class="question-list">' + (qrows || "<li>No questions yet. Add your first below!</li>") + "</ol>" +
    (editable ? '<form id="questionForm" class="question-form"><h4>Add a question</h4><label>QUESTION<input name="prompt" maxlength="220" required placeholder="Which barangay are we celebrating today?"></label><div class="options-editor"><label>▲ ANSWER A<input name="a" maxlength="120" required placeholder="Option A"></label><label>◆ ANSWER B<input name="b" maxlength="120" required placeholder="Option B"></label><label>● ANSWER C<input name="c" maxlength="120" required placeholder="Option C"></label><label>■ ANSWER D<input name="d" maxlength="120" required placeholder="Option D"></label></div><div class="form-two"><label>CORRECT ANSWER<select name="correct"><option value="0">A</option><option value="1">B</option><option value="2">C</option><option value="3">D</option></select></label><label>TIME LIMIT<select name="seconds"><option value="10">10 seconds</option><option value="15">15 seconds</option><option value="20" selected>20 seconds</option><option value="30">30 seconds</option><option value="45">45 seconds</option></select></label></div><button class="btn btn-primary" style="margin-top:12px" type="submit">+ Save question</button><button class="btn btn-quiet" id="sampleQuestions" type="button" style="margin-top:12px;margin-left:7px">Add sample SK questions</button></form>' : '<p class="editor-notice">Questions are locked after opening the lobby to keep the competition fair.</p>') +
    '<h4>Community leaderboard</h4><ol id="hostLeaderboard" class="leaderboard-list"><li>No players yet.</li></ol>';
  $("editorPanel").querySelectorAll("[data-action]").forEach((b) => b.addEventListener("click", () => hostAction(b.dataset.action)));
  $("settingsForm").addEventListener("submit", saveSettings);
  if (editable) {
    $("questionForm").addEventListener("submit", saveQuestion);
    $("sampleQuestions").addEventListener("click", addSampleQuestions);
  }
}
async function saveSettings(event) {
  event.preventDefault();
  if (!activeGame) return;
  const form = new FormData(event.currentTarget), title = String(form.get("title") || "").trim(), url = String(form.get("video") || "").trim();
  if (url && !validFacebookURL(url)) { notice("Use a valid Facebook URL.", true); return; }
  const { error } = await db.from("games").update({ title, fb_video_url: url || null }).eq("id", activeGame.id);
  notice(error ? error.message : "Game details updated.", Boolean(error));
  if (!error) await refreshHostGames(activeGame.id);
}
async function saveQuestion(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const options = ["a","b","c","d"].map((k) => String(form.get(k) || "").trim());
  const prompt = String(form.get("prompt") || "").trim();
  const { error } = await db.from("questions").insert({ game_id: activeGame.id, position: questions.length + 1, prompt, options, correct_index: Number(form.get("correct")), seconds: Number(form.get("seconds")), points: 1000 });
  notice(error ? error.message : "Question saved.", Boolean(error));
  if (!error) await refreshHostGames(activeGame.id);
}
async function addSampleQuestions() {
  if (!activeGame || activeGame.status !== "draft") return;
  const samples = [
    ["What does SK stand for?", ["Sangguniang Kabataan","Samahan ng Kapitbahay","Senior Kabataan","Sektor ng Kalakalan"], 0],
    ["Which city is Barangay Vasra in?", ["Caloocan","Quezon City","Manila","Pasig"], 1],
    ["What is the main purpose of the SK?", ["Youth participation","Selling tickets","Private business","Sports only"], 0],
    ["What should you do during an emergency?", ["Stay informed and follow officials","Spread rumors","Ignore advisories","Block exits"], 0],
    ["Which value helps a community grow?", ["Cooperation","Dishonesty","Exclusion","Disrespect"], 0]
  ];
  const rows = samples.map((s, i) => ({ game_id: activeGame.id, position: questions.length + i + 1, prompt: s[0], options: s[1], correct_index: s[2], seconds: 20, points: 1000 }));
  const { error } = await db.from("questions").insert(rows);
  notice(error ? error.message : "Sample questions added! Review them before publishing.", Boolean(error));
  if (!error) await refreshHostGames(activeGame.id);
}
async function hostAction(action) {
  if (!activeGame) return;
  if (action === "copy") {
    const link = location.origin + "/?pin=" + encodeURIComponent(activeGame.pin);
    try { await navigator.clipboard.writeText(link); notice("Join link copied: " + link); }
    catch { notice("Share this link: " + link); }
    return;
  }
  if (action === "test") {
    const { error } = await db.from("games").update({ test_mode: !activeGame.test_mode }).eq("id", activeGame.id);
    notice(error ? error.message : (activeGame.test_mode ? "Rehearsal mode turned off." : "Rehearsal mode turned on."), Boolean(error));
  } else if (action === "lobby") {
    if (!questions.length) { notice("Add a question first.", true); return; }
    const { error } = await db.from("games").update({ status: "lobby" }).eq("id", activeGame.id);
    notice(error ? error.message : "Lobby published. Participants can join when the live gate is open.", Boolean(error));
  } else if (action === "next") {
    const { error } = await db.rpc("host_next_question", { p_game_id: activeGame.id });
    notice(error ? error.message : "Round updated.", Boolean(error));
  } else if (action === "end") {
    if (!confirm("End this event and finalize the scoreboard?")) return;
    const { error } = await db.from("games").update({ status: "ended" }).eq("id", activeGame.id);
    notice(error ? error.message : "Event finished.", Boolean(error));
  }
  await refreshHostGames(activeGame.id);
}
async function refreshHostPlayers() {
  if (!activeGame || !db) return;
  const node = $("hostLeaderboard");
  if (!node) return;
  const { data, error } = await db.from("players").select("nickname,score").eq("game_id", activeGame.id).order("score", { ascending: false }).limit(30);
  if (error) return;
  node.innerHTML = data && data.length ? data.map((p, i) => "<li><span>" + (i + 1) + ". " + escapeHTML(p.nickname) + "</span><b>" + Number(p.score).toLocaleString() + " pts</b></li>").join("") : "<li>No participants yet.</li>";
}
async function synchronizeLive() {
  if (!db) return;
  notice("Checking the official Facebook Page…");
  const { data: sessionData } = await db.auth.getSession();
  const token = sessionData.session && sessionData.session.access_token;
  if (!token) { notice("Please log in as an SK officer.", true); return; }
  try {
    const response = await fetch("/api/sync-live", { method: "POST", headers: { "Authorization": "Bearer " + token } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Live detection failed");
    notice(result.live ? "Facebook Live confirmed! Community access is now active." : "The official SK Page is currently not live.");
    await refreshLive();
    await refreshHostGames(activeGame && activeGame.id);
  } catch (error) { notice(error.message, true); }
}
async function boot() {
  $("year").textContent = new Date().getFullYear();
  const initialTheme = localStorage.getItem("skvasra_live_theme") || "light";
  document.documentElement.setAttribute("data-theme", initialTheme);
  $("themeToggle").textContent = initialTheme === "dark" ? "☀" : "☾";
  $("themeToggle").setAttribute("aria-pressed", String(initialTheme === "dark"));
  $("themeToggle").addEventListener("click", () => {
    const dark = document.documentElement.getAttribute("data-theme") !== "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    $("themeToggle").textContent = dark ? "☀" : "☾";
    $("themeToggle").setAttribute("aria-pressed", String(dark));
    localStorage.setItem("skvasra_live_theme", dark ? "dark" : "light");
  });
  $("hostOpen").addEventListener("click", async () => {
    if (isHost) $("hostSection").scrollIntoView({ behavior: "smooth" });
    else $("hostDialog").showModal();
  });
  $("loginForm").addEventListener("submit", loginHost);
  $("joinForm").addEventListener("submit", joinGame);
  $("leaveGame").addEventListener("click", leaveGame);
  $("newGame").addEventListener("click", renderNewGameForm);
  $("signOut").addEventListener("click", logOut);
  $("syncLive").addEventListener("click", synchronizeLive);
  const pinInLink = new URLSearchParams(location.search).get("pin");
  if (pinInLink && /^[0-9]{6}$/.test(pinInLink)) $("pinInput").value = pinInLink;
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Missing public configuration");
    const config = await response.json();
    if (!config.supabaseUrl || !config.supabaseKey) throw new Error("Supabase URL and publishable key not set.");
    db = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    await checkHost();
    await refreshLive();
    const saved = localStorage.getItem("skvasra_live_player");
    if (saved && !isHost) {
      try { const p = JSON.parse(saved); if (p.pin && p.nickname) { $("pinInput").value = p.pin; $("nicknameInput").value = p.nickname; await joinGame(); } }
      catch { localStorage.removeItem("skvasra_live_player"); }
    }
    window.setInterval(() => {
      refreshLive();
      if (joinedPin) refreshPlayer();
      if (activeGame && isHost) refreshHostPlayers();
    }, 6000);
  } catch (error) {
    const banner = $("setupNotice");
    banner.hidden = false;
    banner.textContent = "Admin setup needed: Supabase is not connected yet. The SK team must configure the environment and run database/schema.sql before live games can be played.";
  }
}
boot();