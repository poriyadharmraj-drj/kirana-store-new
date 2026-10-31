const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");
types.setTypeParser(20, v => parseInt(v, 10)); // bigint -> number

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // CHANGE on hosting!
const SHOP = {
  name: process.env.SHOP_NAME || "Kirana Store",
  phone: (process.env.SHOP_PHONE || "").replace(/\D/g, "").slice(-10),
  address: process.env.SHOP_ADDRESS || "",
  timings: process.env.SHOP_TIMINGS || "9:00 AM - 9:00 PM"
};
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Add your Neon connection string in Environment Variables.");
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, max: 5,
  ssl: /sslmode=/.test(process.env.DATABASE_URL) ? undefined : { rejectUnauthorized: false }
});
pool.on("error", e => console.error("DB pool error:", e.message));
const q = (sql, params) => pool.query(sql, params);
const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e); res.status(500).json({ error: "Server error. Please try again." });
});

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS orders(
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, items TEXT NOT NULL,
    total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at BIGINT NOT NULL, token TEXT)`);
  await q(`CREATE TABLE IF NOT EXISTS products(
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, brand TEXT DEFAULT '', category TEXT DEFAULT 'General',
    unit TEXT DEFAULT '', price INTEGER NOT NULL, mrp INTEGER DEFAULT 0, emoji TEXT DEFAULT '',
    in_stock INTEGER DEFAULT 1, image BYTEA, image_type TEXT, updated_at BIGINT DEFAULT 0)`);
  const c = (await q("SELECT COUNT(*) c FROM products")).rows[0].c;
  if (c === 0) {
    try {
      const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "products.json"), "utf8"));
      for (const p of seed)
        await q("INSERT INTO products(name,category,price,emoji,updated_at) VALUES($1,$2,$3,$4,$5)",
          [p.n, p.c || "General", p.p, p.e || "", Date.now()]);
    } catch (e) { console.log("No seed data"); }
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const manifest = (name, start, id) => ({ name, short_name: name.slice(0, 14), id, start_url: start, scope: "/", display: "standalone",
  background_color: "#f1f5fb", theme_color: "#1565c0",
  icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }] });
app.get("/manifest.json", (req, res) => res.type("application/manifest+json").send(JSON.stringify(manifest(SHOP.name, "/", "/"))));
app.get("/manifest-owner.json", (req, res) => res.type("application/manifest+json").send(JSON.stringify(manifest(SHOP.name + " Admin", "/owner.html", "/owner.html"))));

const COLS = "id,name,brand,category,unit,price,mrp,emoji,in_stock,(image IS NOT NULL) AS has_img,updated_at";
const shape = r => ({ id: r.id, name: r.name, brand: r.brand, category: r.category, unit: r.unit, price: r.price,
  mrp: r.mrp, emoji: r.emoji, in_stock: !!r.in_stock, img: r.has_img ? "/img/" + r.id + "?v=" + r.updated_at : null });
const pid = v => parseInt(v, 10) || 0;

app.set("trust proxy", 1);
const fails = {};
function admin(req, res, next) {
  const f = fails[req.ip] || { n: 0, t: 0 };
  if (Date.now() - f.t > 900000) f.n = 0; // forget after 15 minutes
  if (f.n >= 10) return res.status(429).json({ error: "Too many wrong attempts. Try again after 15 minutes." });
  if (req.get("x-admin-password") !== ADMIN_PASSWORD) {
    f.n++; f.t = Date.now(); fails[req.ip] = f;
    return res.status(401).json({ error: "Wrong password" });
  }
  fails[req.ip] = { n: 0, t: 0 };
  next();
}

// ---------- Public ----------
app.get("/api/shop", (req, res) => res.json(SHOP));
app.get("/api/products", wrap(async (req, res) =>
  res.json((await q("SELECT " + COLS + " FROM products ORDER BY category, name")).rows.map(shape))));
app.get("/img/:id", wrap(async (req, res) => {
  const r = (await q("SELECT image,image_type FROM products WHERE id=$1", [pid(req.params.id)])).rows[0];
  if (!r || !r.image) return res.sendStatus(404);
  res.set("Content-Type", r.image_type).set("Cache-Control", "public, max-age=604800").send(r.image);
}));

const lastByPhone = {};
app.post("/api/orders", wrap(async (req, res) => {
  const { name, phone, items } = req.body || {};
  if (!name || typeof name !== "string" || name.trim().length < 2 || name.length > 60)
    return res.status(400).json({ error: "Please enter a valid name." });
  if (!/^[6-9]\d{9}$/.test(String(phone || ""))) return res.status(400).json({ error: "Please enter a valid 10-digit mobile number." });
  if (!Array.isArray(items) || !items.length || items.length > 60) return res.status(400).json({ error: "Your order is empty." });
  if (Date.now() - (lastByPhone[phone] || 0) < 10000) return res.status(429).json({ error: "Please wait a few seconds before ordering again." });
  let total = 0; const clean = [];
  for (const it of items) {
    const p = (await q("SELECT id,name,brand,unit,price,in_stock FROM products WHERE id=$1", [pid(it && it.id)])).rows[0];
    const qty = parseInt(it && it.qty, 10);
    if (!p || !(qty >= 1 && qty <= 50)) return res.status(400).json({ error: "Invalid item in order." });
    if (!p.in_stock) return res.status(400).json({ error: p.name + " is out of stock." });
    clean.push({ id: p.id, name: p.name, brand: p.brand, unit: p.unit, qty, price: p.price });
    total += qty * p.price;
  }
  lastByPhone[phone] = Date.now();
  const token = crypto.randomBytes(12).toString("hex");
  const r = await q("INSERT INTO orders(name,phone,items,total,status,created_at,token) VALUES($1,$2,$3,$4,'new',$5,$6) RETURNING id",
    [name.trim(), phone, JSON.stringify(clean), total, Date.now(), token]);
  res.json({ ok: true, id: r.rows[0].id, token });
}));

// Customers see only orders placed from their own device (secret token), never by phone number
app.post("/api/track", wrap(async (req, res) => {
  const list = Array.isArray(req.body && req.body.orders) ? req.body.orders.slice(0, 20) : [];
  const out = [];
  for (const o of list) {
    const r = (await q("SELECT id,items,total,status,created_at FROM orders WHERE id=$1 AND token=$2",
      [pid(o && o.id), String((o && o.token) || "")])).rows[0];
    if (r) out.push({ ...r, items: JSON.parse(r.items) });
  }
  res.json(out);
}));

// ---------- Admin ----------
app.get("/api/admin/orders", admin, wrap(async (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  const rows = (await q("SELECT * FROM orders WHERE created_at>=$1 ORDER BY id DESC LIMIT 2000", [Date.now() - days * 86400000])).rows;
  res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items) })));
}));
app.post("/api/admin/orders/:id/status", admin, wrap(async (req, res) => {
  const s = req.body && req.body.status;
  if (!["new", "ready", "done", "cancelled"].includes(s)) return res.status(400).json({ error: "Bad status" });
  await q("UPDATE orders SET status=$1 WHERE id=$2", [s, pid(req.params.id)]);
  res.json({ ok: true });
}));
app.delete("/api/admin/orders/:id", admin, wrap(async (req, res) => {
  await q("DELETE FROM orders WHERE id=$1", [pid(req.params.id)]); res.json({ ok: true });
}));

app.get("/api/admin/stats", admin, wrap(async (req, res) => {
  const off = 19800000; // India time (UTC+5:30)
  const start = Math.floor((Date.now() + off) / 86400000) * 86400000 - off;
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const [a, b, c, d, e, f] = await Promise.all([
    one("SELECT COUNT(*) c FROM orders WHERE created_at>=$1", [start]),
    one("SELECT COALESCE(SUM(total),0) c FROM orders WHERE created_at>=$1 AND status!='cancelled'", [start]),
    one("SELECT COUNT(*) c FROM orders WHERE status='new'"),
    one("SELECT COUNT(*) c FROM orders WHERE status='ready'"),
    one("SELECT COUNT(*) c FROM products"),
    one("SELECT COUNT(*) c FROM products WHERE in_stock=0")]);
  res.json({ today_orders: a.c, today_sales: b.c, new_orders: c.c, ready_orders: d.c, products: e.c, out_of_stock: f.c });
}));

app.get("/api/admin/products", admin, wrap(async (req, res) =>
  res.json((await q("SELECT " + COLS + " FROM products ORDER BY id DESC")).rows.map(shape))));

function readProduct(b) {
  const name = String(b.name || "").trim(), price = parseInt(b.price, 10), mrp = parseInt(b.mrp, 10) || 0;
  if (name.length < 2 || name.length > 80) return { error: "Enter product name." };
  if (!(price > 0 && price < 1000000)) return { error: "Enter a valid price." };
  const o = { name, price, mrp: mrp > price ? mrp : 0, brand: String(b.brand || "").trim().slice(0, 40),
    category: String(b.category || "General").trim().slice(0, 40) || "General", unit: String(b.unit || "").trim().slice(0, 20),
    emoji: String(b.emoji || "").trim().slice(0, 4), in_stock: b.in_stock === false ? 0 : 1 };
  if (b.image) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.image);
    if (!m) return { error: "Invalid image." };
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 400000) return { error: "Image too big." };
    o.image = buf; o.image_type = m[1];
  }
  return { o };
}
app.post("/api/admin/products", admin, wrap(async (req, res) => {
  const { o, error } = readProduct(req.body || {}); if (error) return res.status(400).json({ error });
  const r = await q("INSERT INTO products(name,brand,category,unit,price,mrp,emoji,in_stock,image,image_type,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
    [o.name, o.brand, o.category, o.unit, o.price, o.mrp, o.emoji, o.in_stock, o.image || null, o.image_type || null, Date.now()]);
  res.json({ ok: true, id: r.rows[0].id });
}));
app.put("/api/admin/products/:id", admin, wrap(async (req, res) => {
  const b = req.body || {}, id = pid(req.params.id);
  if (Object.keys(b).length === 1 && "in_stock" in b) { // quick stock toggle
    await q("UPDATE products SET in_stock=$1,updated_at=$2 WHERE id=$3", [b.in_stock ? 1 : 0, Date.now(), id]);
    return res.json({ ok: true });
  }
  const { o, error } = readProduct(b); if (error) return res.status(400).json({ error });
  await q("UPDATE products SET name=$1,brand=$2,category=$3,unit=$4,price=$5,mrp=$6,emoji=$7,in_stock=$8,updated_at=$9 WHERE id=$10",
    [o.name, o.brand, o.category, o.unit, o.price, o.mrp, o.emoji, o.in_stock, Date.now(), id]);
  if (o.image) await q("UPDATE products SET image=$1,image_type=$2 WHERE id=$3", [o.image, o.image_type, id]);
  else if (b.removeImage) await q("UPDATE products SET image=NULL,image_type=NULL WHERE id=$1", [id]);
  res.json({ ok: true });
}));
app.delete("/api/admin/products/:id", admin, wrap(async (req, res) => {
  await q("DELETE FROM products WHERE id=$1", [pid(req.params.id)]); res.json({ ok: true });
}));

init().then(() => app.listen(PORT, () => console.log("Shop running on port " + PORT)))
  .catch(e => { console.error("Startup failed:", e.message); process.exit(1); });
