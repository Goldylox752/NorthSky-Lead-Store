import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  const { plan, userId } = req.body;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [
      {
        price: process.env[`STRIPE_PRICE_${plan.toUpperCase()}`],
        quantity: 1
      }
    ],
    metadata: {
      user_id: userId,
      plan
    },
    success_url: `${process.env.DOMAIN}/dashboard?success=1`,
    cancel_url: `${process.env.DOMAIN}/pricing`
  });

  res.json({ url: session.url });
}