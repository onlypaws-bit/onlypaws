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
    if (!SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const token = getBearerToken(req);
    if (!token) return json(401, { error: "Missing Authorization header" });

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // ✅ validate session
    const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userRes?.user) return json(401, { error: "Invalid session" });
    const userId = userRes.user.id;

    // ✅ load profile
    const { data: profile, error: pErr } = await supabaseAdmin
      .from("profiles")
      .select("user_id, role, stripe_connect_account_id, stripe_onboarding_status, payouts_enabled, charges_enabled, stripe_onboarded")
      .eq("user_id", userId)
      .maybeSingle();

    if (pErr) return json(500, { error: pErr.message });
    if (!profile) return json(404, { error: "Profile not found" });

    const accountId: string | null = profile.stripe_connect_account_id ?? null;

    // ✅ no account => not ready, persist baseline
    if (!accountId) {
      await supabaseAdmin
        .from("profiles")
        .update({
          stripe_onboarding_status: "not_started",
          payouts_enabled: false,
          charges_enabled: false,
          stripe_onboarded: false,
        })
        .eq("user_id", userId);

      return json(200, {
        ready: false,
        reason: "missing_stripe_connect_account_id",
        accountId: null,
      });
    }

    if (!accountId.startsWith("acct_")) {
      return json(400, { error: "Invalid stripe_connect_account_id format" });
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
    const acc = await stripe.accounts.retrieve(accountId);

    const details_submitted = Boolean(acc.details_submitted);
    const charges_enabled = Boolean(acc.charges_enabled);
    const payouts_enabled = Boolean(acc.payouts_enabled);

    const ready = details_submitted && charges_enabled && payouts_enabled;

    const disabled_reason = acc.requirements?.disabled_reason ?? null;
    const currently_due = acc.requirements?.currently_due ?? [];
    const past_due = acc.requirements?.past_due ?? [];
    const eventually_due = acc.requirements?.eventually_due ?? [];
    const pending_verification = acc.requirements?.pending_verification ?? [];

    const onboarding_status = ready ? "complete" : "pending";

    // ✅ persist into YOUR columns
    const { error: uErr } = await supabaseAdmin
      .from("profiles")
      .update({
        stripe_onboarding_status: onboarding_status,
        payouts_enabled,
        charges_enabled,
        stripe_onboarded: ready,
      })
      .eq("user_id", userId);

    if (uErr) {
      // still return status even if DB update fails
      return json(200, {
        ready,
        accountId: acc.id,
        details_submitted,
        charges_enabled,
        payouts_enabled,
        requirements: {
          disabled_reason,
          currently_due,
          past_due,
          eventually_due,
          pending_verification,
        },
        warning: "DB update failed: " + uErr.message,
      });
    }

    return json(200, {
      ready,
      accountId: acc.id,
      livemode: acc.livemode,
      type: acc.type,
      details_submitted,
      charges_enabled,
      payouts_enabled,
      requirements: {
        disabled_reason,
        currently_due,
        past_due,
        eventually_due,
        pending_verification,
      },
      onboarding_status,
    });
  } catch (e) {
    const msg = (e as any)?.raw?.message || (e as any)?.message || String(e);
    return json(500, { error: msg });
  }
});
