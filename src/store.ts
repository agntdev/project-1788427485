/** Durable catalog and order repository.
 *
 * Cloudflare uses its injected D1 binding. Node deployments use the configured
 * Redis URL. Both keep explicit index records; no keyspace enumeration is used.
 */
export type StockStatus = "in_stock" | "out_of_stock";

export interface Product {
  id: string;
  title: string;
  short_description: string;
  price_shams_cash: string;
  stock_status: StockStatus;
}

export interface Order {
  id: string;
  buyer_id: number;
  buyer_chat_id: number;
  product_id: string;
  amount: string;
  payment_status: "confirmed" | "failed";
  payment_reference: string;
  timestamp: number;
  delivery_status: "awaiting_delivery" | "delivered";
  delivery_note?: string;
}

type D1 = {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }> } };
  exec(sql: string): Promise<unknown>;
};
type RedisClient = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown> };

export const now = (): number => Date.now();

function d1(ctx: unknown): D1 | undefined {
  const value = (ctx as { env?: { DB?: unknown } } | undefined)?.env?.DB;
  return value && typeof (value as D1).prepare === "function" ? value as D1 : undefined;
}

let redisPromise: Promise<RedisClient | undefined> | undefined;
async function redis(): Promise<RedisClient | undefined> {
  if (typeof process === "undefined" || !process.env.REDIS_URL) return undefined;
  redisPromise ??= (async () => {
    // Keep the Node-only Redis client out of the Workers static import graph.
    const moduleName = "ioredis";
    const mod = await import(moduleName);
    const Redis = (mod.default ?? mod) as unknown as new (url: string) => RedisClient;
    return new Redis(process.env.REDIS_URL as string);
  })();
  return redisPromise;
}

async function ensureDb(db: D1): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS shams_products (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, price TEXT NOT NULL, stock TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shams_orders (id TEXT PRIMARY KEY, buyer_id INTEGER NOT NULL, buyer_chat_id INTEGER NOT NULL, product_id TEXT NOT NULL, amount TEXT NOT NULL, payment_status TEXT NOT NULL, payment_reference TEXT NOT NULL, created_at INTEGER NOT NULL, delivery_status TEXT NOT NULL, delivery_note TEXT);
CREATE TABLE IF NOT EXISTS shams_indexes (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}

function productFrom(row: Record<string, unknown>): Product {
  return { id: String(row.id), title: String(row.title), short_description: String(row.description), price_shams_cash: String(row.price), stock_status: row.stock === "out_of_stock" ? "out_of_stock" : "in_stock" };
}
function orderFrom(row: Record<string, unknown>): Order {
  return { id: String(row.id), buyer_id: Number(row.buyer_id), buyer_chat_id: Number(row.buyer_chat_id), product_id: String(row.product_id), amount: String(row.amount), payment_status: row.payment_status === "failed" ? "failed" : "confirmed", payment_reference: String(row.payment_reference), timestamp: Number(row.created_at), delivery_status: row.delivery_status === "delivered" ? "delivered" : "awaiting_delivery", delivery_note: row.delivery_note == null ? undefined : String(row.delivery_note) };
}

async function readIndex(db: D1, key: string): Promise<string[]> {
  const row = await db.prepare("SELECT value FROM shams_indexes WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return [];
  try { const value = JSON.parse(row.value); return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; } catch { return []; }
}
async function writeIndex(db: D1, key: string, ids: string[]): Promise<void> {
  await db.prepare("INSERT INTO shams_indexes (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(ids)).run();
}

export class Store {
  constructor(private readonly ctx: unknown) {}
  async available(): Promise<boolean> { return Boolean(d1(this.ctx) ?? await redis()); }

  async products(): Promise<Product[]> {
    const db = d1(this.ctx);
    if (db) { await ensureDb(db); const ids = await readIndex(db, "products"); const out: Product[] = []; for (const id of ids) { const row = await db.prepare("SELECT * FROM shams_products WHERE id = ?").bind(id).first<Record<string, unknown>>(); if (row) out.push(productFrom(row)); } return out; }
    const client = await redis(); if (!client) return [];
    const ids = JSON.parse((await client.get("shams:index:products")) ?? "[]") as string[];
    const out: Product[] = []; for (const id of ids) { const raw = await client.get(`shams:product:${id}`); if (raw) out.push(JSON.parse(raw) as Product); } return out;
  }
  async product(id: string): Promise<Product | undefined> { return (await this.products()).find((p) => p.id === id); }
  async saveProduct(product: Product): Promise<void> {
    const db = d1(this.ctx);
    if (db) { await ensureDb(db); await db.prepare("INSERT INTO shams_products (id,title,description,price,stock) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,price=excluded.price,stock=excluded.stock").bind(product.id, product.title, product.short_description, product.price_shams_cash, product.stock_status).run(); const ids = await readIndex(db, "products"); if (!ids.includes(product.id)) await writeIndex(db, "products", [...ids, product.id]); return; }
    const client = await redis(); if (!client) throw new Error("storage unavailable"); await client.set(`shams:product:${product.id}`, JSON.stringify(product)); const ids = JSON.parse((await client.get("shams:index:products")) ?? "[]") as string[]; if (!ids.includes(product.id)) await client.set("shams:index:products", JSON.stringify([...ids, product.id]));
  }
  async deleteProduct(id: string): Promise<void> {
    const db = d1(this.ctx); if (db) { await ensureDb(db); await db.prepare("DELETE FROM shams_products WHERE id = ?").bind(id).run(); await writeIndex(db, "products", (await readIndex(db, "products")).filter((x) => x !== id)); return; }
    const client = await redis(); if (!client) throw new Error("storage unavailable"); const ids = JSON.parse((await client.get("shams:index:products")) ?? "[]") as string[]; await client.set("shams:index:products", JSON.stringify(ids.filter((x) => x !== id)));
  }
  async saveOrder(order: Order): Promise<void> {
    const db = d1(this.ctx); const buyerKey = `buyer:${order.buyer_id}:orders`;
    if (db) { await ensureDb(db); await db.prepare("INSERT INTO shams_orders (id,buyer_id,buyer_chat_id,product_id,amount,payment_status,payment_reference,created_at,delivery_status,delivery_note) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(order.id,order.buyer_id,order.buyer_chat_id,order.product_id,order.amount,order.payment_status,order.payment_reference,order.timestamp,order.delivery_status,order.delivery_note ?? null).run(); await writeIndex(db, "orders", [...await readIndex(db,"orders"), order.id]); await writeIndex(db,buyerKey,[...await readIndex(db,buyerKey),order.id]); return; }
    const client = await redis(); if (!client) throw new Error("storage unavailable"); await client.set(`shams:order:${order.id}`, JSON.stringify(order)); for (const key of ["orders", buyerKey]) { const index = JSON.parse((await client.get(`shams:index:${key}`)) ?? "[]") as string[]; await client.set(`shams:index:${key}`, JSON.stringify([...index, order.id])); }
  }
  async order(id: string): Promise<Order | undefined> { const db=d1(this.ctx); if(db){ await ensureDb(db); const row=await db.prepare("SELECT * FROM shams_orders WHERE id=?").bind(id).first<Record<string,unknown>>(); return row ? orderFrom(row):undefined; } const client=await redis(); const raw=client && await client.get(`shams:order:${id}`); return raw ? JSON.parse(raw) as Order:undefined; }
  async orders(): Promise<Order[]> { const db=d1(this.ctx); if(db){await ensureDb(db);const ids=await readIndex(db,"orders");const out:Order[]=[];for(const id of ids){const order=await this.order(id);if(order)out.push(order);}return out;}const client=await redis();if(!client)return[];const ids=JSON.parse((await client.get("shams:index:orders"))??"[]") as string[];const out:Order[]=[];for(const id of ids){const order=await this.order(id);if(order)out.push(order);}return out; }
  async buyerOrders(buyerId: number): Promise<Order[]> { const db=d1(this.ctx); const key=`buyer:${buyerId}:orders`; if(db){ await ensureDb(db); const ids=await readIndex(db,key); const out:Order[]=[]; for(const id of ids){const order=await this.order(id); if(order)out.push(order);} return out; } const client=await redis(); if(!client)return[]; const ids=JSON.parse((await client.get(`shams:index:${key}`))??"[]") as string[]; const out:Order[]=[]; for(const id of ids){const order=await this.order(id);if(order)out.push(order);}return out; }
  async deliver(id: string, note?: string): Promise<Order | undefined> { const order=await this.order(id); if(!order)return undefined; order.delivery_status="delivered"; order.delivery_note=note; const db=d1(this.ctx); if(db){await ensureDb(db);await db.prepare("UPDATE shams_orders SET delivery_status=?, delivery_note=? WHERE id=?").bind(order.delivery_status,note??null,id).run();}else {const client=await redis();if(!client)throw new Error("storage unavailable");await client.set(`shams:order:${id}`,JSON.stringify(order));}return order; }
}

export function newId(prefix: string): string { return `${prefix}_${now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`; }
