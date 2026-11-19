import { chromium } from 'playwright';
import fs from 'fs';

// ==========================================
// 1. CONFIGURATION (Add your layoutIds here)
// ==========================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const STORE_ID = "1402609"; // Sector 57, Gurugram Dark Store
const SECONDARY_STORE_ID = "1398454";
const MIN_DISCOUNT = 60; // Minimum discount % to alert

const CATEGORIES = [
  { name: "Protein & Sports", layoutId: "31731" },
  { name: "Electronics & Cables", layoutId: "32826" },
  { name: "Skincare & Grooming", layoutId: "38952" },
  { name: "Home & Kitchen", layoutId: "38444" }
  // Uncomment and paste your actual 5-digit layoutIds below:
  // { name: "Electronics & Cables", layoutId: "PASTE_ELECTRONICS_ID" },
  // { name: "Skincare & Grooming", layoutId: "PASTE_SKINCARE_ID" },
  // { name: "Home & Kitchen", layoutId: "PASTE_HOME_ID" },
];

const SEEN_FILE = 'seen_deals.json';
const DEALS_FILE = 'deals.json';

async function sendTelegramAlert(deal) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("⚠️ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in GitHub Secrets.");
    return;
  }

  const text =
    `🚨 *${deal.disc}% PRICE DROP — GURUGRAM (Instamart)*\n` +
    `🏷️ *Aisle:* ${deal.aisle}\n\n` +
    `📦 *Product:* ${deal.name}\n` +
    `❌ *MRP:* ~₹${deal.mrp}~  👉  ✅ *NOW: ₹${deal.sell}*\n` +
    `💰 *You Save:* ₹${deal.saved}\n` +
    `⚡ *Stock Left:* ${deal.stock}\n\n` +
    `🛒 [Open Swiggy Instamart](https://www.swiggy.com/instamart)`;

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    console.log(`⚠️ Telegram error (${res.status}):`, await res.text());
  }
}

async function run() {
  console.log("🚀 Launching headless Chromium...");
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    geolocation: { latitude: 28.4221038, longitude: 77.0718319 },
    permissions: ['geolocation'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  console.log("🌐 Opening Instamart to initialize session...");
  await page.goto('https://www.swiggy.com/instamart', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForTimeout(4000);

  const allLiveDeals = [];

  for (const cat of CATEGORIES) {
    console.log(`🔎 Scanning aisle: ${cat.name} (layoutId: ${cat.layoutId})...`);

    const aisleDeals = await page.evaluate(
      async ({ cat, STORE_ID, SECONDARY_STORE_ID, MIN_DISCOUNT }) => {
        const extractNum = (val) => {
          if (typeof val === 'number') return val;
          if (typeof val === 'string') return parseFloat(val.replace(/[^0-9.]/g, '')) || 0;
          if (val && typeof val === 'object') {
            for (const k of ['units', 'value', 'amount', 'mrp', 'offerPrice', 'offer_price', 'storePrice', 'store_price']) {
              if (val[k] !== undefined) return extractNum(val[k]);
            }
          }
          return 0;
        };

        const found = [];
        const logs = [];

        for (const offset of [0, 1]) {
          const url = `${window.location.origin}/api/instamart/campaign/mxn/v2?layoutId=${cat.layoutId}&offset=${offset}&customerPage=STORES_MxN_46&metaInfo=&storeId=${STORE_ID}&primaryStoreId=${STORE_ID}&secondaryStoreId=${SECONDARY_STORE_ID}`;
          try {
            const res = await fetch(url, {
              method: 'GET',
              cache: 'no-store',
              headers: {
                accept: '*/*',
                'content-type': 'application/json',
                'x-build-version': '2.393.0',
              },
            });
            logs.push(`offset=${offset} -> HTTP ${res.status}`);
            if (res.status !== 200) continue;

            const raw = await res.json();

            const hunt = (node) => {
              if (!node || typeof node !== 'object') return;
              if (Array.isArray(node.variations)) {
                const baseName = node.displayName || node.display_name || node.name || 'Unknown';
                for (const v of node.variations) {
                  if (!v || typeof v !== 'object') continue;
                  const p = v.price || v;
                  const mrp = extractNum(p.mrp);
                  const sell = extractNum(p.offerPrice ?? p.offer_price ?? p.storePrice ?? p.store_price ?? p.price);
                  const qty = v.skuQuantityWithCombo || v.sku_quantity_with_combo || v.quantityDescription || v.quantity || '';
                  const name = `${v.displayName || v.display_name || baseName} (${qty})`.replace(/\(\s*\)/g, '').trim();
                  const inStock = v.inventory ? (v.inventory.inStock ?? v.inventory.in_stock ?? true) : true;
                  const stockQty = v.inventory?.total ?? 'Available';
                  const imgId = Array.isArray(v.images) && v.images[0] ? v.images[0] : '';

                  if (mrp > 0 && sell > 0 && sell < mrp && inStock) {
                    const disc = Math.round(((mrp - sell) / mrp) * 1000) / 10;
                    if (disc >= MIN_DISCOUNT) {
                      found.push({
                        name,
                        aisle: cat.name,
                        city: 'Gurugram',
                        platform: 'Swiggy Instamart',
                        mrp,
                        sell,
                        disc,
                        saved: mrp - sell,
                        stock: stockQty,
                        image: imgId ? `https://instamart-media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,h_400/${imgId}` : '',
                        updatedAt: new Date().toISOString(),
                      });
                    }
                  }
                }
                return;
              }
              for (const key of Object.keys(node)) hunt(node[key]);
            };

            hunt(raw);
          } catch (err) {
            logs.push(`offset=${offset} -> ERR: ${err.message}`);
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        return { found, logs };
      },
      { cat, STORE_ID, SECONDARY_STORE_ID, MIN_DISCOUNT }
    );

    console.log(`   ↳ Status: ${aisleDeals.logs.join(' | ')} | Deals found: ${aisleDeals.found.length}`);
    allLiveDeals.push(...aisleDeals.found);
  }

  await browser.close();

  // Deduplicate and sort highest discount first
  const uniqueMap = new Map();
  for (const d of allLiveDeals) {
    if (!uniqueMap.has(d.name) || d.sell < uniqueMap.get(d.name).sell) {
      uniqueMap.set(d.name, d);
    }
  }
  const finalDeals = Array.from(uniqueMap.values()).sort((a, b) => b.disc - a.disc);

  // Load anti-spam memory
  let seenMemory = {};
  if (fs.existsSync(SEEN_FILE)) {
    try {
      seenMemory = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    } catch {
      seenMemory = {};
    }
  }

  let alertsSent = 0;
  for (const deal of finalDeals) {
    if (!seenMemory[deal.name] || deal.sell < seenMemory[deal.name]) {
      await sendTelegramAlert(deal);
      seenMemory[deal.name] = deal.sell;
      alertsSent++;
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  // Save memory + live database for our upcoming website
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seenMemory, null, 2));
  fs.writeFileSync(
    DEALS_FILE,
    JSON.stringify({ lastUpdated: new Date().toISOString(), count: finalDeals.length, deals: finalDeals }, null, 2)
  );

  console.log(`✅ Done! Total live 60%+ deals: ${finalDeals.length} | New Telegram alerts fired: ${alertsSent}`);
}

run().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
