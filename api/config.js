// Public configuration endpoint. Only the publishable key is safe to expose.
// The SUPABASE_SECRET_KEY and FACEBOOK_PAGE_ACCESS_TOKEN must NEVER appear here.
module.exports = function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || ""
  });
};