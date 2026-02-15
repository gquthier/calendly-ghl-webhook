require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────
const GHL = {
  apiKey: process.env.GHL_API_KEY,
  baseUrl: process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com",
  locationId: process.env.GHL_LOCATION_ID,
  pipelineSales: process.env.GHL_PIPELINE_SALES,
  stageNewBooking: process.env.GHL_STAGE_NEW_BOOKING,
};

// Validation au démarrage
const requiredVars = ["GHL_API_KEY", "GHL_LOCATION_ID", "GHL_PIPELINE_SALES", "GHL_STAGE_NEW_BOOKING"];
for (const v of requiredVars) {
  if (!process.env[v]) console.warn(`⚠ Variable manquante: ${v}`);
}
console.log("Config GHL:", { baseUrl: GHL.baseUrl, locationId: GHL.locationId, pipelineSales: GHL.pipelineSales, stageNewBooking: GHL.stageNewBooking });

const ghlHeaders = {
  Authorization: `Bearer ${GHL.apiKey}`,
  Version: "2021-07-28",
  "Content-Type": "application/json",
  Accept: "application/json",
};

// ── Helpers ─────────────────────────────────────────────

// Cherche un contact GHL par email
async function findContactByEmail(email) {
  const url = `${GHL.baseUrl}/contacts/search/duplicate?locationId=${GHL.locationId}&email=${encodeURIComponent(email)}`;
  const res = await axios.get(url, { headers: ghlHeaders });
  const contact = res.data?.contact;
  if (!contact) return null;
  return contact;
}

// Cherche un contact GHL par téléphone
async function findContactByPhone(phone) {
  const url = `${GHL.baseUrl}/contacts/search/duplicate?locationId=${GHL.locationId}&phone=${encodeURIComponent(phone)}`;
  const res = await axios.get(url, { headers: ghlHeaders });
  const contact = res.data?.contact;
  if (!contact) return null;
  return contact;
}

// Cherche les opportunités d'un contact dans tous les pipelines
async function findOpportunityForContact(contactId) {
  const url = `${GHL.baseUrl}/opportunities/search?location_id=${GHL.locationId}&contact_id=${contactId}&limit=20`;
  const res = await axios.get(url, { headers: ghlHeaders });
  const opportunities = res.data?.opportunities || [];
  return opportunities[0] || null;
}

// Met à jour le stage d'une opportunité vers "New Booking"
async function updateOpportunityStage(opportunityId) {
  const url = `${GHL.baseUrl}/opportunities/${opportunityId}`;
  const res = await axios.put(
    url,
    {
      pipelineId: GHL.pipelineSales,
      pipelineStageId: GHL.stageNewBooking,
    },
    { headers: ghlHeaders }
  );
  return res.data;
}

// ── Webhook endpoint ────────────────────────────────────
app.post("/webhook/calendly", async (req, res) => {
  const event = req.body;
  const timestamp = new Date().toISOString();

  console.log(`\n[${timestamp}] Webhook reçu: ${event.event}`);

  // On ne traite que les créations de bookings
  if (event.event !== "invitee.created") {
    console.log(`  → Ignoré (event type: ${event.event})`);
    return res.status(200).json({ status: "ignored" });
  }

  try {
    const invitee = event.payload;
    const email = invitee.email;
    const name = invitee.name;
    const phone = invitee.text_reminder_number || null;
    const eventType = invitee.scheduled_event?.name || "unknown";

    console.log(`  → Nouveau booking: ${name} (${email}) - ${eventType}`);

    // 1. Chercher le contact dans GHL par email
    let contact = await findContactByEmail(email);

    // 2. Si pas trouvé par email, essayer par téléphone
    if (!contact && phone) {
      console.log(`  → Contact non trouvé par email, essai par téléphone: ${phone}`);
      contact = await findContactByPhone(phone);
    }

    if (!contact) {
      console.log(`  ✗ Contact introuvable dans GHL pour: ${email}`);
      return res.status(200).json({
        status: "contact_not_found",
        email,
        message: "Aucun contact GHL trouvé pour cet email/téléphone",
      });
    }

    console.log(`  → Contact trouvé: ${contact.id} (${contact.firstName || ""} ${contact.lastName || ""})`);

    // 3. Chercher l'opportunité dans tous les pipelines
    const opportunity = await findOpportunityForContact(contact.id);

    if (!opportunity) {
      console.log(`  ✗ Aucune opportunité trouvée pour contact: ${contact.id}`);
      return res.status(200).json({
        status: "opportunity_not_found",
        contactId: contact.id,
        message: "Contact trouvé mais aucune opportunité dans aucun pipeline",
      });
    }

    console.log(`  → Opportunité trouvée: ${opportunity.id} (stage actuel: ${opportunity.pipelineStageId})`);

    // 4. Mettre à jour le stage → New Booking
    const updated = await updateOpportunityStage(opportunity.id);
    console.log(`  ✓ Opportunité mise à jour → New Booking`);

    return res.status(200).json({
      status: "success",
      contactId: contact.id,
      opportunityId: opportunity.id,
      newStage: "New Booking",
    });
  } catch (error) {
    console.error(`  ✗ Erreur:`, error.response?.data || error.message);
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// ── Health check ────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ── Start ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Webhook server démarré sur le port ${PORT}`);
  console.log(`   POST /webhook/calendly  → Reçoit les webhooks Calendly`);
  console.log(`   GET  /health            → Health check\n`);
});
