import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: { bodyParser: false }
};

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
    return res.status(400).send("Webhook Error");
  }

  // 💳 PAYMENT SUCCESS
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    await supabase.from("subscriptions").upsert({
      user_id: session.metadata.user_id,
      stripe_customer_id: session.customer,
      plan: session.metadata.plan,
      status: "active",
      updated_at: new Date()
    });
  }

  // 🔄 RENEWALS
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;

    await supabase
      .from("subscriptions")
      .update({ status: "active" })
      .eq("stripe_customer_id", invoice.customer);
  }

  // ❌ CANCEL
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object;

    await supabase
      .from("subscriptions")
      .update({ status: "canceled" })
      .eq("stripe_customer_id", sub.customer);
  }

  res.json({ received: true });
}

async function buffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}