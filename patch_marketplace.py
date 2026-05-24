with open('src/pages/Marketplace.tsx', 'r') as f:
    content = f.read()

# Replace the static import line at the top
content = content.replace(
    'import { useState } from "react";',
    'import { useState, useEffect } from "react";\nimport { supabase } from "../lib/supabase";'
)

# Replace the hardcoded listings array with an empty one + types
old_listings = content[content.find('const listings = ['):content.find('\nconst filters')]
new_listings = '''interface Listing {
  id: string;
  produce_name: string;
  emoji: string;
  farmer_name: string;
  farmer_village: string;
  quantity_available: number;
  unit: string;
  price_per_unit: number;
  harvest_date: string;
  soil_data: { type?: string } | null;
  centroid_lat: number;
  centroid_lng: number;
  status: string;
}

const PRODUCE_EMOJI: Record<string, string> = {
  "Radish": "🌱", "Tomato": "🍅", "Beans": "🫘", "Spinach": "🥬",
  "Drumstick": "🌿", "Brinjal": "🍆", "Cabbage": "🥦", "Carrot": "🥕",
  "Onion": "🧅", "Potato": "🥔", "Cucumber": "🥒", "Bitter Gourd": "🌿",
  "Coriander": "🌿", "Greens": "🥬", "Garlic": "🧄", "Ginger": "🫚",
  "Pumpkin": "🎃", "Cluster Beans": "🫘",
};

'''

content = content.replace(old_listings, new_listings)

# Replace the useState for listings and add useEffect
content = content.replace(
    '  const [activeFilter, setActiveFilter] = useState("All");',
    '''  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState("All");'''
)

# Add useEffect after the useState block
content = content.replace(
    '  const [ordered, setOrdered] = useState(null);',
    '''  const [ordered, setOrdered] = useState<string[] | null>(null);

  useEffect(() => {
    async function fetchListings() {
      setLoading(true);
      const { data, error } = await supabase
        .from("ff_active_listings")
        .select("*");
      if (error) {
        console.error("Error fetching listings:", error);
      } else {
        const mapped = (data || []).map((l: Record<string, unknown>) => ({
          ...l,
          emoji: PRODUCE_EMOJI[l.produce_name as string] || "🌾",
          farmer: l.farmer_name,
          village: l.farmer_village,
          km: 28,
          qty: l.quantity_available,
          price: l.price_per_unit,
          harvestDate: formatHarvestDate(l.harvest_date as string),
          soil: (l.soil_data as { type?: string } | null)?.type || "Farm soil",
          pesticide: false,
          since: "2025",
          tags: [],
          story: `${l.farmer_name} farms in ${l.farmer_village}.`,
        }));
        setListings(mapped as unknown as Listing[]);
      }
      setLoading(false);
    }
    fetchListings();
  }, []);'''
)

# Add formatHarvestDate helper before the component
content = content.replace(
    'export default function FarmFeast()',
    '''function formatHarvestDate(isoDate: string): string {
  const today    = new Date();
  const harvest  = new Date(isoDate);
  today.setHours(0,0,0,0);
  harvest.setHours(0,0,0,0);
  const diff = Math.round((harvest.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff <= 7)  return `In ${diff} days`;
  return harvest.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export default function FarmFeast()'''
)

# Add loading state in the grid section
content = content.replace(
    '      {/* Grid */}',
    '''      {/* Loading */}
      {loading && (
        <div style={{ textAlign: "center", padding: "60px 0", color: "#95D5B2" }}>
          <p style={{ fontSize: 32 }}>🌾</p>
          <p style={{ fontSize: 14, marginTop: 8 }}>Fetching fresh listings...</p>
        </div>
      )}

      {/* Grid */}'''
)

with open('src/pages/Marketplace.tsx', 'w') as f:
    f.write(content)

print("Done")
