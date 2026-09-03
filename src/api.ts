import { inlineButton, inlineKeyboard } from "./toolkit/index.js";
import { ApiProduct, Store, newId, now, type Order } from "./store.js";

type Env = { DB?: unknown; BOT_TOKEN?: string; ADMIN_CHAT_ID?: string };
type Scope = "read" | "write" | "admin";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const error = (status: number, message: string) => json({ error: message }, status);
const validText = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
const validMetadata = (value: unknown) => value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value));

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function newSecret(): string { const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);return [...bytes].map((x)=>x.toString(16).padStart(2,"0")).join(""); }
function productBody(product: ApiProduct) { return { id: product.id, title: product.title, price: product.price_shams_cash, currency: product.currency, description: product.short_description, delivery_method: product.delivery_method, metadata: product.metadata }; }
function orderBody(order: Order) { return { order_id: order.id, product_id: order.product_id, amount: order.amount, status: order.delivery_status, payment_status: order.payment_status, delivery_text: order.delivery_note, delivery_files: order.delivery_files, buyer_name: order.buyer_name, buyer_contact: order.buyer_contact, metadata: order.metadata }; }
function can(scope: Scope, required: Scope) { return ({ read: 1, write: 2, admin: 3 }[scope] >= { read: 1, write: 2, admin: 3 }[required]); }

async function authenticate(request: Request, store: Store): Promise<{ id: string; scope: Scope } | Response> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.length < 12) return error(401, "A valid bearer token is required.");
  const token = await store.findApiToken(await sha256(header.slice(7)));
  if (!token || !(await store.rateLimit(token.id, Math.max(1, Math.min(token.rate_limit, 1000)), now()))) return token ? error(429, "Rate limit exceeded. Try again in a minute.") : error(401, "A valid bearer token is required.");
  return { id: token.id, scope: token.scope };
}
async function body(request: Request): Promise<Record<string, unknown> | Response> { try { const x: unknown = await request.json(); return x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : error(400, "Request body must be a JSON object."); } catch { return error(400, "Request body must be valid JSON."); } }
async function notifyOwner(env: Env, order: Order, product: ApiProduct): Promise<void> {
  if (!env.ADMIN_CHAT_ID || !env.BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.ADMIN_CHAT_ID,
        text: `طلب جديد عبر API\n${product.title}\nالمبلغ: ${order.amount} ${product.currency}`,
        reply_markup: inlineKeyboard([[inlineButton("تسليم الطلب", `deliver:${order.id}`)]]),
      }),
    });
  } catch { /* owner notification is best effort; order remains actionable in the desk */ }
}

/** Worker HTTP API. Tokens are SHA-256 hashes in durable D1 storage; token values are never stored. */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
  const store = new Store({ env });
  const auth = await authenticate(request, store); if (auth instanceof Response) return auth;
  if (!(await store.available())) return error(503, "The API storage is not configured yet.");
  const requireScope = (scope: Scope) => can(auth.scope, scope) ? undefined : error(403, "This token does not have permission for that action.");
  if(path[0]==="tokens"&&request.method==="POST"&&path.length===1){const denied=requireScope("admin");if(denied)return denied;const b=await body(request);if(b instanceof Response)return b;const scope=(b.scope??"write") as Scope;const limit=Number(b.rate_limit??60);if(!["read","write","admin"].includes(scope)||!Number.isInteger(limit)||limit<1||limit>1000)return error(422,"Provide a valid scope and rate_limit.");const value=newSecret();const id=newId("key");await store.createApiToken(id,await sha256(value),scope,limit);return json({id,token:value,scope,rate_limit:limit},201);}
  if(path[0]==="tokens"&&path[1]&&request.method==="DELETE"){const denied=requireScope("admin");if(denied)return denied;await store.revokeApiToken(path[1]);return new Response(null,{status:204});}
  if (path[0] === "products" && request.method === "GET" && path.length === 1) { const denied=requireScope("read"); return denied ?? json({ products: (await store.apiProducts()).map(productBody) }); }
  if (path[0] === "products" && request.method === "POST" && path.length === 1) { const denied=requireScope("write"); if(denied)return denied; const b=await body(request);if(b instanceof Response)return b; if(!validText(b.title,120)||!validText(b.description,1000)||!validText(b.price,40)||!validText(b.currency,12)||!validText(b.delivery_method,60)||!validMetadata(b.metadata))return error(422,"Provide title, price, currency, description, and delivery_method."); const p:ApiProduct={id:newId("prd"),title:String(b.title).trim(),short_description:String(b.description).trim(),price_shams_cash:String(b.price).trim(),currency:String(b.currency).trim().toUpperCase(),delivery_method:String(b.delivery_method).trim(),metadata:b.metadata as Record<string,unknown>|undefined,stock_status:"in_stock"};await store.saveApiProduct(p);return json({id:p.id},201); }
  if (path[0] === "products" && path[1]) { const existing=await store.apiProduct(path[1]);if(!existing)return error(404,"Product not found."); if(request.method==="GET"){const denied=requireScope("read");return denied??json(productBody(existing));} if(request.method==="PUT"){const denied=requireScope("write");if(denied)return denied;const b=await body(request);if(b instanceof Response)return b; const merged={...existing}; if(b.title!==undefined){if(!validText(b.title,120))return error(422,"Title is invalid.");merged.title=String(b.title).trim();} if(b.description!==undefined){if(!validText(b.description,1000))return error(422,"Description is invalid.");merged.short_description=String(b.description).trim();} for(const [key,max] of [["price",40],["currency",12],["delivery_method",60]] as const)if(b[key]!==undefined){if(!validText(b[key],max))return error(422,`${key} is invalid.`); const value=String(b[key]).trim(); if(key==="price")merged.price_shams_cash=value; else if(key==="currency")merged.currency=value.toUpperCase(); else merged.delivery_method=value;} if(b.metadata!==undefined){if(!validMetadata(b.metadata))return error(422,"Metadata must be an object.");merged.metadata=b.metadata as Record<string,unknown>;}await store.saveApiProduct(merged);return json(productBody(merged));} if(request.method==="DELETE"){const denied=requireScope("admin");if(denied)return denied;await store.deleteProduct(existing.id);return new Response(null,{status:204});} }
  if (path[0] === "orders" && request.method === "POST" && path.length === 1) { const denied=requireScope("write");if(denied)return denied;const b=await body(request);if(b instanceof Response)return b; if(!validText(b.product_id,100)||!Number.isInteger(b.quantity)||Number(b.quantity)<1||Number(b.quantity)>1000||!validMetadata(b.metadata)||(b.buyer_name!==undefined&&!validText(b.buyer_name,120))||(b.buyer_contact!==undefined&&!validText(b.buyer_contact,200)))return error(422,"Provide a product_id and a quantity greater than zero.");const product=await store.apiProduct(String(b.product_id));if(!product)return error(404,"Product not found.");if(product.stock_status!=="in_stock")return error(409,"Product is out of stock.");const amount=`${product.price_shams_cash} × ${b.quantity}`;const order:Order={id:newId("ord"),buyer_id:0,buyer_chat_id:0,product_id:product.id,amount,payment_status:"confirmed",payment_reference:`api:${newId("pay")}`,timestamp:now(),delivery_status:"awaiting_delivery"};await store.saveOrder(order);await store.saveApiOrderDetails(order.id,{buyer_name:b.buyer_name as string|undefined,buyer_contact:b.buyer_contact as string|undefined,metadata:b.metadata as Record<string,unknown>|undefined,delivery_files:undefined});await notifyOwner(env,order,product);return json({order_id:order.id,status:order.delivery_status},201); }
  if(path[0]==="orders"&&path[1]){const order=await store.apiOrder(path[1]);if(!order)return error(404,"Order not found.");if(request.method==="GET"){const denied=requireScope("read");return denied??json(orderBody(order));}if(request.method==="PATCH"|| (request.method==="POST"&&path[2]==="mark_delivered")){const denied=requireScope(request.method==="POST"?"admin":"write");if(denied)return denied;const b=request.method==="POST"?{}:await body(request);if(b instanceof Response)return b;const status=request.method==="POST"?"delivered":b.status;const note=request.method==="POST"?undefined:b.delivery_text;const files=request.method==="POST"?undefined:b.delivery_files;if(status!==undefined&&status!=="delivered")return error(409,"Only an awaiting order can be marked delivered.");if(note!==undefined&&!validText(note,4000))return error(422,"Delivery text is invalid.");if(files!==undefined&&(!Array.isArray(files)||files.length>10||files.some((x)=>!validText(x,500))))return error(422,"Delivery files must be a short list of references.");try{const updated=await store.updateApiOrder(order.id,status as string|undefined,note as string|undefined,files as string[]|undefined);return json(orderBody(updated!));}catch{return error(409,"That status change is not allowed for this order.");}} }
  return error(404,"Endpoint not found.");
}
