// FarmFeast WhatsApp Webhook — Supabase Edge Function
// Deploy: supabase functions deploy ff-whatsapp-webhook --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SARVAM_API_KEY       = Deno.env.get("SARVAM_API_KEY")!;
const TWILIO_ACCOUNT_SID   = Deno.env.get("TWILIO_ACCOUNT_SID")!;
const TWILIO_AUTH_TOKEN    = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

interface TwilioPayload {
  MessageSid:         string;
  From:               string;
  To:                 string;
  Body:               string;
  NumMedia:           string;
  MediaUrl0?:         string;
  MediaContentType0?: string;
  Latitude?:          string;
  Longitude?:         string;
}

interface ParsedListing {
  produce_name:    string;
  produce_name_kn: string;
  quantity:        number;
  unit:            string;
  price_per_unit?: number;
  harvest_date:    string;
  description:     string;
}

// ── Main handler ───────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const formData = await req.formData();
    const payload  = Object.fromEntries(formData.entries()) as unknown as TwilioPayload;

    const mobile   = payload.From.replace("whatsapp:", "");
    const body     = (payload.Body || "").trim();
    const hasAudio = payload.NumMedia !== "0" &&
                     (payload.MediaContentType0 || "").startsWith("audio");

    console.log(`Inbound from ${mobile} | audio=${hasAudio} | mime=${payload.MediaContentType0} | body="${body}"`);

    // Log raw message
    const { data: waMsg } = await supabase
      .from("ff_whatsapp_messages")
      .insert({
        wa_message_id: payload.MessageSid,
        mobile,
        direction:    "inbound",
        message_type: hasAudio ? "audio" : "text",
        body,
        media_url:    payload.MediaUrl0 || null,
        media_mime:   payload.MediaContentType0 || null,
        raw_payload:  payload,
        processed:    false,
      })
      .select("id")
      .single();

    const waMessageDbId = waMsg?.id;

    // Look up farmer
    const { data: farmer } = await supabase
      .from("ff_farmers")
      .select("id, name, village, active")
      .eq("mobile", mobile)
      .single();

    // Route

    if (hasAudio && farmer?.active) {
      return twilioReply(await handleVoiceListing(payload, farmer, waMessageDbId));
    }

    if (hasAudio && !farmer) {
      return twilioReply(
        "Namaskara! 🙏 Nimma account illi illa.\n" +
        "Register aagalu REGISTER antha type maadi.\n\n" +
        "(Not registered on FarmFeast. Type REGISTER to get started.)"
      );
    }

    if (body.toUpperCase().startsWith("REGISTER")) {
      return twilioReply(
        "FarmFeastge swagata! 🌾\n\n" +
        "Nimage register aagalu keLage heliri:\n\n" +
        "NAME: Ramegowda\n" +
        "VILLAGE: Solur\n" +
        "CROPS: Radish, Beans"
      );
    }

    if (body.toUpperCase().includes("NAME:") && !farmer) {
      return twilioReply(await handleRegistration(body, mobile));
    }

    // PRICE: 28 → set price on most recent draft listing
    if (body.toUpperCase().startsWith("PRICE:") && farmer) {
      return twilioReply(await handlePriceSet(body, farmer));
    }

    if (body.toUpperCase() === "STATUS" && farmer) {
      return twilioReply(await handleStatusQuery(farmer));
    }

    // WALK → start boundary walk
    if (body.toUpperCase() === "WALK" && farmer) {
      return twilioReply(await handleWalkStart(farmer));
    }

    // DONE → finish boundary walk
    if (body.toUpperCase() === "DONE" && farmer) {
      return twilioReply(await handleWalkDone(farmer));
    }

    // Location pin → farmer is walking the boundary
    if (payload.Latitude && payload.Longitude && farmer) {
      return twilioReply(await handleLocationPin(payload, farmer));
    }

    const helpMsg = farmer
      ? `Namaskara ${farmer.name}! 🌾\n\nVoice note kali listing create maadi.\nSTATUS type maadi nimma listings nodi.\n\n(Send a voice note to list produce. Type STATUS to check listings.)`
      : "Namaskara! Type REGISTER to join FarmFeast 🌾";

    return twilioReply(helpMsg);

  } catch (err) {
    console.error("Webhook error:", err);
    return twilioReply("Tappu aagide. Sudharisutteve! 🙏\n(Something went wrong, we are fixing it.)");
  }
});

// ── Voice listing handler ──────────────────────────────────────
async function handleVoiceListing(
  payload:      TwilioPayload,
  farmer:       { id: string; name: string; village: string },
  waMessageDbId?: string
): Promise<string> {

  const authHeader = "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const audioRes   = await fetch(payload.MediaUrl0!, {
    headers: { Authorization: authHeader },
  });

  if (!audioRes.ok) {
    console.error("Audio download failed:", audioRes.status, await audioRes.text());
    return "Audio download madalu aagalilla. Matte try maadi. 🙏\n(Could not download audio.)";
  }

  const audioBuffer = await audioRes.arrayBuffer();
  const mimeType    = payload.MediaContentType0 || "audio/ogg";

  console.log(`Audio downloaded: ${audioBuffer.byteLength} bytes, mime: ${mimeType}`);

  // Store in Supabase Storage (non-fatal if bucket missing)
  const ext           = mimeTypeToExt(mimeType);
  const audioFileName = `${farmer.id}/${payload.MessageSid}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("ff-voices")
    .upload(audioFileName, audioBuffer, { contentType: mimeType, upsert: true });

  if (uploadError) console.error("Storage upload error:", uploadError);

  const { data: { publicUrl: voiceUrl } } = supabase.storage
    .from("ff-voices")
    .getPublicUrl(audioFileName);

  // Transcribe
  const transcript = await transcribeWithSarvam(audioBuffer, mimeType);
  console.log("Transcript result:", transcript);

  if (!transcript) {
    return (
      "Nimma voice note kelisalilla. Dayavittu matte heliri. 🙏\n\n" +
      "Tips:\n" +
      "• Clearly say: quantity + produce + harvest date\n" +
      "• Example: '30 kilo radish naale harvest aaguttade'"
    );
  }

  // Parse
  const parsed = parseListingFromTranscript(transcript, farmer.village);

  if (!parsed) {
    return (
      `Kelidu: "${transcript.substring(0, 120)}"\n\n` +
      "Aadare produce, quantity gottaagalilla.\n" +
      "Heege heliri: '30 kilo moolangi naale harvest aaguttade'\n\n" +
      `(Heard: "${transcript.substring(0, 80)}" — couldn't parse produce/qty.)`
    );
  }

  // Save listing
  const { data: listing, error: listingError } = await supabase
    .from("ff_listings")
    .insert({
      farmer_id:       farmer.id,
      produce_name:    parsed.produce_name,
      produce_name_kn: parsed.produce_name_kn,
      quantity:        parsed.quantity,
      unit:            parsed.unit,
      price_per_unit:  parsed.price_per_unit || 0,
      harvest_date:    parsed.harvest_date,
      description:     parsed.description,
      voice_note_url:  voiceUrl,
      raw_transcript:  { text: transcript, parsed },
      status:          parsed.price_per_unit ? "active" : "draft",
    })
    .select("id")
    .single();

  if (listingError) {
    console.error("Listing insert error:", listingError);
    return "Listing save maadalu tappu. Matte try maadi. 🙏";
  }

  if (waMessageDbId) {
    await supabase
      .from("ff_whatsapp_messages")
      .update({ listing_id: listing.id, processed: true })
      .eq("id", waMessageDbId);
  }

  const priceNote = parsed.price_per_unit
    ? `₹${parsed.price_per_unit}/kg`
    : "Bele heLilla — PRICE: 28 kali set maadi";

  const status = parsed.price_per_unit ? "✅ Live" : "⏳ Draft";

  return (
    `✅ Listing create aagide, ${farmer.name}!\n\n` +
    `🌱 ${parsed.produce_name} (${parsed.produce_name_kn})\n` +
    `📦 ${parsed.quantity} ${parsed.unit}\n` +
    `📅 Harvest: ${parsed.harvest_date}\n` +
    `💰 ${priceNote}\n` +
    `📊 ${status}\n\n` +
    `(Listing created! Send "PRICE: 28" to set ₹/kg and go live.)`
  );
}

// ── Sarvam AI transcription ────────────────────────────────────
async function transcribeWithSarvam(
  audioBuffer: ArrayBuffer,
  mimeType:    string
): Promise<string | null> {
  try {
    const ext      = mimeTypeToExt(mimeType);
    const filename = `audio.${ext}`;

    const fd = new FormData();
    fd.append("file", new Blob([audioBuffer], { type: mimeType }), filename);
    fd.append("model", "saarika:v2.5");
    fd.append("language_code", "kn-IN");

    console.log(`Sarvam request: file=${filename} size=${audioBuffer.byteLength}`);

    const res  = await fetch("https://api.sarvam.ai/speech-to-text", {
      method:  "POST",
      headers: { "api-subscription-key": SARVAM_API_KEY },
      body:    fd,
    });

    const text = await res.text();
    console.log(`Sarvam response: status=${res.status} body=${text.substring(0, 300)}`);

    if (!res.ok) return null;

    const data = JSON.parse(text);
    return data.transcript || null;

  } catch (err) {
    console.error("Sarvam error:", err);
    return null;
  }
}

// ── Parse transcript → listing ─────────────────────────────────
function parseListingFromTranscript(
  transcript: string,
  village:    string
): ParsedListing | null {

  const text = transcript; // keep original case for Kannada script matching
  const low  = transcript.toLowerCase();

  // ── Quantity ──────────────────────────────────────────────────
  // Handles: "30 kg", "30 kilo", "ಮೂವತ್ತು ಕಿಲೋ"
  const kannadaNumbers: Record<string, number> = {
    "ಒಂದು": 1,    "ಎರಡು": 2,    "ಮೂರು": 3,     "ನಾಲ್ಕು": 4,   "ಐದು": 5,
    "ಆರು": 6,     "ಏಳು": 7,     "ಎಂಟು": 8,     "ಒಂಬತ್ತು": 9,  "ಹತ್ತು": 10,
    "ಹದಿನೈದು": 15, "ಇಪ್ಪತ್ತು": 20, "ಇಪ್ಪತ್ತೈದು": 25,
    "ಮೂವತ್ತು": 30, "ಮೂವತ್ತೈದು": 35,
    "ನಲವತ್ತು": 40, "ನಲವತ್ತೈದು": 45,
    "ಐವತ್ತು": 50,  "ಅರವತ್ತು": 60, "ಎಪ್ಪತ್ತು": 70,
    "ಎಂಬತ್ತು": 80, "ತೊಂಬತ್ತು": 90, "ನೂರು": 100,
  };

  let quantity: number | null = null;

  // Arabic numerals first
  const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:kilo(?:gram)?s?|kg|ಕಿಲೋ|ಕೆಜಿ)/i);
  if (qtyMatch) {
    quantity = parseFloat(qtyMatch[1]);
  } else {
    // Kannada number words
    for (const [word, val] of Object.entries(kannadaNumbers)) {
      if (text.includes(word) && (text.includes("ಕಿಲೋ") || text.includes("ಕೆಜಿ"))) {
        quantity = val;
        break;
      }
    }
  }

  if (!quantity) return null;

  // ── Produce map ───────────────────────────────────────────────
  // Kannada script (what Sarvam returns) + Latin transliterations
  const produceMap: Record<string, { en: string; kn: string }> = {
    // Kannada script
    "ಮೂಲಂಗಿ":     { en: "Radish",       kn: "ಮೂಲಂಗಿ" },
    "ರಾಡಿಶ್":     { en: "Radish",       kn: "ಮೂಲಂಗಿ" },
    "ಟೊಮೇಟೊ":     { en: "Tomato",       kn: "ಟೊಮೇಟೊ" },
    "ಟೊಮ್ಯಾಟೊ":   { en: "Tomato",       kn: "ಟೊಮೇಟೊ" },
    "ಅವರೆಕಾಯಿ":   { en: "Beans",        kn: "ಅವರೆಕಾಯಿ" },
    "ಅವರೆ":       { en: "Beans",        kn: "ಅವರೆಕಾಯಿ" },
    "ಪಾಲಕ್":      { en: "Spinach",      kn: "ಪಾಲಕ್" },
    "ನುಗ್ಗೇಕಾಯಿ": { en: "Drumstick",    kn: "ನುಗ್ಗೇಕಾಯಿ" },
    "ನುಗ್ಗೆ":     { en: "Drumstick",    kn: "ನುಗ್ಗೇಕಾಯಿ" },
    "ಬದನೆಕಾಯಿ":   { en: "Brinjal",      kn: "ಬದನೆಕಾಯಿ" },
    "ಬದನೆ":       { en: "Brinjal",      kn: "ಬದನೆಕಾಯಿ" },
    "ಎಲೆಕೋಸು":    { en: "Cabbage",      kn: "ಎಲೆಕೋಸು" },
    "ಕೋಸು":       { en: "Cabbage",      kn: "ಎಲೆಕೋಸು" },
    "ಗಾಜರ್":      { en: "Carrot",       kn: "ಗಾಜರ್" },
    "ಗಜ್ಜರಿ":     { en: "Carrot",       kn: "ಗಾಜರ್" },
    "ಈರುಳ್ಳಿ":    { en: "Onion",        kn: "ಈರುಳ್ಳಿ" },
    "ಆಲೂಗೆಡ್ಡೆ":  { en: "Potato",       kn: "ಆಲೂಗೆಡ್ಡೆ" },
    "ಆಲೂ":        { en: "Potato",       kn: "ಆಲೂಗೆಡ್ಡೆ" },
    "ಸೌತೆಕಾಯಿ":   { en: "Cucumber",     kn: "ಸೌತೆಕಾಯಿ" },
    "ಸೌತೆ":       { en: "Cucumber",     kn: "ಸೌತೆಕಾಯಿ" },
    "ಹಾಗಲಕಾಯಿ":   { en: "Bitter Gourd", kn: "ಹಾಗಲಕಾಯಿ" },
    "ಕೊತ್ತಂಬರಿ":  { en: "Coriander",    kn: "ಕೊತ್ತಂಬರಿ" },
    "ಸೊಪ್ಪು":     { en: "Greens",       kn: "ಸೊಪ್ಪು" },
    "ಬೆಳ್ಳುಳ್ಳಿ": { en: "Garlic",       kn: "ಬೆಳ್ಳುಳ್ಳಿ" },
    "ಶುಂಠಿ":      { en: "Ginger",       kn: "ಶುಂಠಿ" },
    "ಹೀರೆಕಾಯಿ":   { en: "Ridge Gourd",  kn: "ಹೀರೆಕಾಯಿ" },
    "ಕುಂಬಳಕಾಯಿ":  { en: "Pumpkin",      kn: "ಕುಂಬಳಕಾಯಿ" },
    // Latin transliterations
    "radish":       { en: "Radish",       kn: "ಮೂಲಂಗಿ" },
    "mullangi":     { en: "Radish",       kn: "ಮೂಲಂಗಿ" },
    "moolangi":     { en: "Radish",       kn: "ಮೂಲಂಗಿ" },
    "mulangi":      { en: "Radish",       kn: "ಮೂಲಂಗಿ" },
    "tomato":       { en: "Tomato",       kn: "ಟೊಮೇಟೊ" },
    "tomatoes":     { en: "Tomato",       kn: "ಟೊಮೇಟೊ" },
    "beans":        { en: "Beans",        kn: "ಅವರೆಕಾಯಿ" },
    "avarekai":     { en: "Beans",        kn: "ಅವರೆಕಾಯಿ" },
    "spinach":      { en: "Spinach",      kn: "ಪಾಲಕ್" },
    "palak":        { en: "Spinach",      kn: "ಪಾಲಕ್" },
    "drumstick":    { en: "Drumstick",    kn: "ನುಗ್ಗೇಕಾಯಿ" },
    "nuggekai":     { en: "Drumstick",    kn: "ನುಗ್ಗೇಕಾಯಿ" },
    "brinjal":      { en: "Brinjal",      kn: "ಬದನೆಕಾಯಿ" },
    "badanekai":    { en: "Brinjal",      kn: "ಬದನೆಕಾಯಿ" },
    "cabbage":      { en: "Cabbage",      kn: "ಎಲೆಕೋಸು" },
    "carrot":       { en: "Carrot",       kn: "ಗಾಜರ್" },
    "onion":        { en: "Onion",        kn: "ಈರುಳ್ಳಿ" },
    "eerulli":      { en: "Onion",        kn: "ಈರುಳ್ಳಿ" },
    "potato":       { en: "Potato",       kn: "ಆಲೂಗೆಡ್ಡೆ" },
    "aloo":         { en: "Potato",       kn: "ಆಲೂಗೆಡ್ಡೆ" },
    "alugadde":     { en: "Potato",       kn: "ಆಲೂಗೆಡ್ಡೆ" },
    "cucumber":     { en: "Cucumber",     kn: "ಸೌತೆಕಾಯಿ" },
    "southekai":    { en: "Cucumber",     kn: "ಸೌತೆಕಾಯಿ" },
    "bitter gourd": { en: "Bitter Gourd", kn: "ಹಾಗಲಕಾಯಿ" },
    "hagalakai":    { en: "Bitter Gourd", kn: "ಹಾಗಲಕಾಯಿ" },
    "coriander":    { en: "Coriander",    kn: "ಕೊತ್ತಂಬರಿ" },
    "kottambari":   { en: "Coriander",    kn: "ಕೊತ್ತಂಬರಿ" },
    "greens":       { en: "Greens",       kn: "ಸೊಪ್ಪು" },
    "soppu":        { en: "Greens",       kn: "ಸೊಪ್ಪು" },
    "garlic":       { en: "Garlic",       kn: "ಬೆಳ್ಳುಳ್ಳಿ" },
    "bellulli":     { en: "Garlic",       kn: "ಬೆಳ್ಳುಳ್ಳಿ" },
    "ginger":       { en: "Ginger",       kn: "ಶುಂಠಿ" },
    "shunti":       { en: "Ginger",       kn: "ಶುಂಠಿ" },
    "pumpkin":      { en: "Pumpkin",      kn: "ಕುಂಬಳಕಾಯಿ" },
    "kumbalkai":    { en: "Pumpkin",      kn: "ಕುಂಬಳಕಾಯಿ" },
  };

  let produceName   = "";
  let produceNameKn = "";

  // Check original text (for Kannada script) and lowercase (for Latin)
  for (const [keyword, names] of Object.entries(produceMap)) {
    if (text.includes(keyword) || low.includes(keyword)) {
      produceName   = names.en;
      produceNameKn = names.kn;
      break;
    }
  }

  if (!produceName) return null;

  // ── Harvest date ──────────────────────────────────────────────
  const today       = new Date();
  const harvestDate = new Date(today);

  if (
    low.includes("today") || low.includes("indina") ||
    text.includes("ಇಂದು") || text.includes("ಇಂದಿನ")
  ) {
    // stays today
  } else if (
    low.includes("tomorrow") || low.includes("naale") || low.includes("naalu") ||
    text.includes("ನಾಳೆ")
  ) {
    harvestDate.setDate(today.getDate() + 1);
  } else if (
    low.includes("day after") || low.includes("naadle") || low.includes("tulidu") ||
    text.includes("ನಾಡಿದ್ದು")
  ) {
    harvestDate.setDate(today.getDate() + 2);
  } else {
    harvestDate.setDate(today.getDate() + 1); // default tomorrow
  }

  const isoDate = harvestDate.toISOString().split("T")[0];

  // ── Price (optional) ──────────────────────────────────────────
  const priceKeywords = ["rupee", "rs ", "rs.", "price", "₹", "per kg", "rupe", "ರೂಪಾಯಿ", "ರೂ"];
  const hasExplicitPrice = priceKeywords.some(k => text.includes(k) || low.includes(k));
  let price: number | undefined;

  if (hasExplicitPrice) {
    const priceMatch = low.match(/(\d+)\s*(?:rupees?|rs\.?|per\s*kg|\/kg)/i);
    if (priceMatch) price = parseFloat(priceMatch[1]);
  }

  return {
    produce_name:    produceName,
    produce_name_kn: produceNameKn,
    quantity,
    unit:            "kg",
    price_per_unit:  price,
    harvest_date:    isoDate,
    description:     `Voice listing from ${village}. Transcript: "${transcript.substring(0, 200)}"`,
  };
}

// ── Registration handler ───────────────────────────────────────
async function handleRegistration(body: string, mobile: string): Promise<string> {
  const nameMatch    = body.match(/NAME:\s*([^\n]+)/i);
  const villageMatch = body.match(/VILLAGE:\s*([^\n]+)/i);

  if (!nameMatch || !villageMatch) {
    return (
      "Hesaru mattu ooru helabeku:\n\n" +
      "NAME: Nimma hesaru\n" +
      "VILLAGE: Nimma ooru\n" +
      "CROPS: Beleya hesaru (optional)\n\n" +
      "(Please include NAME and VILLAGE)"
    );
  }

  const name    = nameMatch[1].trim();
  const village = villageMatch[1].trim();

  const { error } = await supabase.from("ff_farmers").insert({
    name, mobile, village,
    district: "Ramanagara",
    state:    "Karnataka",
    language: "kn",
    active:   true,
  });

  if (error) {
    if (error.code === "23505") {
      return `${name} avare, neevu modalede register aagideeri! 🌾\n(Already registered!)`;
    }
    console.error("Registration error:", error);
    return "Register maadalu tappu aagide. Matte try maadi. 🙏";
  }

  return (
    `✅ Swagata, ${name}! FarmFeastge joini aagideeri! 🌾\n\n` +
    `📍 Ooru: ${village}\n\n` +
    `Listing maadalu voice note kali heegi heli:\n` +
    `"Naanu 30 kilo moolangi naale harvest maaduttene"\n\n` +
    `(Welcome! Send a voice note saying your produce, quantity and harvest date.)`
  );
}

// ── Status handler ─────────────────────────────────────────────
async function handleStatusQuery(farmer: { id: string; name: string }): Promise<string> {
  const { data: listings } = await supabase
    .from("ff_listings")
    .select("produce_name, quantity, unit, price_per_unit, harvest_date, status, quantity_sold")
    .eq("farmer_id", farmer.id)
    .in("status", ["active", "draft"])
    .order("harvest_date", { ascending: true })
    .limit(5);

  if (!listings || listings.length === 0) {
    return (
      `${farmer.name} avare, nimma yaavude active listings illa. 🌱\n\n` +
      "(No active listings. Send a voice note to create one.)"
    );
  }

  const lines = listings.map((l: {
    produce_name: string; quantity: number; quantity_sold: number;
    unit: string; price_per_unit: number; harvest_date: string; status: string;
  }) => {
    const rem   = l.quantity - (l.quantity_sold || 0);
    const emoji = l.status === "active" ? "✅" : "⏳";
    const price = l.price_per_unit ? `₹${l.price_per_unit}/kg` : "bele illa";
    return `${emoji} ${l.produce_name} — ${rem}${l.unit} — ${price} — ${l.harvest_date}`;
  });

  return `📋 Nimma listings, ${farmer.name}:\n\n${lines.join("\n")}\n\n(Your active listings)`;
}


// ── Price set handler ──────────────────────────────────────────
async function handlePriceSet(
  body:   string,
  farmer: { id: string; name: string }
): Promise<string> {
  const priceMatch = body.match(/PRICE:\s*(\d+(?:\.\d+)?)/i);
  if (!priceMatch) {
    return "Bele gottaagalilla. Heege kali: PRICE: 28\n(Format: PRICE: 28)";
  }

  const price = parseFloat(priceMatch[1]);

  const { data: listing } = await supabase
    .from("ff_listings")
    .select("id, produce_name, quantity, unit, harvest_date")
    .eq("farmer_id", farmer.id)
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!listing) {
    return "Yaavude draft listing illa. Voice note kali hosa listing maadi.\n\n(No draft listing found. Send a voice note to create one first.)";
  }

  const { error } = await supabase
    .from("ff_listings")
    .update({ price_per_unit: price, status: "active" })
    .eq("id", listing.id);

  if (error) {
    console.error("Price update error:", error);
    return "Bele update maadalu tappu. Matte try maadi. 🙏";
  }

  return `✅ Listing live aagide! 🎉\n\n🌱 ${listing.produce_name}\n📦 ${listing.quantity} ${listing.unit}\n📅 Harvest: ${listing.harvest_date}\n💰 ₹${price}/kg\n📊 ✅ Live — consumers can now order!\n\n(Your listing is now live on FarmFeast marketplace!)`;
}


// ── Farm boundary walk handlers ────────────────────────────────

async function handleWalkStart(
  farmer: { id: string; name: string }
): Promise<string> {
  await supabase
    .from("ff_whatsapp_messages")
    .update({ processed: true })
    .eq("farmer_id", farmer.id)
    .eq("message_type", "location")
    .eq("processed", false);

  return (
    `🗺️ Farm boundary walk shuru aagide, ${farmer.name}!\n\n` +
    `Heege maadi:\n` +
    `1. Nimma farm corner-ge hogi\n` +
    `2. WhatsApp-alli location share maadi (📎 → Location → Send current location)\n` +
    `3. Prati corner-alli location kali — kamida 4, heddu 10\n` +
    `4. Mugisidaga DONE antha kali\n\n` +
    `(Walk to each corner of your farm and share your location. Send DONE when finished.)`
  );
}

async function handleLocationPin(
  payload: TwilioPayload,
  farmer:  { id: string; name: string }
): Promise<string> {
  const lat = parseFloat(payload.Latitude!);
  const lng = parseFloat(payload.Longitude!);

  const { count } = await supabase
    .from("ff_whatsapp_messages")
    .select("id", { count: "exact" })
    .eq("farmer_id", farmer.id)
    .eq("message_type", "location")
    .eq("processed", false);

  const pinNumber = (count || 0) + 1;

  await supabase
    .from("ff_whatsapp_messages")
    .insert({
      wa_message_id: payload.MessageSid,
      farmer_id:     farmer.id,
      mobile:        payload.From.replace("whatsapp:", ""),
      direction:     "inbound",
      message_type:  "location",
      body:          `${lat},${lng}`,
      raw_payload:   { lat, lng, pin: pinNumber },
      processed:     false,
    });

  const tips = pinNumber < 4
    ? `${4 - pinNumber} corner baaki ide. Mudiyetti DONE kali.`
    : `Savya aagide! Mudiyetti DONE kali.`;

  return (
    `📍 Pin ${pinNumber} save aagide!\n` +
    `📌 ${lat.toFixed(5)}, ${lng.toFixed(5)}\n\n` +
    `${tips}\n\n` +
    `(Pin ${pinNumber} saved. ${pinNumber >= 4 ? "Send DONE to finish." : `${4 - pinNumber} more corners needed.`})`
  );
}

async function handleWalkDone(
  farmer: { id: string; name: string }
): Promise<string> {
  const { data: pins } = await supabase
    .from("ff_whatsapp_messages")
    .select("body, raw_payload")
    .eq("farmer_id", farmer.id)
    .eq("message_type", "location")
    .eq("processed", false)
    .order("created_at", { ascending: true });

  if (!pins || pins.length < 3) {
    return (
      `Kamida 3 location pins beka. Neevu ${pins?.length || 0} kottideeri.\n\n` +
      `Farm corners-ge hogi location share maadi, apramela DONE kali.\n\n` +
      `(Need at least 3 pins. You have sent ${pins?.length || 0}. ` +
      `Share location at each corner then send DONE.)`
    );
  }

  const coords = pins.map((p: { raw_payload: { lat: number; lng: number } }) => [
    p.raw_payload.lng,
    p.raw_payload.lat,
  ]);
  coords.push(coords[0]);

  const coordStr = coords.map((c: number[]) => `${c[0]} ${c[1]}`).join(", ");
  const wkt      = `POLYGON((${coordStr}))`;
  const areaAcres = computeAreaAcres(coords);

  const { error } = await supabase
    .from("ff_farmers")
    .update({
      farm_boundary:   wkt,
      farm_area_acres: areaAcres,
      centroid_lat:    pins.reduce((s: number, p: { raw_payload: { lat: number } }) => s + p.raw_payload.lat, 0) / pins.length,
      centroid_lng:    pins.reduce((s: number, p: { raw_payload: { lng: number } }) => s + p.raw_payload.lng, 0) / pins.length,
    })
    .eq("id", farmer.id);

  if (error) {
    console.error("Farm boundary update error:", error);
    return "Boundary save maadalu tappu. Matte try maadi. 🙏";
  }

  await supabase
    .from("ff_whatsapp_messages")
    .update({ processed: true })
    .eq("farmer_id", farmer.id)
    .eq("message_type", "location")
    .eq("processed", false);

  return (
    `✅ Nimma farm boundary save aagide, ${farmer.name}! 🗺️\n\n` +
    `📍 ${pins.length} corners captured\n` +
    `🌾 Farm size: ~${areaAcres.toFixed(2)} acres\n\n` +
    `FarmFeast-alli nimma farm profile ready!\n` +
    `Iga voice note kali produce list maadi.\n\n` +
    `(Farm boundary saved! ~${areaAcres.toFixed(2)} acres mapped. Now send a voice note to list produce.)`
  );
}

function computeAreaAcres(coords: number[][]): number {
  let area = 0;
  const n  = coords.length;
  for (let i = 0; i < n - 1; i++) {
    area += coords[i][0] * coords[i + 1][1];
    area -= coords[i + 1][0] * coords[i][1];
  }
  area = Math.abs(area) / 2;
  const sqKm  = area * 111 * 108;
  const acres = sqKm * 247.105;
  return acres;
}

// ── Helpers ────────────────────────────────────────────────────
function mimeTypeToExt(mime: string): string {
  const map: Record<string, string> = {
    "audio/ogg":   "ogg",
    "audio/opus":  "ogg",
    "audio/mpeg":  "mp3",
    "audio/mp3":   "mp3",
    "audio/mp4":   "m4a",
    "audio/webm":  "webm",
    "audio/amr":   "amr",
    "audio/wav":   "wav",
    "audio/x-wav": "wav",
    "audio/aac":   "aac",
  };
  return map[mime] || "ogg";
}

function twilioReply(message: string): Response {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message><Body>${escapeXml(message)}</Body></Message>\n</Response>`;
  return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&apos;");
}
