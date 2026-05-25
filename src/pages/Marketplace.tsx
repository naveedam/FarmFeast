import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";

interface Listing {
  id: string;
  farmer_id: string;
  produce_name: string;
  produce_name_kn: string;
  quantity_available: number;
  unit: string;
  price_per_unit: number;
  harvest_date: string;
  description: string | null;
  status: string;
  created_at: string;
  farmer_name: string;
  farmer_village: string;
  farmer_district: string;
  centroid_lat: number;
  centroid_lng: number;
  soil_data: { type?: string } | null;
}

const PRODUCE_EMOJI: Record<string, string> = {
  "Radish": "🌱", "Tomato": "🍅", "Beans": "🫘", "Spinach": "🥬",
  "Drumstick": "🌿", "Brinjal": "🍆", "Cabbage": "🥦", "Carrot": "🥕",
  "Onion": "🧅", "Potato": "🥔", "Cucumber": "🥒", "Bitter Gourd": "🌿",
  "Coriander": "🌿", "Greens": "🥬", "Garlic": "🧄", "Ginger": "🫚",
  "Pumpkin": "🎃", "Cluster Beans": "🫘",
};

const COMPLEXES = [
  "Godrej Woodman Estate",
  "RMZ Latitude",
  "L&T Raintree Boulevard",
  "Prestige Misty Waters",
  "Karle Zenith Residences",
  "Sobha City",
];

const filters = ["All", "Today", "Tomorrow", "This week"];

function formatHarvestDate(isoDate: string): string {
  const today   = new Date();
  const harvest = new Date(isoDate);
  today.setHours(0, 0, 0, 0);
  harvest.setHours(0, 0, 0, 0);
  const diff = Math.round((harvest.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff <= 7)  return `In ${diff} days`;
  return harvest.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function FarmFeast() {
  const [listings, setListings]       = useState<Listing[]>([]);
  const [loading, setLoading]         = useState(true);
  const [activeFilter, setActiveFilter] = useState("All");
  const [cart, setCart]               = useState<Record<string, number>>({});
  const [expanded, setExpanded]       = useState<string | null>(null);
  const [ordered, setOrdered]         = useState<string[] | null>(null);
  const [search, setSearch]           = useState("");

  useEffect(() => {
    async function fetchListings() {
      setLoading(true);
      const { data, error } = await supabase.from("ff_active_listings").select("*");
      if (error) console.error("Error fetching listings:", error);
      else setListings((data || []) as Listing[]);
      setLoading(false);
    }
    fetchListings();
  }, []);

  const filtered = listings.filter(l => {
    const label = formatHarvestDate(l.harvest_date);
    const matchFilter =
      activeFilter === "All" ||
      label === activeFilter ||
      (activeFilter === "This week" && label.includes("day"));
    const matchSearch =
      (l.produce_name    || "").toLowerCase().includes(search.toLowerCase()) ||
      (l.farmer_name     || "").toLowerCase().includes(search.toLowerCase()) ||
      (l.farmer_village  || "").toLowerCase().includes(search.toLowerCase());
    return matchFilter && matchSearch;
  });

  const cartTotal = Object.entries(cart).reduce((sum, [id, qty]) => {
    const l = listings.find(l => l.id === id);
    return sum + (l ? l.price_per_unit * qty : 0);
  }, 0);

  const cartCount = Object.values(cart).reduce((a, b) => a + b, 0);

  function addToCart(id: string) {
    setCart(c => ({ ...c, [id]: (c[id] || 0) + 1 }));
  }

  function removeFromCart(id: string) {
    setCart(c => {
      const n = { ...c };
      if (n[id] > 1) n[id]--;
      else delete n[id];
      return n;
    });
  }

  async function placeOrder() {
    const nameEl    = document.getElementById("order-name")    as HTMLInputElement;
    const flatEl    = document.getElementById("order-flat")    as HTMLInputElement;
    const complexEl = document.getElementById("order-complex") as HTMLSelectElement;

    const name    = nameEl?.value?.trim();
    const flat    = flatEl?.value?.trim();
    const complex = complexEl?.value?.trim();

    if (!name || !flat || !complex) {
      alert("Please fill in your name, complex and flat number.");
      return;
    }

    const items: string[] = [];

    for (const [id, qty] of Object.entries(cart)) {
      const l = listings.find(l => l.id === id);
      if (!l) continue;

      const { error } = await supabase.from("ff_orders").insert({
        listing_id:       l.id,
        farmer_id:        l.farmer_id,
        quantity:         qty,
        unit:             "kg",
        price_per_unit:   l.price_per_unit,
        total_amount:     l.price_per_unit * qty,
        delivery_address: `${flat}, ${complex}, Bangalore`,
        notes:            name,
        status:           "pending",
        payment_status:   "pending",
      });

      if (error) {
        console.error("Order insert error:", error);
        alert("Order failed: " + error.message);
        return;
      }

      items.push(`${qty}kg ${l.produce_name} from ${l.farmer_name}`);
    }

    setOrdered(items);
    setCart({});
  }

  return (
    <div style={{ fontFamily: "'DM Sans','Segoe UI',sans-serif", background: "#F6F3EE", minHeight: "100vh", color: "#1C1C1C" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Playfair+Display:wght@600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .card { background: #fff; border-radius: 16px; transition: box-shadow 0.2s, transform 0.2s; cursor: pointer; }
        .card:hover { box-shadow: 0 8px 32px rgba(44,90,50,0.13); transform: translateY(-2px); }
        .pill { display: inline-block; background: #E8F5E9; color: #2D6A4F; border-radius: 100px; font-size: 11px; font-weight: 600; padding: 3px 10px; margin: 2px; }
        .btn-primary { background: #2D6A4F; color: #fff; border: none; border-radius: 10px; padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.18s; font-family: inherit; }
        .btn-primary:hover { background: #1A3C2A; }
        .filter-btn { background: #fff; border: 1.5px solid #D5D0C8; color: #555; border-radius: 100px; padding: 6px 16px; font-size: 13px; cursor: pointer; font-weight: 500; transition: all 0.15s; font-family: inherit; }
        .filter-btn.active { background: #2D6A4F; border-color: #2D6A4F; color: #fff; }
        .qty-btn { width: 28px; height: 28px; border-radius: 8px; border: 1.5px solid #2D6A4F; background: #fff; color: #2D6A4F; font-size: 16px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .harvest-badge { display: inline-block; border-radius: 100px; font-size: 11px; font-weight: 700; padding: 3px 10px; }
        input[type=text], select { font-family: inherit; }
        .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 100; display: flex; align-items: flex-end; justify-content: center; }
        .drawer { background: #fff; border-radius: 24px 24px 0 0; padding: 28px 24px; width: 100%; max-width: 520px; max-height: 80vh; overflow-y: auto; }
        .modal { background: #fff; border-radius: 20px; padding: 28px; width: 90%; max-width: 400px; text-align: center; }
      `}</style>

      {/* Header */}
      <div style={{ background: "#1A3C2A", padding: "0 20px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>🌾</span>
            <span style={{ fontFamily: "'Playfair Display',Georgia,serif", fontSize: 22, fontWeight: 700, color: "#fff" }}>FarmFeast</span>
            <span style={{ background: "#52B788", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 6, padding: "2px 7px", marginLeft: 4 }}>FROM THE FARM</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ color: "#95D5B2", fontSize: 12 }}>Bangalore</span>
            {cartCount > 0 && (
              <button className="btn-primary" style={{ position: "relative", paddingRight: 22 }} onClick={() => setExpanded("cart")}>
                🛒 Cart
                <span style={{ position: "absolute", top: -6, right: -6, background: "#D4A017", color: "#fff", borderRadius: "50%", width: 18, height: 18, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{cartCount}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Hero */}
      <div style={{ background: "#2D6A4F", padding: "18px 20px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <p style={{ color: "#95D5B2", fontSize: 13, fontWeight: 500, marginBottom: 6 }}>DIRECT FROM SMALLHOLDER FARMERS · HARVESTED FOR YOU</p>
          <p style={{ color: "#fff", fontSize: 15, lineHeight: 1.55 }}>Every listing below is a real farmer near Bangalore. They set the price. You know their name, their soil, their harvest date.</p>
        </div>
      </div>

      {/* Search + filters */}
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px 20px 0" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input type="text" placeholder="Search produce, farmer or village…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 200, padding: "9px 16px", borderRadius: 10, border: "1.5px solid #D5D0C8", fontSize: 13, outline: "none", background: "#fff" }} />
          {filters.map(f => (
            <button key={f} className={`filter-btn${activeFilter === f ? " active" : ""}`} onClick={() => setActiveFilter(f)}>{f}</button>
          ))}
        </div>
        <p style={{ color: "#888", fontSize: 12, marginTop: 10 }}>{filtered.length} listings · Prices in ₹/kg · All produce pesticide-free</p>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#2D6A4F" }}>
          <p style={{ fontSize: 32 }}>🌾</p>
          <p style={{ fontSize: 14, marginTop: 8 }}>Fetching fresh listings...</p>
        </div>
      )}

      {/* Grid */}
      <div style={{ maxWidth: 900, margin: "16px auto 40px", padding: "0 20px", display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(270px,1fr))", gap: 18 }}>
        {filtered.map(l => {
          const qty          = cart[l.id] || 0;
          const label        = formatHarvestDate(l.harvest_date);
          const harvestColor = label === "Today" ? "#C0392B" : label === "Tomorrow" ? "#D4A017" : "#2D6A4F";
          const emoji        = PRODUCE_EMOJI[l.produce_name] || "🌾";
          const soil         = l.soil_data?.type || "Farm soil";

          return (
            <div key={l.id} className="card" style={{ overflow: "hidden" }} onClick={() => setExpanded(l.id)}>
              <div style={{ background: "#1A3C2A", padding: "18px 18px 14px", position: "relative" }}>
                <span style={{ fontSize: 36 }}>{emoji}</span>
                <span className="harvest-badge" style={{ position: "absolute", top: 14, right: 14, background: harvestColor + "22", color: harvestColor, border: `1px solid ${harvestColor}44` }}>{label}</span>
                <p style={{ fontFamily: "'Playfair Display',Georgia,serif", fontSize: 18, fontWeight: 700, color: "#fff", marginTop: 8 }}>{l.produce_name}</p>
                <p style={{ color: "#95D5B2", fontSize: 12, marginTop: 3 }}>{l.farmer_name} · {l.farmer_village} · 28 km</p>
              </div>
              <div style={{ padding: "14px 18px 18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 }}>
                  <div>
                    <p style={{ fontSize: 22, fontWeight: 700, color: "#2D6A4F", fontFamily: "'Playfair Display',serif" }}>₹{l.price_per_unit}<span style={{ fontSize: 13, fontWeight: 500, color: "#888" }}>/kg</span></p>
                    <p style={{ fontSize: 11, color: "#888", marginTop: 1 }}>{l.quantity_available} kg available · {soil}</p>
                  </div>
                  <div onClick={e => e.stopPropagation()}>
                    {qty === 0 ? (
                      <button className="btn-primary" onClick={() => addToCart(l.id)}>+ Add</button>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button className="qty-btn" onClick={() => removeFromCart(l.id)}>−</button>
                        <span style={{ fontWeight: 700, fontSize: 15, minWidth: 18, textAlign: "center" }}>{qty}</span>
                        <button className="qty-btn" onClick={() => addToCart(l.id)}>+</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {!loading && filtered.length === 0 && (
          <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "60px 0", color: "#aaa" }}>
            <p style={{ fontSize: 32, marginBottom: 12 }}>🌿</p>
            <p style={{ fontSize: 16 }}>No listings match your search.</p>
          </div>
        )}
      </div>

      {/* Listing detail drawer */}
      {expanded && expanded !== "cart" && (() => {
        const l = listings.find(l => l.id === expanded);
        if (!l) return null;
        const qty   = cart[l.id] || 0;
        const emoji = PRODUCE_EMOJI[l.produce_name] || "🌾";
        const soil  = l.soil_data?.type || "Farm soil";
        return (
          <div className="overlay" onClick={() => setExpanded(null)}>
            <div className="drawer" onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                <div>
                  <p style={{ fontSize: 28 }}>{emoji}</p>
                  <p style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 700, marginTop: 4 }}>{l.produce_name}</p>
                </div>
                <button onClick={() => setExpanded(null)} style={{ background: "#f0ede8", border: "none", borderRadius: "50%", width: 32, height: 32, cursor: "pointer", fontSize: 16 }}>✕</button>
              </div>
              <div style={{ background: "#F6F3EE", borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
                <p style={{ fontWeight: 700, fontSize: 13, color: "#2D6A4F", marginBottom: 6 }}>🧑‍🌾 Know your farmer</p>
                <p style={{ fontSize: 13, color: "#444", lineHeight: 1.6 }}>{l.farmer_name} farms in {l.farmer_village}, {l.farmer_district}.</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
                  {[["Village", l.farmer_village], ["Soil", soil], ["District", l.farmer_district], ["Pesticides", "None"]].map(([k, v]) => (
                    <div key={k}>
                      <p style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase" }}>{k}</p>
                      <p style={{ fontSize: 13, fontWeight: 600, color: "#1C1C1C" }}>{v}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div>
                  <p style={{ fontSize: 26, fontWeight: 700, color: "#2D6A4F", fontFamily: "'Playfair Display',serif" }}>₹{l.price_per_unit}/kg</p>
                  <p style={{ fontSize: 12, color: "#888" }}>{l.quantity_available} kg available · Harvests {formatHarvestDate(l.harvest_date).toLowerCase()}</p>
                </div>
                <div>
                  {qty === 0 ? (
                    <button className="btn-primary" style={{ padding: "10px 24px" }} onClick={() => addToCart(l.id)}>Add to cart</button>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button className="qty-btn" onClick={() => removeFromCart(l.id)}>−</button>
                      <span style={{ fontWeight: 700, fontSize: 16 }}>{qty} kg</span>
                      <button className="qty-btn" onClick={() => addToCart(l.id)}>+</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Cart drawer */}
      {expanded === "cart" && (
        <div className="overlay" onClick={() => setExpanded(null)}>
          <div className="drawer" onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <p style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 700 }}>Your cart 🛒</p>
              <button onClick={() => setExpanded(null)} style={{ background: "#f0ede8", border: "none", borderRadius: "50%", width: 32, height: 32, cursor: "pointer", fontSize: 16 }}>✕</button>
            </div>
            {Object.entries(cart).map(([id, qty]) => {
              const l = listings.find(l => l.id === id);
              if (!l) return null;
              return (
                <div key={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f0ede8" }}>
                  <div>
                    <p style={{ fontWeight: 600 }}>{PRODUCE_EMOJI[l.produce_name] || "🌾"} {l.produce_name}</p>
                    <p style={{ fontSize: 12, color: "#888" }}>{l.farmer_name} · {l.farmer_village}</p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button className="qty-btn" onClick={() => removeFromCart(id)}>−</button>
                    <span style={{ fontWeight: 700 }}>{qty}</span>
                    <button className="qty-btn" onClick={() => addToCart(id)}>+</button>
                    <span style={{ fontWeight: 700, color: "#2D6A4F", minWidth: 52, textAlign: "right" }}>₹{l.price_per_unit * qty}</span>
                  </div>
                </div>
              );
            })}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontWeight: 700, fontSize: 16 }}>
              <span>Total</span>
              <span style={{ color: "#2D6A4F" }}>₹{cartTotal}</span>
            </div>
            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <input id="order-name" type="text" placeholder="Your name"
                style={{ padding: "10px 14px", borderRadius: 10, border: "1.5px solid #D5D0C8", fontSize: 13, fontFamily: "inherit" }} />
              <select id="order-complex"
                style={{ padding: "10px 14px", borderRadius: 10, border: "1.5px solid #D5D0C8", fontSize: 13, fontFamily: "inherit", background: "#fff" }}>
                <option value="">Select your complex</option>
                {COMPLEXES.map(c => <option key={c}>{c}</option>)}
              </select>
              <input id="order-flat" type="text" placeholder="Flat / unit number e.g. B-204"
                style={{ padding: "10px 14px", borderRadius: 10, border: "1.5px solid #D5D0C8", fontSize: 13, fontFamily: "inherit" }} />
            </div>
            <button className="btn-primary" style={{ width: "100%", marginTop: 14, padding: 13, fontSize: 15 }} onClick={placeOrder}>
              Place order · ₹{cartTotal}
            </button>
            <p style={{ fontSize: 11, color: "#aaa", textAlign: "center", marginTop: 8 }}>Delivered via Fresh Cuts to your apartment</p>
          </div>
        </div>
      )}

      {/* Order success */}
      {ordered && (
        <div className="overlay">
          <div className="modal">
            <p style={{ fontSize: 44, marginBottom: 8 }}>🎉</p>
            <p style={{ fontFamily: "'Playfair Display',serif", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Order placed!</p>
            <p style={{ color: "#555", fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>{ordered.join(" · ")}</p>
            <p style={{ color: "#2D6A4F", fontSize: 12, fontWeight: 600, marginBottom: 20 }}>
              Farmer notified · Tempo pickup scheduled · Fresh Cuts will deliver to your building
            </p>
            <button className="btn-primary" style={{ padding: "10px 28px" }} onClick={() => setOrdered(null)}>Continue shopping</button>
          </div>
        </div>
      )}
    </div>
  );
}
// Mon May 25 10:57:02 UTC 2026
