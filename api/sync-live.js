// Server-only Meta Page Live checker for SKVASRA Live Games.
// GET: authorized Vercel cron / external scheduler using CRON_SECRET.
// POST: signed-in, allowlisted SK host using their Supabase access JWT.
const httpsURL = (path) => process.env.SUPABASE_URL.replace(/\/$/, "") + path;
function out(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}
async function checkedJSON(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || "Remote API returned HTTP " + response.status);
  return data;
}
async function isAuthorizedHost(req) {
  const bearer = String(req.headers.authorization || "");
  if (!bearer.startsWith("Bearer ")) return false;
  const jwt = bearer.slice(7).trim();
  const user = await checkedJSON(httpsURL("/auth/v1/user"), {
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: "Bearer " + jwt }
  });
  if (!user.id) return false;
  const hosts = await checkedJSON(httpsURL("/rest/v1/sk_hosts?user_id=eq." + encodeURIComponent(user.id) + "&select=user_id&limit=1"), {
    headers: { apikey: process.env.SUPABASE_SECRET_KEY }
  });
  return Array.isArray(hosts) && hosts.length === 1;
}
async function syncFB() {
  // Graph version can be upgraded using an environment variable.
  const version = process.env.FACEBOOK_GRAPH_VERSION || "v24.0";
  if (!/^v[0-9]+\.[0-9]+$/.test(version)) throw new Error("Invalid FACEBOOK_GRAPH_VERSION.");
  const page = process.env.FACEBOOK_PAGE_ID;
  const url = new URL("https://graph.facebook.com/" + version + "/" + encodeURIComponent(page) + "/live_videos");
  url.searchParams.set("fields", "id,status,permalink_url,title");
  url.searchParams.set("limit", "20");
  url.searchParams.set("access_token", process.env.FACEBOOK_PAGE_ACCESS_TOKEN);
  const result = await checkedJSON(url.toString());
  const videos = Array.isArray(result.data) ? result.data : [];
  const current = videos.find((video) => ["LIVE", "LIVE_NOW"].includes(String(video.status || "").toUpperCase()));
  const videoURL = current ? (current.permalink_url || ("https://www.facebook.com/" + encodeURIComponent(page) + "/videos/" + encodeURIComponent(current.id))) : null;
  const live = Boolean(current);
  const timestamp = new Date().toISOString();
  // Only affect published, unfinished events. Draft and completed games are untouched.
  await checkedJSON(httpsURL("/rest/v1/games?status=in.(lobby,live)"), {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    },
    body: JSON.stringify({ facebook_live: live, verified_video_url: videoURL, live_checked_at: timestamp })
  });
  return { live, url: videoURL, checked_at: timestamp };
}
module.exports = async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return out(res, 405, { error: "Method not allowed." });
  const required = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) return out(res, 503, { error: "Missing server settings: " + missing.join(", ") });
  try {
    const cronOK = req.method === "GET" && process.env.CRON_SECRET &&
      req.headers.authorization === "Bearer " + process.env.CRON_SECRET;
    const hostOK = req.method === "POST" ? await isAuthorizedHost(req).catch(() => false) : false;
    if (!cronOK && !hostOK) return out(res, 403, { error: "Authorized SK host or cron access required." });
    const result = await syncFB();
    return out(res, 200, result);
  } catch (error) {
    // Do not expose Meta Page tokens, backend URLs or full upstream error payloads.
    console.error("SKVASRA Live sync failed:", error.message);
    return out(res, 502, { error: "Facebook Live check failed. Check Meta Page access permissions and server logs." });
  }
};