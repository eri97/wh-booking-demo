const express = require("express");
const OpenAI = require("openai");
const { google } = require("googleapis");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const WH_AGENT_ID = "83d02738-3649-4264-a571-0bedbe7d3884";
const WH_SPREADSHEET_ID = "1AKsfGTvTvVW2XvsPPtUnHVOgJhXuNFjjGlz-r9gCMpw";
const USE_TEST_TABS = process.env.WH_USE_TEST_TABS !== "false";

// ── Google Sheets auth via OAuth tokens stored in DB ─────────────────────────
async function getSheets() {
  const res = await pool.query(
    "SELECT google_access_token, google_refresh_token, google_token_expiry FROM google_sheets_connections WHERE agent_id = $1",
    [WH_AGENT_ID]
  );
  const row = res.rows[0];
  if (!row) throw new Error("No Google Sheets connection found for WHB agent");

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_SHEETS_CLIENT_ID,
    process.env.GOOGLE_SHEETS_CLIENT_SECRET
  );
  auth.setCredentials({
    access_token: row.google_access_token,
    refresh_token: row.google_refresh_token,
    expiry_date: row.google_token_expiry ? new Date(row.google_token_expiry).getTime() : undefined,
  });
  return google.sheets({ version: "v4", auth });
}

// ── Read available slots ──────────────────────────────────────────────────────
async function getSlots() {
  const sheets = await getSheets();
  const tabs = USE_TEST_TABS ? ["AI Test May 26", "AI Test Jun 26"] : ["May 26", "Jun 26"];
  const slots = [];
  for (const tab of tabs) {
    try {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: WH_SPREADSHEET_ID,
        range: `'${tab}'!A:N`,
      });
      const rows = resp.data.values || [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const dateRaw    = (row[0] || "").trim();
        const day        = (row[1] || "").trim();
        const status     = (row[2] || "").trim();
        const customerName = (row[5] || "").trim();
        const time       = (row[10] || "").replace(/\n/g, " ").trim();
        const technician = (row[12] || row[11] || "").trim();
        if (!dateRaw || !time) continue;
        if (!/^\d/.test(time)) continue;   // time must start with digit (skip notes)
        if (status !== "") continue;       // already has a status = booked/confirmed
        if (customerName !== "") continue; // already has a customer name = taken
        if (technician.length <= 1) continue; // skip slots with unnamed/single-initial technicians
        // Parse DD/MM/YYYY and skip past dates
        const parts = dateRaw.split("/");
        if (parts.length === 3) {
          const slotDate = new Date(`${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`);
          const todayMYT = new Date(Date.now() + 8 * 3600000);
          todayMYT.setUTCHours(0,0,0,0);
          if (slotDate < todayMYT) continue;
        }
        slots.push({ tab, rowIndex: i + 1, dateRaw, day, time, technician });
      }
    } catch { /* tab may not exist */ }
  }
  return slots;
}

// ── Book a slot — fills in the existing slot row in the AI test tab ──────────
async function bookSlot(writeTab, slot, name, contact, address, callerName, city, notes) {
  const sheets = await getSheets();
  // Update columns C:J of the existing row
  await sheets.spreadsheets.values.update({
    spreadsheetId: WH_SPREADSHEET_ID,
    range: `'${writeTab}'!C${slot.rowIndex}:J${slot.rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        "Pending",             // C: Status
        notes || "-",          // D: System Check / Notes
        "-",                   // E: No
        name,                  // F: Name
        contact,               // G: Contact
        callerName || "-",     // H: Serve By
        address || "-",        // I: Site Address
        city || "-",           // J: City
      ]],
    },
  });
}

// ── Area detection ────────────────────────────────────────────────────────────
function detectArea(msg) {
  const m = msg.toLowerCase();
  if (/johor|jb|johor bahru|skudai/.test(m)) return "Johor team";
  if (/penang|ipoh|perak|kedah/.test(m)) return "Northern team";
  if (/kuantan|pahang/.test(m)) return "Kuantan team";
  if (/sabah|sarawak|kota kinabalu|kuching/.test(m)) return "East Malaysia (no service coverage)";
  return "HQ team (KL / Selangor / Klang Valley)";
}

// ── Serve UI ──────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.sendFile(__dirname + "/index.html"));

// ── Chat endpoint ─────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  try {
    const [slots] = await Promise.all([getSlots()]);
    const area = detectArea(message);
    const today = new Date(Date.now() + 8 * 3600000).toISOString().split("T")[0];

    // Cap each tab at 20 slots so both May and June are visible to the AI
    const maySlots = slots.filter(s => s.tab.includes("May")).slice(0, 20);
    const junSlots = slots.filter(s => s.tab.includes("Jun")).slice(0, 20);
    const displaySlots = [...maySlots, ...junSlots];
    const slotLines = displaySlots.map((s, idx) =>
      `#${idx + 1}. ${s.dateRaw} (${s.day}) ${s.time} — Technician: ${s.technician} [tab:${s.tab} row:${s.rowIndex}]`
    ).join("\n") || "No available slots right now.";

    const system = `You are a scheduling assistant for Wai Hong Brothers (WHB), a waterproofing company in Malaysia.
You help the management team log bookings while they are on the phone with a customer.

Today: ${today}
Area from message: ${area}

LIVE AVAILABLE SLOTS (Google Sheets, real-time):
${slotLines}

RULES:
- Availability queries: list the nearest 5 slots with date, day, time, technician name. Include both May and June options if available.
- Reply in the same language the user writes (Chinese or English).
- Be concise and friendly. No corporate fluff.
- Staff sends info piece-by-piece as they get it from the customer on the phone. That is normal — collect what's missing and ask for the rest.
- If a customer says a slot doesn't work, immediately suggest the NEXT slot from the list that has NOT been offered yet. Never repeat a slot that was already offered or declined.
- To BOOK you need ALL 5 of these. Ask for any that are missing:
  (1) Which slot (date + time)
  (2) Customer name
  (3) Customer contact number
  (4) Customer site address
  (5) Caller name (name of the WHB staff who is handling this call)
  Notes are optional — include them if provided.
- Once you have all 5, confirm details and append this EXACT marker at the end of your reply:
  [BOOK:tabName|rowIndex|customerName|customerContact|customerAddress|callerName|city|customerNotes]
  Extract city from the site address (e.g. Shah Alam, Petaling Jaya, Klang, Puchong, Cheras, Subang Jaya, Ampang, Kuala Lumpur, Setia Alam, Banting, etc). Leave blank if cannot determine.
  Example: [BOOK:AI Test May 26|873|Ahmad Bin Ali|0123456789|No 5 Jalan Bukit, 52000 KL|David|Kuala Lumpur|Leaking roof]
  Leave customerNotes empty if none: [...|city|]
- After booking is confirmed, summarise: slot, technician, name, contact, address, handled by.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 1024,
      messages: [
        { role: "system", content: system },
        ...history,
        { role: "user", content: message },
      ],
    });

    let reply = completion.choices[0].message.content;

    // Map real tabs → AI test tabs so demo bookings never touch real data
    const TEST_TAB_MAP = {
      "May 26": "AI Test May 26",
      "Jun 26": "AI Test Jun 26",
    };

    // [BOOK:tab|row|customerName|customerContact|customerAddress|callerName|city|notes]
    const match = reply.match(/\[BOOK:([^|]+)\|(\d+)\|([^|]+)\|([^|]+)\|([^|]+)\|([^|]*)\|([^||\]]*)\|?([^\]]*)\]/);
    if (match) {
      const [, tab, rowStr, name, contact, address, callerName, city, notes] = match;
      const rowIndex = parseInt(rowStr, 10);
      const slot = slots.find(s => s.tab === tab && s.rowIndex === rowIndex);
      const writeTab = TEST_TAB_MAP[tab] || tab; // always write to AI test tab
      try {
        if (!slot) throw new Error("Slot not found");
        await bookSlot(writeTab, slot, name.trim(), contact.trim(), address.trim(), callerName.trim(), city.trim(), notes.trim());
        reply = reply.replace(/\[BOOK:[^\]]+\]/, "").trim();
        reply += `\n\n✅ Booked!\n📅 ${slot.dateRaw} (${slot.day}) ${slot.time}\n👷 Technician: ${slot.technician}\n👤 ${name.trim()}\n📞 ${contact.trim()}\n📍 ${address.trim()}${city.trim() ? `, ${city.trim()}` : ""}`;
        if (callerName.trim()) reply += `\n🧑‍💼 Handled by: ${callerName.trim()}`;
        if (notes.trim()) reply += `\n📝 ${notes.trim()}`;
      } catch (e) {
        reply = reply.replace(/\[BOOK:[^\]]+\]/, "").trim();
        reply += "\n\n⚠️ Couldn't write to sheet — please check manually.";
      }
    }

    res.json({ reply });
  } catch (err) {
    console.error("[WHB Demo]", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3002;
if (require.main === module) {
  app.listen(PORT, () => console.log(`\n✅ WHB Booking Demo → http://localhost:${PORT}\n`));
}
module.exports = app;
