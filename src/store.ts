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

export interface ApiProduct extends Product {
  currency: string;
  delivery_method: string;
  metadata?: Record<string, unknown>;
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
  delivery_files?: string[];
  buyer_name?: string;
  buyer_contact?: string;
  metadata?: Record<string, unknown>;
}

type D1 = {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }> } };
  exec(sql: string): Promise<unknown>;
};
type RedisClient = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<unknown>; del?(key: string): Promise<unknown> };

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
CREATE TABLE IF NOT EXISTS shams_api_products (id TEXT PRIMARY KEY, currency TEXT NOT NULL, delivery_method TEXT NOT NULL, metadata TEXT);
CREATE TABLE IF NOT EXISTS shams_api_orders (id TEXT PRIMARY KEY, buyer_name TEXT, buyer_contact TEXT, metadata TEXT, delivery_files TEXT);
CREATE TABLE IF NOT EXISTS shams_api_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, rate_limit INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS shams_api_rate_limits (token_id TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(token_id, window_start));
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
  async apiProduct(id: string): Promise<ApiProduct | undefined> {
    const base = await this.product(id); if (!base) return undefined;
    const db = d1(this.ctx);
    if (db) { await ensureDb(db); const row = await db.prepare("SELECT * FROM shams_api_products WHERE id=?").bind(id).first<Record<string, unknown>>(); const extra = row ?? {}; return { ...base, currency: String(extra.currency ?? "SHAMS"), delivery_method: String(extra.delivery_method ?? "manual"), metadata: parseObject(extra.metadata) }; }
    const client = await redis(); const raw = client && await client.get(`shams:api:product:${id}`); const extra = raw ? JSON.parse(raw) as Omit<ApiProduct, keyof Product> : { currency: "SHAMS", delivery_method: "manual" }; return { ...base, ...extra };
  }
  async apiProducts(): Promise<ApiProduct[]> { return Promise.all((await this.products()).map((p) => this.apiProduct(p.id))).then((items) => items.filter((p): p is ApiProduct => Boolean(p))); }
  async saveApiProduct(product: ApiProduct): Promise<void> {
    await this.saveProduct(product); const db=d1(this.ctx);
    if(db){await ensureDb(db);await db.prepare("INSERT INTO shams_api_products (id,currency,delivery_method,metadata) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET currency=excluded.currency,delivery_method=excluded.delivery_method,metadata=excluded.metadata").bind(product.id,product.currency,product.delivery_method,JSON.stringify(product.metadata ?? null)).run();return;}
    const client=await redis();if(!client)throw new Error("storage unavailable");await client.set(`shams:api:product:${product.id}`,JSON.stringify({currency:product.currency,delivery_method:product.delivery_method,metadata:product.metadata}));
  }
  async product(id: string): Promise<Product | undefined> { return (await this.products()).find((p) => p.id === id); }
  async saveProduct(product: Product): Promise<void> {
    const db = d1(this.ctx);
    if (db) { await ensureDb(db); await db.prepare("INSERT INTO shams_products (id,title,description,price,stock) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,price=excluded.price,stock=excluded.stock").bind(product.id, product.title, product.short_description, product.price_shams_cash, product.stock_status).run(); const ids = await readIndex(db, "products"); if (!ids.includes(product.id)) await writeIndex(db, "products", [...ids, product.id]); return; }
    const client = await redis(); if (!client) throw new Error("storage unavailable"); await client.set(`shams:product:${product.id}`, JSON.stringify(product)); const ids = JSON.parse((await client.get("shams:index:products")) ?? "[]") as string[]; if (!ids.includes(product.id)) await client.set("shams:index:products", JSON.stringify([...ids, product.id]));
  }
  async deleteProduct(id: string): Promise<void> {
    const db = d1(this.ctx); if (db) { await ensureDb(db); await db.prepare("DELETE FROM shams_products WHERE id = ?").bind(id).run(); await db.prepare("DELETE FROM shams_api_products WHERE id = ?").bind(id).run(); await writeIndex(db, "products", (await readIndex(db, "products")).filter((x) => x !== id)); return; }
    const client = await redis(); if (!client) throw new Error("storage unavailable"); const ids = JSON.parse((await client.get("shams:index:products")) ?? "[]") as string[]; await client.set("shams:index:products", JSON.stringify(ids.filter((x) => x !== id))); await client.del?.(`shams:product:${id}`); await client.del?.(`shams:api:product:${id}`);
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

  async apiOrder(id: string): Promise<Order | undefined> { const order=await this.order(id); if(!order)return undefined; const db=d1(this.ctx); if(db){await ensureDb(db);const x=await db.prepare("SELECT * FROM shams_api_orders WHERE id=?").bind(id).first<Record<string,unknown>>();return {...order,buyer_name:x?.buyer_name?String(x.buyer_name):undefined,buyer_contact:x?.buyer_contact?String(x.buyer_contact):undefined,metadata:parseObject(x?.metadata),delivery_files:parseStrings(x?.delivery_files)};} const client=await redis();const raw=client&&await client.get(`shams:api:order:${id}`);return raw?{...order,...JSON.parse(raw) as Partial<Order>}:order; }
  async saveApiOrderDetails(id:string, details: Pick<Order,"buyer_name"|"buyer_contact"|"metadata"|"delivery_files">):Promise<void>{const db=d1(this.ctx);if(db){await ensureDb(db);await db.prepare("INSERT INTO shams_api_orders (id,buyer_name,buyer_contact,metadata,delivery_files) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET buyer_name=excluded.buyer_name,buyer_contact=excluded.buyer_contact,metadata=excluded.metadata,delivery_files=excluded.delivery_files").bind(id,details.buyer_name??null,details.buyer_contact??null,JSON.stringify(details.metadata??null),JSON.stringify(details.delivery_files??null)).run();return;}const client=await redis();if(!client)throw new Error("storage unavailable");await client.set(`shams:api:order:${id}`,JSON.stringify(details));}
  async updateApiOrder(id:string, status:string|undefined, note:string|undefined, files:string[]|undefined):Promise<Order|undefined>{const order=await this.apiOrder(id);if(!order)return undefined;if(status!==undefined){if(status!=="delivered"||order.delivery_status!=="awaiting_delivery"||order.payment_status!=="confirmed")throw new Error("invalid status transition");await this.deliver(id,note);}else if(note!==undefined){order.delivery_note=note;const db=d1(this.ctx);if(db){await ensureDb(db);await db.prepare("UPDATE shams_orders SET delivery_note=? WHERE id=?").bind(note,id).run();}else {const client=await redis();if(!client)throw new Error("storage unavailable");await client.set(`shams:order:${id}`,JSON.stringify(order));}}if(files!==undefined)await this.saveApiOrderDetails(id,{buyer_name:order.buyer_name,buyer_contact:order.buyer_contact,metadata:order.metadata,delivery_files:files});return this.apiOrder(id);}
  async findApiToken(hash:string):Promise<{id:string;scope:"read"|"write"|"admin";rate_limit:number}|undefined>{const db=d1(this.ctx);if(!db)return undefined;await ensureDb(db);const t=await db.prepare("SELECT * FROM shams_api_tokens WHERE token_hash=? AND revoked=0").bind(hash).first<{id:string;scope:"read"|"write"|"admin";rate_limit:number}>();return t??undefined;}
  async rateLimit(tokenId:string, limit:number, timestamp:number):Promise<boolean>{const db=d1(this.ctx);if(!db)return false;await ensureDb(db);const window=Math.floor(timestamp/60000)*60000;const row=await db.prepare("SELECT count FROM shams_api_rate_limits WHERE token_id=? AND window_start=?").bind(tokenId,window).first<{count:number}>();if((row?.count??0)>=limit)return false;await db.prepare("INSERT INTO shams_api_rate_limits (token_id,window_start,count) VALUES (?,?,1) ON CONFLICT(token_id,window_start) DO UPDATE SET count=count+1").bind(tokenId,window).run();return true;}
  async createApiToken(id:string, hash:string, scope:"read"|"write"|"admin", rateLimit:number):Promise<void>{const db=d1(this.ctx);if(!db)throw new Error("API token storage requires D1");await ensureDb(db);await db.prepare("INSERT INTO shams_api_tokens (id,token_hash,scope,rate_limit,revoked) VALUES (?,?,?,?,0)").bind(id,hash,scope,rateLimit).run();}
  async revokeApiToken(id:string):Promise<boolean>{const db=d1(this.ctx);if(!db)return false;await ensureDb(db);await db.prepare("UPDATE shams_api_tokens SET revoked=1 WHERE id=?").bind(id).run();return true;}
}

function parseObject(value: unknown): Record<string, unknown> | undefined { if(typeof value!=="string") return undefined; try { const x=JSON.parse(value); return x&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:undefined;}catch{return undefined;} }
function parseStrings(value: unknown): string[] | undefined { if(typeof value!=="string")return undefined;try{const x=JSON.parse(value);return Array.isArray(x)&&x.every((v)=>typeof v==="string")?x:undefined;}catch{return undefined;} }

export function newId(prefix: string): string { return `${prefix}_${now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`; }
