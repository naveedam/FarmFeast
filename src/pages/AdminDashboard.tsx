import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";

// ── Types ──────────────────────────────────────────────────────
interface Order {
  id: string;
  listing_id: string;
  farmer_id: string;
  quantity: number;
  unit: string;
  price_per_unit: number;
  total_amount: number;
  commission_amount: number;
  farmer_payout: number;
  delivery_address: string;
  notes: string;
  status: string;
  payment_status: string;
  created_at: string;
  produce_name?: string;
  farmer_name?: string;
  farmer_mobile?: string;
}

interface ComplexSummary {
  complex: string;
  order_count: number;
  total_kg: number;
  total_revenue: number;
}

interface HarvestSummary {
  produce_name: string;
  farmer_name: string;
  farmer_village: string;
  total_kg: number;
  order_count: number;
}

interface FarmerPayout {
  farmer_name: string;
  farmer_village: string;
  farmer_mobile: string;
  total_orders: number;
  total_kg: number;
  gross_revenue: number;
  commission: number;
  net_payout: number;
}

const STATUS_FLOW = ["pending", "confirmed", "pickup_scheduled", "at_hub", "out_for_delivery", "delivered"];
const STATUS_LABELS: Record<string, string> = {
  pending:           "⏳ Pending",
  confirmed:         "✅ Confirmed",
  pickup_scheduled:  "🚜 Pickup Scheduled",
  at_hub:            "🏪 At Hub",
  out_for_delivery:  "🛵 Out for Delivery",
  delivered:         "🎉 Delivered",
  cancelled:         "❌ Cancelled",
};
const STATUS_COLORS: Record<string, string> = {
  pending:           "#F59E0B",
  confirmed:         "#3B82F6",
  pickup_scheduled:  "#8B5CF6",
  at_hub:            "#EC4899",
  out_for_delivery:  "#F97316",
  delivered:         "#10B981",
  cancelled:         "#EF4444",
};

const TWILIO_WA_NUMBER = "whatsapp:+14155238886";

// ── Status update message templates ───────────────────────────
function statusMessage(status: string, order: Order): string {
  const produce = order.produce_name || "produce";
  const qty     = order.quantity;
  switch (status) {
    case "confirmed":
      return `✅ FarmFeast: Your order of ${qty}kg ${produce} is confirmed! We'll notify you when it's on the way. 🌾`;
    case "pickup_scheduled":
      return `🚜 FarmFeast: Our tempo is heading to the farm to pick up your ${qty}kg ${produce}. Fresh harvest incoming!`;
    case "at_hub":
      return `🏪 FarmFeast: Your ${qty}kg ${produce} has reached our hub and is being packed for delivery.`;
    case "out_for_delivery":
      return `🛵 FarmFeast: Your ${qty}kg ${produce} is out for delivery! Check with your building security if you're not home. 🌾`;
    case "delivered":
      return `🎉 FarmFeast: Your ${qty}kg ${produce} has been delivered! Enjoy the freshness. Rate us: farm-feast-liart.vercel.app 🍅`;
    default:
      return `FarmFeast: Your order status has been updated to ${status}.`;
  }
}

// ── Main component ─────────────────────────────────────────────
export default function AdminDashboard() {
  const [orders, setOrders]         = useState<Order[]>([]);
  const [loading, setLoading]       = useState(true);
  const [activeTab, setActiveTab]   = useState<"orders" | "harvest" | "complexes" | "payouts">("orders");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [toast, setToast]           = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState("all");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    // Join orders with listings and farmers
    const { data, error } = await supabase
      .from("ff_orders")
      .select(`
        *,
        ff_listings ( produce_name ),
        ff_farmers  ( name, mobile, village )
      `)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Fetch error:", error);
    } else {
      const mapped = (data || []).map((o: Record<string, unknown>) => ({
        ...(o as object),
        produce_name:  (o.ff_listings as Record<string,string>)?.produce_name,
        farmer_name:   (o.ff_farmers  as Record<string,string>)?.name,
        farmer_mobile: (o.ff_farmers  as Record<string,string>)?.mobile,
        farmer_village:(o.ff_farmers  as Record<string,string>)?.village,
      })) as Order[];
      setOrders(mapped);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  // Real-time updates
  useEffect(() => {
    const channel = supabase
      .channel("ff_orders_changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "ff_orders" }, () => {
        fetchOrders();
        showToast("📦 New order received!");
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchOrders]);

  async function updateStatus(order: Order, newStatus: string) {
    setUpdatingId(order.id);
    const { error } = await supabase
      .from("ff_orders")
      .update({ status: newStatus })
      .eq("id", order.id);

    if (error) {
      showToast("❌ Failed to update status");
      setUpdatingId(null);
      return;
    }

    // Send WhatsApp notification via Edge Function
    try {
      await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ff-notify-customer`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            to:      `whatsapp:${order.notes}`,  // notes stores customer name; use mobile in prod
            message: statusMessage(newStatus, order),
          }),
        }
      );
    } catch (e) {
      console.warn("WhatsApp notify failed (non-fatal):", e);
    }

    showToast(`✅ Status → ${STATUS_LABELS[newStatus]}`);
    setUpdatingId(null);
    fetchOrders();
  }

  // ── Computed summaries ───────────────────────────────────────
  const complexSummaries: ComplexSummary[] = Object.values(
    orders.reduce((acc: Record<string, ComplexSummary>, o) => {
      const complex = o.delivery_address?.split(",")?.[1]?.trim() || "Unknown";
      if (!acc[complex]) acc[complex] = { complex, order_count: 0, total_kg: 0, total_revenue: 0 };
      acc[complex].order_count++;
      acc[complex].total_kg      += o.quantity;
      acc[complex].total_revenue += o.total_amount;
      return acc;
    }, {})
  ).sort((a, b) => b.total_revenue - a.total_revenue);

  const harvestSummaries: HarvestSummary[] = Object.values(
    orders
      .filter(o => o.status !== "cancelled")
      .reduce((acc: Record<string, HarvestSummary>, o) => {
        const key = `${o.produce_name}-${o.farmer_id}`;
        if (!acc[key]) acc[key] = {
          produce_name:   o.produce_name || "Unknown",
          farmer_name:    o.farmer_name  || "Unknown",
          farmer_village: "",
          total_kg:       0,
          order_count:    0,
        };
        acc[key].total_kg    += o.quantity;
        acc[key].order_count++;
        return acc;
      }, {})
  ).sort((a, b) => b.total_kg - a.total_kg);

  const farmerPayouts: FarmerPayout[] = Object.values(
    orders
      .filter(o => o.status !== "cancelled")
      .reduce((acc: Record<string, FarmerPayout>, o) => {
        const key = o.farmer_id;
        if (!acc[key]) acc[key] = {
          farmer_name:    o.farmer_name   || "Unknown",
          farmer_village: "",
          farmer_mobile:  o.farmer_mobile || "",
          total_orders:   0,
          total_kg:       0,
          gross_revenue:  0,
          commission:     0,
          net_payout:     0,
        };
        acc[key].total_orders++;
        acc[key].total_kg      += o.quantity;
        acc[key].gross_revenue += o.total_amount;
        acc[key].commission    += o.commission_amount || o.total_amount * 0.07;
        acc[key].net_payout    += o.farmer_payout    || o.total_amount * 0.93;
        return acc;
      }, {})
  );

  const totalRevenue  = orders.filter(o => o.status !== "cancelled").reduce((s, o) => s + o.total_amount, 0);
  const totalKg       = orders.filter(o => o.status !== "cancelled").reduce((s, o) => s + o.quantity, 0);
  const totalPending  = orders.filter(o => o.status === "pending").length;
  const totalDelivered = orders.filter(o => o.status === "delivered").length;

  const filteredOrders = filterStatus === "all"
    ? orders
    : orders.filter(o => o.status === filterStatus);

  return (
    <div style={{ fontFamily: "'DM Sans','Segoe UI',sans-serif", background: "#F6F3EE", minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Playfair+Display:wght@600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .tab { padding: 8px 18px; border-radius: 100px; border: 1.5px solid #D5D0C8; background: #fff; color: #555; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all 0.15s; }
        .tab.active { background: #1A3C2A; border-color: #1A3C2A; color: #fff; }
        .card { background: #fff; border-radius: 16px; padding: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .status-badge { display: inline-block; border-radius: 100px; font-size: 11px; font-weight: 700; padding: 3px 10px; }
        .btn-sm { border: none; border-radius: 8px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
        .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #1A3C2A; color: #fff; padding: 12px 24px; border-radius: 100px; font-size: 14px; font-weight: 600; z-index: 999; }
      `}</style>

      {/* Header */}
      <div style={{ background: "#1A3C2A", padding: "0 24px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 20 }}>🌾</span>
            <span style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 700, color: "#fff" }}>FarmFeast</span>
            <span style={{ background: "#52B788", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 6, padding: "2px 8px" }}>ADMIN</span>
          </div>
          <button onClick={fetchOrders} style={{ background: "transparent", border: "1px solid #52B788", color: "#95D5B2", borderRadius: 8, padding: "6px 14px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px" }}>

        {/* KPI cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 16, marginBottom: 24 }}>
          {[
            { label: "Total Orders",    value: orders.length,           emoji: "📦", color: "#3B82F6" },
            { label: "Pending",         value: totalPending,            emoji: "⏳", color: "#F59E0B" },
            { label: "Delivered",       value: totalDelivered,          emoji: "🎉", color: "#10B981" },
            { label: "Total kg",        value: `${totalKg} kg`,         emoji: "⚖️", color: "#8B5CF6" },
            { label: "Revenue",         value: `₹${totalRevenue}`,      emoji: "💰", color: "#EC4899" },
          ].map(k => (
            <div key={k.label} className="card" style={{ borderTop: `3px solid ${k.color}` }}>
              <p style={{ fontSize: 24, marginBottom: 4 }}>{k.emoji}</p>
              <p style={{ fontSize: 26, fontWeight: 700, color: k.color, fontFamily: "'Playfair Display',serif" }}>{k.value}</p>
              <p style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{k.label}</p>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {(["orders","harvest","complexes","payouts"] as const).map(t => (
            <button key={t} className={`tab${activeTab === t ? " active" : ""}`} onClick={() => setActiveTab(t)}>
              {t === "orders" ? "📦 Orders" : t === "harvest" ? "🌾 Harvest Plan" : t === "complexes" ? "🏢 By Complex" : "💰 Farmer Payouts"}
            </button>
          ))}
        </div>

        {loading && <div style={{ textAlign: "center", padding: 40, color: "#2D6A4F" }}>Loading... 🌾</div>}

        {/* ── ORDERS TAB ───────────────────────────────────────── */}
        {!loading && activeTab === "orders" && (
          <div>
            {/* Status filter */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
              {["all", ...STATUS_FLOW].map(s => (
                <button key={s} onClick={() => setFilterStatus(s)}
                  style={{ padding: "4px 12px", borderRadius: 100, border: `1.5px solid ${s === filterStatus ? (STATUS_COLORS[s] || "#1A3C2A") : "#D5D0C8"}`,
                    background: s === filterStatus ? (STATUS_COLORS[s] || "#1A3C2A") : "#fff",
                    color: s === filterStatus ? "#fff" : "#555", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                  {s === "all" ? "All" : STATUS_LABELS[s]}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {filteredOrders.map(o => {
                const nextStatus = STATUS_FLOW[STATUS_FLOW.indexOf(o.status) + 1];
                const address    = o.delivery_address || "";
                const flat       = address.split(",")?.[0]?.trim();
                const complex    = address.split(",")?.[1]?.trim();

                return (
                  <div key={o.id} className="card" style={{ borderLeft: `4px solid ${STATUS_COLORS[o.status] || "#ccc"}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <span className="status-badge" style={{ background: (STATUS_COLORS[o.status] || "#ccc") + "22", color: STATUS_COLORS[o.status] || "#ccc" }}>
                            {STATUS_LABELS[o.status] || o.status}
                          </span>
                          <span style={{ fontSize: 11, color: "#aaa" }}>{new Date(o.created_at).toLocaleString("en-IN")}</span>
                        </div>
                        <p style={{ fontWeight: 700, fontSize: 15 }}>
                          {o.produce_name || "—"} · {o.quantity} kg · ₹{o.total_amount}
                        </p>
                        <p style={{ fontSize: 13, color: "#555", marginTop: 3 }}>
                          👤 {o.notes} · 🏢 {complex} · 🚪 {flat}
                        </p>
                        <p style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                          🧑‍🌾 {o.farmer_name || "—"} · ₹{o.price_per_unit}/kg
                        </p>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {nextStatus && (
                          <button className="btn-sm"
                            disabled={updatingId === o.id}
                            onClick={() => updateStatus(o, nextStatus)}
                            style={{ background: STATUS_COLORS[nextStatus], color: "#fff", opacity: updatingId === o.id ? 0.6 : 1 }}>
                            {updatingId === o.id ? "..." : `→ ${STATUS_LABELS[nextStatus]}`}
                          </button>
                        )}
                        {o.status !== "cancelled" && o.status !== "delivered" && (
                          <button className="btn-sm" onClick={() => updateStatus(o, "cancelled")}
                            style={{ background: "#FEE2E2", color: "#EF4444" }}>
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredOrders.length === 0 && (
                <div style={{ textAlign: "center", padding: 40, color: "#aaa" }}>
                  <p style={{ fontSize: 32 }}>📭</p>
                  <p style={{ marginTop: 8 }}>No orders with this status</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── HARVEST PLAN TAB ─────────────────────────────────── */}
        {!loading && activeTab === "harvest" && (
          <div>
            <p style={{ fontSize: 13, color: "#888", marginBottom: 16 }}>Total produce to harvest across all active orders</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 16 }}>
              {harvestSummaries.map(h => (
                <div key={`${h.produce_name}-${h.farmer_name}`} className="card" style={{ borderTop: "3px solid #2D6A4F" }}>
                  <p style={{ fontSize: 28, marginBottom: 8 }}>🌾</p>
                  <p style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 700, color: "#1A3C2A" }}>{h.produce_name}</p>
                  <p style={{ fontSize: 13, color: "#555", marginTop: 4 }}>👨‍🌾 {h.farmer_name}</p>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, padding: "12px 0", borderTop: "1px solid #f0ede8" }}>
                    <div>
                      <p style={{ fontSize: 22, fontWeight: 700, color: "#2D6A4F" }}>{h.total_kg} kg</p>
                      <p style={{ fontSize: 11, color: "#888" }}>to harvest</p>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <p style={{ fontSize: 22, fontWeight: 700, color: "#555" }}>{h.order_count}</p>
                      <p style={{ fontSize: 11, color: "#888" }}>orders</p>
                    </div>
                  </div>
                </div>
              ))}
              {harvestSummaries.length === 0 && (
                <div style={{ gridColumn: "1/-1", textAlign: "center", padding: 40, color: "#aaa" }}>
                  <p style={{ fontSize: 32 }}>🌱</p>
                  <p style={{ marginTop: 8 }}>No harvest needed yet</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── BY COMPLEX TAB ───────────────────────────────────── */}
        {!loading && activeTab === "complexes" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {complexSummaries.map(c => (
              <div key={c.complex} className="card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <p style={{ fontFamily: "'Playfair Display',serif", fontSize: 18, fontWeight: 700 }}>🏢 {c.complex}</p>
                    <p style={{ fontSize: 13, color: "#555", marginTop: 4 }}>{c.order_count} orders · {c.total_kg} kg total</p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ fontSize: 22, fontWeight: 700, color: "#2D6A4F", fontFamily: "'Playfair Display',serif" }}>₹{c.total_revenue}</p>
                    <p style={{ fontSize: 11, color: "#888" }}>revenue</p>
                  </div>
                </div>
                {/* Mini order list for this complex */}
                <div style={{ marginTop: 12, borderTop: "1px solid #f0ede8", paddingTop: 12 }}>
                  {orders.filter(o => o.delivery_address?.includes(c.complex)).map(o => {
                    const flat = o.delivery_address?.split(",")?.[0]?.trim();
                    return (
                      <div key={o.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, borderBottom: "1px solid #f9f7f4" }}>
                        <span>🚪 {flat} · {o.notes} · {o.produce_name} {o.quantity}kg</span>
                        <span className="status-badge" style={{ background: (STATUS_COLORS[o.status] || "#ccc") + "22", color: STATUS_COLORS[o.status] || "#ccc" }}>
                          {STATUS_LABELS[o.status]}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {complexSummaries.length === 0 && (
              <div style={{ textAlign: "center", padding: 40, color: "#aaa" }}>
                <p style={{ fontSize: 32 }}>🏢</p>
                <p style={{ marginTop: 8 }}>No orders yet</p>
              </div>
            )}
          </div>
        )}

        {/* ── FARMER PAYOUTS TAB ───────────────────────────────── */}
        {!loading && activeTab === "payouts" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {farmerPayouts.map(f => (
              <div key={f.farmer_name} className="card" style={{ borderLeft: "4px solid #52B788" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <p style={{ fontFamily: "'Playfair Display',serif", fontSize: 18, fontWeight: 700 }}>🧑‍🌾 {f.farmer_name}</p>
                    <p style={{ fontSize: 13, color: "#555", marginTop: 3 }}>{f.total_orders} orders · {f.total_kg} kg sold</p>
                    {f.farmer_mobile && <p style={{ fontSize: 12, color: "#888", marginTop: 2 }}>📱 {f.farmer_mobile}</p>}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <p style={{ fontSize: 22, fontWeight: 700, color: "#2D6A4F", fontFamily: "'Playfair Display',serif" }}>₹{Math.round(f.net_payout)}</p>
                    <p style={{ fontSize: 11, color: "#888" }}>net payout</p>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 16, padding: "12px 0", borderTop: "1px solid #f0ede8" }}>
                  {[
                    ["Gross", `₹${Math.round(f.gross_revenue)}`],
                    ["Commission (7%)", `₹${Math.round(f.commission)}`],
                    ["Net to farmer", `₹${Math.round(f.net_payout)}`],
                  ].map(([label, val]) => (
                    <div key={label} style={{ textAlign: "center" }}>
                      <p style={{ fontSize: 16, fontWeight: 700, color: "#1A3C2A" }}>{val}</p>
                      <p style={{ fontSize: 11, color: "#888" }}>{label}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {farmerPayouts.length === 0 && (
              <div style={{ textAlign: "center", padding: 40, color: "#aaa" }}>
                <p style={{ fontSize: 32 }}>💰</p>
                <p style={{ marginTop: 8 }}>No payouts yet</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
