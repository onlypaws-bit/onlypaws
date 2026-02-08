// supabase/functions/connect-status/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!STRIPE_SECRET_KEY) return json(500, { error: "Missing STRIPE_SECRET_KEY" });
    if (!SUPABASE_URL) return json(500, { error: "Missing SUPABASE_URL" });
    if (!SUPABASE_SERVICE_ROLE_KEY)
      return json(500, { error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const token = getBearerToken(req);
    if (!token) return json(401, { error: "Missing Authorization header" });

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // ✅ valida token e ottieni user
    const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userRes?.user) return json(401, { error: "Invalid session" });

    const userId = userRes.user.id;

    // ✅ prendi connect account id dal profilo
    const { data: profile, error: pErr } = await supabaseAdmin
      .from("profiles")
      .select("stripe_connect_account_id")
      .eq("user_id", userId)
      .single();

    if (pErr || !profile) return json(400, { error: "Profile not found" });

    const accountId = profile.stripe_connect_account_id ?? null;

    // se non c’è ancora, rispondi “not_ready” senza chiamare Stripe
    if (!accountId) {
      return json(200, {
        ready: false,
        reason: "missing_stripe_connect_account_id",
        accountId: null,
      });
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
    const acc = await stripe.accounts.retrieve(accountId);

    // “ready” = interpretazione utile per UI
    const ready =
      Boolean(acc.details_submitted) &&
      Boolean(acc.charges_enabled) &&
      Boolean(acc.payouts_enabled);

    return json(200, {
      ready,
      accountId: acc.id,
      livemode: acc.livemode,
      type: acc.type,
      details_submitted: acc.details_submitted,
      charges_enabled: acc.charges_enabled,
      payouts_enabled: acc.payouts_enabled,
      requirements: {
        disabled_reason: acc.requirements?.disabled_reason ?? null,
        currently_due: acc.requirements?.currently_due ?? [],
        past_due: acc.requirements?.past_due ?? [],
        eventually_due: acc.requirements?.eventually_due ?? [],
        pending_verification: acc.requirements?.pending_verification ?? [],
      },
    });
  } catch (e) {
    const msg = (e as any)?.raw?.message || (e as any)?.message || String(e);
    return json(400, { error: msg });
  }
});
