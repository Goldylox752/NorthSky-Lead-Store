import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const config = {
  api: {
    bodyParser: false,
  },
};

/* =========================
   STRIPE WEBHOOK ENTRY
========================= */
export default async function handler(req, res) {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    const rawBody = await buffer(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send("Webhook Error");
  }

  /* =========================
     CHECKOUT SUCCESS
  ========================= */
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const email = session.customer_details?.email;
    const customerId = session.customer;
    const plan = session.metadata?.plan || "starter";

    console.log("💰 PAYMENT SUCCESS:", { email, plan });

    try {
      // 1. UPSERT USER
      await supabase.from("users").upsert({
        email,
        paid: true,
        plan,
        stripe_customer: customerId,
        updated_at: new Date().toISOString(),
      });

      // 2. CREATE / UPDATE ORGANIZATION
      const { data: org } = await supabase
        .from("organizations")
        .upsert({
          owner_email: email,
          plan,
          status: "active",
        })
        .select()
        .single();

      // 3. INIT OS SETTINGS (PLAN → QUEUE BEHAVIOR)
      await supabase.from("org_settings").upsert({
        org_id: org.id,
        plan,
        lead_routing: getRouting(plan),
        max_agents: getMaxAgents(plan),
        priority_level: getPriority(plan),
        updated_at: new Date().toISOString(),
      });

      // 4. SEED DEFAULT AGENTS (OPTIONAL)
      if (plan !== "starter") {
        await supabase.from("agents").insert([
          {
            org_id: org.id,
            name: "Auto Agent",
            status: "online",
            capacity: getCapacity(plan),
            active_leads: 0,
          },
        ]);
      }

      // 5. OS EVENT LOG
      await supabase.from("events").insert({
        type: "user_upgraded",
        org_id: org.id,
        payload: {
          email,
          plan,
        },
      });

      console.log("✅ OS PROVISIONED:", email);
    } catch (err) {
      console.error("DB ERROR:", err);
    }
  }

  return res.json({ received: true });
}

/* =========================
   PLAN ENGINE (OS BRAIN)
========================= */
function getRouting(plan) {
  switch (plan) {
    case "elite":
      return "ai_priority";
    case "pro":
      return "weighted";
    default:
      return "round_robin";
  }
}

function getMaxAgents(plan) {
  switch (plan) {
    case "elite":
      return 20;
    case "pro":
      return 5;
    default:
      return 1;
  }
}

function getPriority(plan) {
  switch (plan) {
    case "elite":
      return 1;
    case "pro":
      return 2;
    default:
      return 3;
  }
}

function getCapacity(plan) {
  switch (plan) {
    case "elite":
      return 50;
    case "pro":
      return 15;
    default:
      return 5;
  }
}

/* =========================
   BUFFER HELPER
========================= */
async function buffer(readable) {
  const chunks = [];

  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}