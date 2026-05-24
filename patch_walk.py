with open('supabase/functions/ff-whatsapp-webhook/index.ts', 'r') as f:
    content = f.read()

# ── 1. Add TwilioPayload fields for location ───────────────────
content = content.replace(
    '  MediaUrl0?:         string;\n  MediaContentType0?: string;\n}',
    '  MediaUrl0?:         string;\n  MediaContentType0?: string;\n  Latitude?:          string;\n  Longitude?:         string;\n}'
)

# ── 2. Add WALK routes in main handler ────────────────────────
content = content.replace(
    '    if (body.toUpperCase() === "STATUS" && farmer) {\n      return twilioReply(await handleStatusQuery(farmer));\n    }',
    '''    if (body.toUpperCase() === "STATUS" && farmer) {
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
    }'''
)

# ── 3. Add walk handler functions before helpers ───────────────
walk_fns = '''
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
    `🗺️ Farm boundary walk shuru aagide, ${farmer.name}!\\n\\n` +
    `Heege maadi:\\n` +
    `1. Nimma farm corner-ge hogi\\n` +
    `2. WhatsApp-alli location share maadi (📎 → Location → Send current location)\\n` +
    `3. Prati corner-alli location kali — kamida 4, heddu 10\\n` +
    `4. Mugisidaga DONE antha kali\\n\\n` +
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
    `📍 Pin ${pinNumber} save aagide!\\n` +
    `📌 ${lat.toFixed(5)}, ${lng.toFixed(5)}\\n\\n` +
    `${tips}\\n\\n` +
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
      `Kamida 3 location pins beka. Neevu ${pins?.length || 0} kottideeri.\\n\\n` +
      `Farm corners-ge hogi location share maadi, apramela DONE kali.\\n\\n` +
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
    `✅ Nimma farm boundary save aagide, ${farmer.name}! 🗺️\\n\\n` +
    `📍 ${pins.length} corners captured\\n` +
    `🌾 Farm size: ~${areaAcres.toFixed(2)} acres\\n\\n` +
    `FarmFeast-alli nimma farm profile ready!\\n` +
    `Iga voice note kali produce list maadi.\\n\\n` +
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

'''

content = content.replace('// ── Helpers ────', walk_fns + '// ── Helpers ────')

with open('supabase/functions/ff-whatsapp-webhook/index.ts', 'w') as f:
    f.write(content)

print(f"Done — {content.count(chr(10))} lines")
