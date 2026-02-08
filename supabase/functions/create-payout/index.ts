import Stripe from "npm:stripe";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ENV
const stripeSecretKey = Deno.env.get("OP_STRIPE_SECRET_KEY");
if (!stripeSecretKey) throw new Error("OP_STRIPE_SECRET_KEY is not set");

const stripe = new Stripe(stripeSecretKey, { apiVersion: "2023-10-16" });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  // ✅ CORS preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    // 1) auth (JWT from client)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { ok: false, error: "Missing Authorization header" });

    const jwt = authHeader.replace("Bearer ", "").trim();

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } }
    );

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json(401, { ok: false, error: "Invalid user session" });

    const userId = userData.user.id;

    // 2) body
    let body: any = null;
    try { body = await req.json(); } catch { body = null; }

    const withdrawalId = body?.withdrawalId ? String(body.withdrawalId) : null;

    // Back-compat (if you still want to call with these — but we now prefer withdrawalId)
    const fallbackStripeId = String(body?.creatorStripeAccountId || "").trim();
    const fallbackAmountCents = Number(body?.amountCents);

    // 3) admin client
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 4) Load withdrawal (preferred)
    let amountCents: number | null = null;

    if (withdrawalId) {
      const { data: wd, error: wErr } = await admin
        .from("withdrawals")
        .select("id, profile_id, amount_cents, status")
        .eq("id", withdrawalId)
        .maybeSingle();

      if (wErr) return json(500, { ok: false, error: wErr.message });
      if (!wd) return json(404, { ok: false, error: "Withdrawal not found" });
      if (wd.profile_id !== userId) return json(403, { ok: false, error: "Not allowed" });

      // allow only requested/pending (be tolerant on your wording)
      const st = String(wd.status || "").toLowerCase();
      if (!["requested", "pending", "approved"].includes(st)) {
        return json(400, { ok: false, error: `Withdrawal status not payable: ${wd.status}` });
      }

      amountCents = Number(wd.amount_cents || 0);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return json(400, { ok: false, error: "Invalid withdrawal amount" });
      }
    } else {
      // Fallback: accept amountCents from body
      if (!Number.isFinite(fallbackAmountCents) || fallbackAmountCents <= 0) {
        return json(400, { ok: false, error: "Missing withdrawalId (preferred) or invalid amountCents" });
      }
      amountCents = Math.round(fallbackAmountCents);
    }

    // 5) Determine Stripe connected account id
    // We read full profile so we don't hardcode column names (your schema may vary).
    const { data: profile, error: pErr } = await admin
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (pErr) return json(500, { ok: false, error: pErr.message });

    const stripeAccountId =
      (profile?.stripe_connect_id ||
        profile?.stripe_connect_account_id ||
        profile?.stripe_connect ||
        profile?.stripe_connec || // your column looks like this in UI (truncated)
        profile?.stripe_account_id ||
        fallbackStripeId ||
        "").toString().trim();

    if (!stripeAccountId) {
      return json(400, { ok: false, error: "Missing Stripe connected account id on profile" });
    }

    // 6) Stripe Transfer (platform -> connected account)
    const transfer = await stripe.transfers.create({
      amount: Math.round(amountCents),
      currency: "eur",
      destination: stripeAccountId,
      metadata: {
        ...(withdrawalId ? { withdrawal_id: withdrawalId } : {}),
        profile_id: userId,
      },
    });

    // 7) Mark withdrawal as paid (best-effort)
    if (withdrawalId) {
      const now = new Date().toISOString();
      const { error: uErr } = await admin
        .from("withdrawals")
        .update({
          status: "paid",
          processed_at: now,
          paid_at: now,
        })
        .eq("id", withdrawalId)
        .eq("profile_id", userId);

      // don't fail transfer if db update fails — just return warning
      if (uErr) {
        return json(200, { ok: true, transfer, warning: `Transfer ok but DB update failed: ${uErr.message}` });
      }
    }

    return json(200, { ok: true, transfer });
  } catch (err: any) {
    console.error("CREATE PAYOUT ERROR:", err);
    return json(500, {
      ok: false,
      message: err?.message ?? String(err),
      type: err?.type,
      code: err?.code,
      statusCode: err?.statusCode,
    });
  }
});
