import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables (create a .env file with STRIPE_SECRET_KEY)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) console.warn("⚠️ STRIPE_SECRET_KEY not set. Stripe payments will fail.");
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const app = express();
// For Stripe webhook, we need raw body before express.json()
app.post("/webhook", express.raw({ type: "application/json" }), handleStripeWebhook);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---------- In‑Memory Data Stores ----------
const leads = [];        // { id, name, contact, postalCode, service, city, status, createdAt, highestBid, winner, forSale, salePrice, soldTo, soldAt }
const bids = [];         // { id, leadId, contractorId, amount, timestamp }
const contractors = new Map(); // socketId -> { id, city, status, lastSeen }
const auctions = new Map(); // leadId -> { city, status, highestBid, winner, bids, expiresAt }

// Helper: update lead record with latest auction data
function updateLeadFromAuction(leadId) {
  const auction = auctions.get(leadId);
  if (!auction) return;
  const lead = leads.find(l => l.id === leadId);
  if (lead) {
    lead.status = auction.status === "live" ? "active" : "closed";
    lead.highestBid = auction.highestBid;
    lead.winner = auction.winner;
  }
}

function startAuction(leadId, city) {
  const durationMs = 60 * 1000;
  auctions.set(leadId, {
    city,
    status: "live",
    highestBid: 0,
    winner: null,
    bids: [],
    expiresAt: Date.now() + durationMs,
  });
  const lead = leads.find(l => l.id === leadId);
  if (lead) lead.status = "active";
  io.to(city).emit("auction_started", { leadId, expiresAt: Date.now() + durationMs });
  setTimeout(() => closeAuction(leadId), durationMs);
}

function closeAuction(leadId) {
  const auction = auctions.get(leadId);
  if (!auction || auction.status !== "live") return;
  auction.status = "closed";
  updateLeadFromAuction(leadId);
  io.to(auction.city).emit("auction_closed", {
    leadId,
    winnerId: auction.winner || "none",
    price: auction.highestBid,
  });
  setTimeout(() => auctions.delete(leadId), 60000);
}

// ---------- Lead Purchase Helper (used by both API and webhook) ----------
function purchaseLead(leadId, contractorId) {
  const lead = leads.find(l => l.id === leadId);
  if (!lead) throw new Error("Lead not found");
  if (!lead.forSale) throw new Error("Lead not available for sale");
  if (lead.soldTo) throw new Error("Lead already sold");
  lead.soldTo = contractorId;
  lead.soldAt = new Date().toISOString();
  lead.forSale = false;
  // If there's an active auction for this lead, close it
  if (auctions.has(lead.id)) closeAuction(lead.id);
  return lead;
}

// ---------- Stripe Webhook ----------
async function handleStripeWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    // Use your Stripe webhook secret (set in .env)
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) throw new Error("Missing webhook secret");
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const leadId = session.client_reference_id;
    const contractorId = session.metadata.contractorId;
    if (leadId && contractorId) {
      try {
        const purchasedLead = purchaseLead(leadId, contractorId);
        console.log(`Lead ${leadId} sold to ${contractorId} via Stripe.`);
        // Optionally send email to contractor with lead details
      } catch (err) {
        console.error(`Failed to complete lead purchase after payment: ${err.message}`);
      }
    }
  }
  res.json({ received: true });
}

// ---------- REST Endpoints ----------
// Get all leads (admin)
app.get("/api/leads", (req, res) => {
  res.json(leads);
});

// Get leads that are for sale (public for contractors)
app.get("/api/leads/for-sale", (req, res) => {
  const forSaleLeads = leads.filter(l => l.forSale === true && !l.soldTo);
  res.json(forSaleLeads);
});

// Get all bids
app.get("/api/bids", (req, res) => {
  res.json(bids);
});

// Get online contractors
app.get("/api/contractors", (req, res) => {
  const online = Array.from(contractors.values()).filter(c => c.status === "online");
  res.json(online);
});

// Create a new lead (also starts auction)
app.post("/api/leads", (req, res) => {
  const { name, contact, postalCode, service = "roof inspection", city = "unknown" } = req.body;
  if (!name || !contact || !postalCode) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }
  const leadId = uuidv4();
  const newLead = {
    id: leadId,
    name,
    contact,
    postalCode,
    service,
    city,
    status: "active",
    createdAt: new Date().toISOString(),
    highestBid: 0,
    winner: null,
    forSale: false,
    salePrice: null,
    soldTo: null,
    soldAt: null,
  };
  leads.unshift(newLead);
  startAuction(leadId, city);
  res.json({ success: true, leadId });
});

// Mark a lead as for sale (admin)
app.post("/api/leads/:id/set-for-sale", (req, res) => {
  const { id } = req.params;
  const { forSale, price } = req.body;
  const lead = leads.find(l => l.id === id);
  if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });
  if (forSale === true) {
    if (!price || price <= 0) return res.status(400).json({ success: false, error: "Valid price required" });
    lead.forSale = true;
    lead.salePrice = price;
  } else {
    lead.forSale = false;
    lead.salePrice = null;
  }
  res.json({ success: true, lead });
});

// Purchase a lead via API (for mock/testing, or fallback)
app.post("/api/leads/:id/purchase", (req, res) => {
  const { id } = req.params;
  const { contractorId } = req.body;
  if (!contractorId) return res.status(400).json({ success: false, error: "Contractor ID required" });
  try {
    const lead = purchaseLead(id, contractorId);
    res.json({
      success: true,
      lead: {
        id: lead.id,
        name: lead.name,
        contact: lead.contact,
        service: lead.service,
        postalCode: lead.postalCode,
        price: lead.salePrice,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Create Stripe Checkout Session (for lead purchase)
app.post("/create-checkout-session", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe not configured" });
  const { leadId, price, contractorId, contractorEmail, leadName } = req.body;
  // Validate lead exists and is still for sale
  const lead = leads.find(l => l.id === leadId);
  if (!lead || !lead.forSale || lead.soldTo) {
    return res.status(400).json({ error: "Lead not available for purchase" });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `Roofing Lead: ${leadName}` },
          unit_amount: Math.round(price * 100),
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: `${req.headers.origin}/?success=true&leadId=${leadId}`,
      cancel_url: `${req.headers.origin}/?canceled=true`,
      client_reference_id: leadId,
      metadata: { contractorId, leadId },
      customer_email: contractorEmail,
    });
    res.json({ id: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Force close an auction (admin)
app.post("/api/auctions/close/:leadId", (req, res) => {
  const { leadId } = req.params;
  const auction = auctions.get(leadId);
  if (!auction) return res.status(404).json({ success: false, error: "Auction not found" });
  if (auction.status !== "live") return res.status(400).json({ success: false, error: "Auction already closed" });
  closeAuction(leadId);
  res.json({ success: true, message: "Auction force closed" });
});

// Legacy endpoint for contractor dashboard (compatibility)
app.post("/lead", (req, res) => {
  const { name, contact, postalCode, service, city } = req.body;
  if (!name || !contact || !postalCode) {
    return res.status(400).json({ success: false, error: "Missing fields" });
  }
  const leadId = uuidv4();
  const newLead = {
    id: leadId,
    name,
    contact,
    postalCode,
    service: service || "roof inspection",
    city: city || "unknown",
    status: "active",
    createdAt: new Date().toISOString(),
    highestBid: 0,
    winner: null,
    forSale: false,
    salePrice: null,
    soldTo: null,
    soldAt: null,
  };
  leads.unshift(newLead);
  startAuction(leadId, newLead.city);
  res.json({ success: true, leadId });
});

// ---------- Socket.io Events ----------
io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("join_city", (city) => {
    if (!city) return;
    const contractorId = socket.id;
    contractors.set(socket.id, {
      id: contractorId,
      city,
      status: "online",
      lastSeen: Date.now(),
    });
    socket.join(city);
    socket.emit("joined", { city, contractorId });
  });

  socket.on("bid", ({ leadId, contractorId, amount }) => {
    const auction = auctions.get(leadId);
    if (!auction || auction.status !== "live") {
      socket.emit("bid_error", { message: "No active auction for this lead" });
      return;
    }
    if (amount <= auction.highestBid) {
      socket.emit("bid_error", { message: `Bid must be > $${auction.highestBid}` });
      return;
    }
    auction.highestBid = amount;
    auction.winner = contractorId;
    auction.bids.push({ contractorId, amount, timestamp: Date.now() });
    bids.push({
      id: uuidv4(),
      leadId,
      contractorId,
      amount,
      timestamp: Date.now(),
    });
    updateLeadFromAuction(leadId);
    io.to(auction.city).emit("new_bid", { leadId, highestBid: amount, contractorId });
  });

  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
    contractors.delete(socket.id);
  });
});

// Serve static pages (admin panel, lead store, etc.)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/lead-store", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "lead-store.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));