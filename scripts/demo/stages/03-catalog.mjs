// Stage 3 — the operating catalogue: stock locations, suppliers, inventory
// items with opening stock, POS outlets, tables, menu categories and menu
// items.
//
// Inventory items are created through the import_inventory_item() RPC — the
// same function the Inventory import screen calls. It creates the item, its
// category, the opening stock row and (for perishables) the first expiry
// batch in one authorised, duplicate-safe call, which also makes this stage
// rerunnable: a second run reports every SKU as a skipped duplicate.
//
// Menu items are linked to inventory items wherever a sale should actually
// move stock — close_pos_order() deducts the linked item automatically.

import { ensureByKey } from "../lib/env.mjs";
import { day } from "../lib/random.mjs";

export const STOCK_LOCATIONS = [
  { name: "Main Store", kind: "store" },
  { name: "Kitchen Store", kind: "kitchen" },
  { name: "Bar Store", kind: "bar" },
  { name: "Housekeeping Store", kind: "housekeeping" },
];

export const SUPPLIERS = [
  { vendor_code: "SUP-001", name: "Accra Fresh Foods Ltd", contact_name: "Yaw Boadu", email: "sales@accrafresh.example", phone: "+233 30 000 1201", address: "12 Spintex Road, Accra", payment_terms: "Net 30", vendor_type: "goods" },
  { vendor_code: "SUP-002", name: "Gold Coast Beverages", contact_name: "Ama Serwaa", email: "orders@goldcoastbev.example", phone: "+233 30 000 1202", address: "8 Ring Road East, Accra", payment_terms: "Net 14", vendor_type: "goods" },
  { vendor_code: "SUP-003", name: "Volta Linen & Laundry Supplies", contact_name: "Elikem Dogbe", email: "hello@voltalinen.example", phone: "+233 30 000 1203", address: "44 Liberation Road, Accra", payment_terms: "Net 30", vendor_type: "goods" },
  { vendor_code: "SUP-004", name: "Ashanti Hotel Amenities", contact_name: "Akosua Frimpong", email: "supply@ashantiamenities.example", phone: "+233 30 000 1204", address: "3 Osu Badu Street, Accra", payment_terms: "Net 21", vendor_type: "goods" },
  { vendor_code: "SUP-005", name: "Tema Cold Chain Distributors", contact_name: "Ibrahim Alhassan", email: "dispatch@temacoldchain.example", phone: "+233 30 000 1205", address: "Harbour Road, Tema", payment_terms: "Net 15", vendor_type: "goods" },
  { vendor_code: "SUP-006", name: "Sunyani Facilities Services", contact_name: "Kojo Baffour", email: "contracts@sunyanifacilities.example", phone: "+233 30 000 1206", address: "17 Airport Hills Close, Accra", payment_terms: "Net 30", vendor_type: "services" },
];

export const ITEM_CATEGORIES = [
  "Beverages — Soft", "Beverages — Alcoholic", "Food — Dry Goods", "Food — Fresh",
  "Housekeeping Supplies", "Guest Amenities", "Maintenance", "Stationery",
];

// [sku, name, category, unit, cost, sale, reorder, location, opening qty, shelf life in days or null]
export const INVENTORY_ITEMS = [
  ["BEV-001", "Bottled Water 500ml", "Beverages — Soft", "bottle", 2.4, 8, 240, "Bar Store", 600, 540],
  ["BEV-002", "Bottled Water 1.5L", "Beverages — Soft", "bottle", 4.2, 14, 120, "Bar Store", 300, 540],
  ["BEV-003", "Cola 330ml Can", "Beverages — Soft", "can", 3.6, 12, 180, "Bar Store", 420, 300],
  ["BEV-004", "Orange Juice 1L", "Beverages — Soft", "carton", 9.5, 26, 60, "Kitchen Store", 140, 90],
  ["BEV-005", "Pineapple Juice 1L", "Beverages — Soft", "carton", 9.2, 26, 60, "Kitchen Store", 120, 90],
  ["BEV-006", "Ginger Ale 330ml", "Beverages — Soft", "can", 4.1, 14, 96, "Bar Store", 180, 300],
  ["BEV-007", "Tonic Water 200ml", "Beverages — Soft", "bottle", 3.8, 13, 96, "Bar Store", 220, 300],
  ["BEV-008", "Espresso Beans 1kg", "Beverages — Soft", "kg", 96, 0, 12, "Kitchen Store", 40, 365],
  ["ALC-001", "Local Lager 330ml", "Beverages — Alcoholic", "bottle", 7.5, 22, 240, "Bar Store", 480, 240],
  ["ALC-002", "Premium Lager 330ml", "Beverages — Alcoholic", "bottle", 9.8, 28, 180, "Bar Store", 360, 240],
  ["ALC-003", "House Red Wine 750ml", "Beverages — Alcoholic", "bottle", 62, 180, 24, "Bar Store", 72, 900],
  ["ALC-004", "House White Wine 750ml", "Beverages — Alcoholic", "bottle", 60, 175, 24, "Bar Store", 66, 900],
  ["ALC-005", "Sparkling Wine 750ml", "Beverages — Alcoholic", "bottle", 130, 340, 12, "Bar Store", 36, 900],
  ["ALC-006", "Blended Whisky 700ml", "Beverages — Alcoholic", "bottle", 210, 60, 8, "Bar Store", 24, null],
  ["ALC-007", "Gin 700ml", "Beverages — Alcoholic", "bottle", 165, 48, 8, "Bar Store", 21, null],
  ["ALC-008", "Dark Rum 700ml", "Beverages — Alcoholic", "bottle", 150, 45, 8, "Bar Store", 18, null],
  ["FDD-001", "Long Grain Rice 25kg", "Food — Dry Goods", "bag", 420, 0, 6, "Kitchen Store", 18, 540],
  ["FDD-002", "Cooking Oil 20L", "Food — Dry Goods", "jerrycan", 380, 0, 4, "Kitchen Store", 12, 365],
  ["FDD-003", "Wheat Flour 50kg", "Food — Dry Goods", "bag", 560, 0, 4, "Kitchen Store", 9, 300],
  ["FDD-004", "Granulated Sugar 25kg", "Food — Dry Goods", "bag", 310, 0, 4, "Kitchen Store", 10, 720],
  ["FDD-005", "Table Salt 1kg", "Food — Dry Goods", "pack", 8, 0, 24, "Kitchen Store", 60, 900],
  ["FDD-006", "Tomato Paste 2.2kg", "Food — Dry Goods", "tin", 78, 0, 12, "Kitchen Store", 36, 540],
  ["FDF-001", "Chicken Breast (fresh)", "Food — Fresh", "kg", 62, 0, 30, "Kitchen Store", 90, 7],
  ["FDF-002", "Beef Fillet (fresh)", "Food — Fresh", "kg", 145, 0, 15, "Kitchen Store", 45, 7],
  ["FDF-003", "Red Snapper (fresh)", "Food — Fresh", "kg", 98, 0, 15, "Kitchen Store", 36, 4],
  ["FDF-004", "Tilapia (fresh)", "Food — Fresh", "kg", 72, 0, 15, "Kitchen Store", 40, 4],
  ["FDF-005", "Mixed Vegetables", "Food — Fresh", "kg", 26, 0, 25, "Kitchen Store", 70, 6],
  ["FDF-006", "Fresh Fruit Platter Mix", "Food — Fresh", "kg", 34, 0, 20, "Kitchen Store", 55, 5],
  ["FDF-007", "Dairy Milk 1L", "Food — Fresh", "carton", 14, 0, 40, "Kitchen Store", 120, 21],
  ["FDF-008", "Butter 500g", "Food — Fresh", "pack", 46, 0, 18, "Kitchen Store", 48, 45],
  ["FDF-009", "Eggs (crate of 30)", "Food — Fresh", "crate", 58, 0, 12, "Kitchen Store", 36, 24],
  ["HKS-001", "Laundry Detergent 20L", "Housekeeping Supplies", "jerrycan", 240, 0, 4, "Housekeeping Store", 12, 720],
  ["HKS-002", "Floor Cleaner 5L", "Housekeeping Supplies", "bottle", 78, 0, 8, "Housekeeping Store", 24, 720],
  ["HKS-003", "Glass Cleaner 750ml", "Housekeeping Supplies", "bottle", 22, 0, 18, "Housekeeping Store", 48, 720],
  ["HKS-004", "Disinfectant 5L", "Housekeeping Supplies", "bottle", 96, 0, 8, "Housekeeping Store", 20, 540],
  ["HKS-005", "Bath Towel (white)", "Housekeeping Supplies", "piece", 68, 0, 60, "Housekeeping Store", 260, null],
  ["HKS-006", "Bed Sheet Queen (white)", "Housekeeping Supplies", "piece", 145, 0, 40, "Housekeeping Store", 180, null],
  ["HKS-007", "Pillow Case (white)", "Housekeeping Supplies", "piece", 38, 0, 80, "Housekeeping Store", 340, null],
  ["AMN-001", "Shower Gel 40ml", "Guest Amenities", "piece", 3.2, 0, 200, "Housekeeping Store", 900, 900],
  ["AMN-002", "Shampoo 40ml", "Guest Amenities", "piece", 3.2, 0, 200, "Housekeeping Store", 880, 900],
  ["AMN-003", "Body Lotion 40ml", "Guest Amenities", "piece", 3.6, 0, 150, "Housekeeping Store", 640, 900],
  ["AMN-004", "Bar Soap 25g", "Guest Amenities", "piece", 1.8, 0, 250, "Housekeeping Store", 1100, 900],
  ["AMN-005", "Dental Kit", "Guest Amenities", "piece", 4.5, 0, 150, "Housekeeping Store", 520, null],
  ["AMN-006", "Slippers (pair)", "Guest Amenities", "pair", 12, 0, 100, "Housekeeping Store", 380, null],
  ["AMN-007", "Sewing Kit", "Guest Amenities", "piece", 5.5, 0, 60, "Housekeeping Store", 210, null],
  ["MNT-001", "LED Bulb 9W", "Maintenance", "piece", 18, 0, 40, "Main Store", 140, null],
  ["MNT-002", "Air Filter (split unit)", "Maintenance", "piece", 85, 0, 12, "Main Store", 36, null],
  ["MNT-003", "Plumbing Seal Kit", "Maintenance", "kit", 42, 0, 10, "Main Store", 28, null],
  ["MNT-004", "Paint — Interior White 4L", "Maintenance", "tin", 210, 0, 6, "Main Store", 14, 730],
  ["STA-001", "Guest Folio Paper (roll)", "Stationery", "roll", 16, 0, 30, "Main Store", 90, null],
  ["STA-002", "Key Card (blank)", "Stationery", "piece", 6.5, 0, 100, "Main Store", 400, null],
  ["STA-003", "A4 Paper Ream", "Stationery", "ream", 48, 0, 20, "Main Store", 60, null],
];

export const OUTLETS = [
  { name: "The Grand Restaurant", kind: "restaurant", tax_rate: 10 },
  { name: "Skyline Bar", kind: "bar", tax_rate: 10 },
  { name: "In-Room Dining", kind: "room_service", tax_rate: 10 },
];

// outlet → category → [name, price, linked inventory sku|null, description]
export const MENU = {
  "The Grand Restaurant": {
    Breakfast: [
      ["Continental Breakfast", 95, null], ["Full Ghanaian Breakfast", 130, null],
      ["Omelette Station", 85, "FDF-009"], ["Fresh Fruit Plate", 65, "FDF-006"],
    ],
    Starters: [
      ["Groundnut Soup Cup", 55, null], ["Kelewele Bowl", 48, null],
      ["Garden Salad", 60, "FDF-005"], ["Fish Goujons", 78, "FDF-004"],
    ],
    "Main Courses": [
      ["Jollof Rice with Grilled Chicken", 165, "FDF-001"], ["Grilled Red Snapper", 220, "FDF-003"],
      ["Beef Fillet with Pepper Sauce", 285, "FDF-002"], ["Banku with Tilapia", 175, "FDF-004"],
      ["Vegetable Pasta", 140, "FDF-005"], ["Waakye Special", 120, null],
      ["Club Sandwich & Fries", 130, null],
    ],
    Desserts: [["Chocolate Fondant", 75, null], ["Seasonal Fruit Salad", 60, "FDF-006"], ["Ice Cream (2 scoops)", 55, "FDF-007"]],
    "Hot Drinks": [["Espresso", 35, "BEV-008"], ["Cappuccino", 45, "BEV-008"], ["Pot of Tea", 30, null]],
    "Soft Drinks": [["Bottled Water 500ml", 20, "BEV-001"], ["Cola 330ml", 25, "BEV-003"], ["Fresh Orange Juice", 45, "BEV-004"]],
  },
  "Skyline Bar": {
    Beers: [["Local Lager", 35, "ALC-001"], ["Premium Lager", 45, "ALC-002"]],
    Wines: [["House Red (glass)", 60, "ALC-003"], ["House White (glass)", 58, "ALC-004"], ["Sparkling (bottle)", 420, "ALC-005"]],
    Spirits: [["Whisky (single)", 70, "ALC-006"], ["Gin & Tonic", 65, "ALC-007"], ["Rum & Cola", 62, "ALC-008"]],
    "Bar Snacks": [["Spiced Peanuts", 30, null], ["Chicken Wings", 95, "FDF-001"], ["Loaded Fries", 75, null]],
    "Soft Drinks": [["Bottled Water 500ml", 20, "BEV-001"], ["Ginger Ale", 28, "BEV-006"], ["Tonic Water", 26, "BEV-007"]],
  },
  "In-Room Dining": {
    "All Day": [
      ["Club Sandwich", 140, null], ["Jollof Rice with Chicken", 175, "FDF-001"],
      ["Chef's Soup of the Day", 65, null], ["Cheese & Fruit Platter", 130, "FDF-006"],
    ],
    Beverages: [["Bottled Water 1.5L", 30, "BEV-002"], ["Pot of Coffee", 55, "BEV-008"], ["Fresh Juice", 50, "BEV-005"]],
  },
};

export async function run({ ctx, admin, log }) {
  const pid = ctx.propertyId;
  if (ctx.dryRun) {
    log(`  · would ensure ${STOCK_LOCATIONS.length} stock locations, ${SUPPLIERS.length} suppliers,`);
    log(`    ${INVENTORY_ITEMS.length} inventory items with opening stock, ${OUTLETS.length} outlets and their menus`);
    return {};
  }

  const locations = await ensureByKey(
    admin, "stock_locations", `select=*&property_id=eq.${pid}`,
    STOCK_LOCATIONS.map((l) => ({ ...l, property_id: pid })), (r) => r.name,
  );
  log(`  · stock locations: ${locations.created} created, ${locations.existing} already present`);

  const suppliers = await ensureByKey(
    admin, "suppliers", `select=*&property_id=eq.${pid}`,
    SUPPLIERS.map((s) => ({ ...s, property_id: pid, active: true })), (r) => r.vendor_code,
  );
  log(`  · suppliers: ${suppliers.created} created, ${suppliers.existing} already present`);

  const categories = await ensureByKey(
    admin, "item_categories", `select=*&property_id=eq.${pid}`,
    ITEM_CATEGORIES.map((name) => ({ property_id: pid, name })), (r) => r.name,
  );
  log(`  · item categories: ${categories.created} created, ${categories.existing} already present`);

  // Inventory items through the canonical import RPC (idempotent by SKU).
  let created = 0;
  let skipped = 0;
  for (const [sku, name, category, unit, cost, sale, reorder, location, opening, shelfLife] of INVENTORY_ITEMS) {
    const result = await admin.rpc("import_inventory_item", {
      _property_id: pid,
      _name: name,
      _sku: sku,
      _category: category,
      _unit: unit,
      _cost: cost,
      _sale_price: sale,
      _reorder_level: reorder,
      _location_name: location,
      _opening_quantity: opening,
      // Opening stock was received before the demo window opens; perishables
      // carry an expiry derived from their shelf life so the expiry report and
      // the near-expiry warnings have something real to show.
      _expiry_date: shelfLife ? day(ctx.asOf, Math.round(shelfLife * 0.55) - 30) : null,
    });
    if (result?.created === false || result?.skipped) skipped++;
    else created++;
  }
  log(`  · inventory items: ${created} imported, ${skipped} already present (duplicate SKU)`);

  // ── POS ───────────────────────────────────────────────────────────────────
  const outlets = await ensureByKey(
    admin, "pos_outlets", `select=*&property_id=eq.${pid}`,
    OUTLETS.map((o) => ({ ...o, property_id: pid, active: true })), (r) => r.name,
  );
  log(`  · outlets: ${outlets.created} created, ${outlets.existing} already present`);
  const outletByName = new Map(outlets.rows.map((o) => [o.name, o]));

  const tableRows = [
    ...Array.from({ length: 12 }, (_, i) => ({
      property_id: pid, outlet_id: outletByName.get("The Grand Restaurant").id,
      label: `R${String(i + 1).padStart(2, "0")}`, seats: i % 4 === 3 ? 6 : 4, status: "free",
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      property_id: pid, outlet_id: outletByName.get("Skyline Bar").id,
      label: `B${String(i + 1).padStart(2, "0")}`, seats: i % 3 === 0 ? 2 : 4, status: "free",
    })),
  ];
  const tables = await ensureByKey(admin, "pos_tables", `select=*&property_id=eq.${pid}`, tableRows, (r) => r.label);
  log(`  · POS tables: ${tables.created} created, ${tables.existing} already present`);

  const items = await admin.select("inventory_items", `select=id,sku&property_id=eq.${pid}`);
  const itemBySku = new Map(items.map((i) => [i.sku, i.id]));

  const existingCategories = await admin.select("pos_menu_categories", `select=*&property_id=eq.${pid}`);
  const catKey = (r) => `${r.outlet_id}::${r.name}`;
  const haveCats = new Set(existingCategories.map(catKey));
  const newCats = [];
  for (const [outletName, groups] of Object.entries(MENU)) {
    const outletId = outletByName.get(outletName).id;
    let sort = 0;
    for (const name of Object.keys(groups)) {
      const row = { property_id: pid, outlet_id: outletId, name, sort: sort++ };
      if (!haveCats.has(catKey(row))) newCats.push(row);
    }
  }
  const allCats = [...existingCategories, ...(newCats.length ? await admin.insert("pos_menu_categories", newCats) : [])];
  log(`  · menu categories: ${newCats.length} created, ${existingCategories.length} already present`);
  const catByKey = new Map(allCats.map((c) => [catKey(c), c]));

  const existingItems = await admin.select("pos_menu_items", `select=*&property_id=eq.${pid}`);
  const itemKey = (r) => `${r.outlet_id}::${r.name}`;
  const haveItems = new Set(existingItems.map(itemKey));
  const newItems = [];
  for (const [outletName, groups] of Object.entries(MENU)) {
    const outletId = outletByName.get(outletName).id;
    for (const [categoryName, entries] of Object.entries(groups)) {
      const categoryId = catByKey.get(`${outletId}::${categoryName}`).id;
      for (const [name, price, sku] of entries) {
        const row = {
          property_id: pid, outlet_id: outletId, category_id: categoryId, name, price,
          inventory_item_id: sku ? (itemBySku.get(sku) ?? null) : null, active: true,
        };
        if (!haveItems.has(itemKey(row))) newItems.push(row);
      }
    }
  }
  const menuItems = [...existingItems, ...(newItems.length ? await admin.insert("pos_menu_items", newItems) : [])];
  log(`  · menu items: ${newItems.length} created, ${existingItems.length} already present`);

  return { state: { locations: locations.rows, suppliers: suppliers.rows, outlets: outlets.rows, posTables: tables.rows, menuItems } };
}
