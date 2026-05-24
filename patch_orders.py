with open('src/pages/Marketplace.tsx', 'r') as f:
    content = f.read()

# Fix missing produce name on card — it uses l.produce which doesn't exist
content = content.replace(
    "p style={{ fontFamily: \"'Playfair Display', Georgia, serif\", fontSize: 18, fontWeight: 700, color: \"#fff\", marginTop: 8 }}>{l.produce}</p>",
    "p style={{ fontFamily: \"'Playfair Display', Georgia, serif\", fontSize: 18, fontWeight: 700, color: \"#fff\", marginTop: 8 }}>{l.produce_name}</p>"
)

# Fix cart total using correct field
content = content.replace(
    "return sum + (l ? l.price * qty : 0);",
    "return sum + (l ? l.price_per_unit * qty : 0);"
)

# Fix price display on card
content = content.replace(
    "p style={{ fontSize: 22, fontWeight: 700, color: \"#2D6A4F\", fontFamily: \"'Playfair Display', serif\" }}>₹{l.price}<span",
    "p style={{ fontSize: 22, fontWeight: 700, color: \"#2D6A4F\", fontFamily: \"'Playfair Display', serif\" }}>₹{l.price_per_unit}<span"
)

# Fix qty available display
content = content.replace(
    "p style={{ fontSize: 11, color: \"#888\", marginTop: 1 }}>{l.qty} kg available · {l.soil}</p>",
    "p style={{ fontSize: 11, color: \"#888\", marginTop: 1 }}>{l.quantity_available} kg available · {(l.soil_data as {type?:string}|null)?.type || 'Farm soil'}</p>"
)

# Fix detail drawer price
content = content.replace(
    "p style={{ fontSize: 26, fontWeight: 700, color: \"#2D6A4F\", fontFamily: \"'Playfair Display', serif\" }}>₹{l.price}/kg</p>",
    "p style={{ fontSize: 26, fontWeight: 700, color: \"#2D6A4F\", fontFamily: \"'Playfair Display', serif\" }}>₹{l.price_per_unit}/kg</p>"
)

# Fix harvest display in drawer
content = content.replace(
    "p style={{ fontSize: 12, color: \"#888\" }}>{l.qty} kg available · Harvests {l.harvestDate.toLowerCase()}</p>",
    "p style={{ fontSize: 12, color: \"#888\" }}>{l.quantity_available} kg available · Harvests {formatHarvestDate(l.harvest_date).toLowerCase()}</p>"
)

# Replace the placeOrder function with one that writes to Supabase
old_place = '''  function placeOrder() {
    const items = Object.entries(cart).map(([id, qty]) => {
      const l = listings.find(l => l.id === +id);
      return `${qty}kg ${l.produce} from ${l.farmer}`;
    });
    setOrdered(items);
    setCart({});
  }'''

new_place = '''  async function placeOrder() {
    const name    = (document.getElementById("order-name") as HTMLInputElement)?.value?.trim();
    const flat    = (document.getElementById("order-flat") as HTMLInputElement)?.value?.trim();
    const complex = (document.getElementById("order-complex") as HTMLSelectElement)?.value?.trim();

    if (!name || !flat || !complex) {
      alert("Please fill in your name, complex and flat number.");
      return;
    }

    const items: string[] = [];

    for (const [id, qty] of Object.entries(cart)) {
      const l = listings.find(l => l.id === id);
      if (!l) continue;

      await supabase.from("ff_orders").insert({
        listing_id:       l.id,
        farmer_id:        (l as unknown as Record<string,string>).farmer_id,
        quantity:         qty,
        unit:             l.unit,
        price_per_unit:   l.price_per_unit,
        total_amount:     l.price_per_unit * qty,
        delivery_address: `${flat}, ${complex}, Bangalore`,
        notes:            name,
        status:           "pending",
        payment_status:   "pending",
      });

      items.push(`${qty}kg ${l.produce_name} from ${l.farmer_name}`);
    }

    setOrdered(items);
    setCart({});
  }'''

content = content.replace(old_place, new_place)

# Replace the cart drawer order button + add name/flat/complex fields
old_btn = '''            <button className="btn-primary" style={{ width: "100%", marginTop: 18, padding: 13, fontSize: 15 }} onClick={placeOrder}>
              Place order · ₹{cartTotal}
            </button>
            <p style={{ fontSize: 11, color: "#aaa", textAlign: "center", marginTop: 8 }}>Delivered via Fresh Cuts to your apartment complex</p>'''

new_btn = '''            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <input id="order-name" type="text" placeholder="Your name" style={{ padding: "10px 14px", borderRadius: 10, border: "1.5px solid #D5D0C8", fontSize: 13, fontFamily: "inherit" }} />
              <select id="order-complex" style={{ padding: "10px 14px", borderRadius: 10, border: "1.5px solid #D5D0C8", fontSize: 13, fontFamily: "inherit", background: "#fff" }}>
                <option value="">Select your complex</option>
                <option>Godrej Woodman Estate</option>
                <option>RMZ Latitude</option>
                <option>L&T Raintree Boulevard</option>
                <option>Prestige Misty Waters</option>
                <option>Karle Zenith Residences</option>
                <option>Sobha City</option>
              </select>
              <input id="order-flat" type="text" placeholder="Flat / unit number e.g. B-204" style={{ padding: "10px 14px", borderRadius: 10, border: "1.5px solid #D5D0C8", fontSize: 13, fontFamily: "inherit" }} />
            </div>
            <button className="btn-primary" style={{ width: "100%", marginTop: 14, padding: 13, fontSize: 15 }} onClick={placeOrder}>
              Place order · ₹{cartTotal}
            </button>
            <p style={{ fontSize: 11, color: "#aaa", textAlign: "center", marginTop: 8 }}>Delivered via Fresh Cuts to your apartment</p>'''

content = content.replace(old_btn, new_btn)

with open('src/pages/Marketplace.tsx', 'w') as f:
    f.write(content)

print("Done")
