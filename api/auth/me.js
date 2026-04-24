import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const userId = req.headers["x-user-id"];

  if (!userId) {
    return res.json({ access: false });
  }

  const { data } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (!data) {
    return res.json({ access: false });
  }

  // MODULE PERMISSIONS
  const permissions = {
    basic: ["tools"],
    pro: ["tools", "leads", "roof_flow"],
    enterprise: ["tools", "leads", "roof_flow", "marketplace", "admin"]
  };

  return res.json({
    access: true,
    plan: data.plan,
    modules: permissions[data.plan] || []
  });
}