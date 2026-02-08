// supabase/functions/create-checkout-session/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type Body = {
  creator_id: string;
  plan_id: string;
  success_path?: string;
  cancel_path?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function toForm(params: Record<string, string>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  return body;
}

async function stripeCreateCheckoutSession(
  stripeSecret: string,
  params: Record<string, string>
) {
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: toForm(params),
  });

  const j = await res.json();
  if (!res.ok) throw new Error((j?.error?.message ?? JSON.stringify(j)));
  return j;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY =
      Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("OP_STRIPE_SECRET_KEY");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

    if (!STRIPE_SECRET_KEY) return json(500, { error: "Missing STRIPE secret key" });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing Supabase env vars" });
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // --- auth utente (fan) ---
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });
    const fanId = userData.user.id;

    const body = (await req.json()) as Body;
    const creator_id = body?.creator_id;
    const plan_id = body?.plan_id;

    if (!creator_id || !plan_id) return json(400, { error: "Missing creator_id or plan_id" });
    if (creator_id === fanId) return json(400, { error: "fan_id cannot equal creator_id" });

    const origin = req.headers.get("Origin") ?? "http://localhost:3000";
    const successUrl = origin + (body.success_path ?? `/creator-profile.html?u=${creator_id}`);
    const cancelUrl = origin + (body.cancel_path ?? `/subscribers.html?creator=${creator_id}`);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // 1) plan
    const planRes = await admin
      .from("creator_plans")
      .select("id, creator_id, is_active, billing_period, stripe_price_id")
      .eq("id", plan_id)
      .eq("creator_id", creator_id)
      .eq("is_active", true)
      .eq("billing_period", "monthly")
      .single();

    if (planRes.error || !planRes.data) {
      return json(400, { error: "Plan not found / inactive / not monthly" });
    }

    let stripe_price_id: string | null = planRes.data.stripe_price_id ?? null;

    // 2) ensure price id
    if (!stripe_price_id) {
      const ensureRes = await fetch(`${SUPABASE_URL}/functions/v1/ensure-creator-prices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ creator_id }),
      });

      const ensureJson = await ensureRes.json().catch(() => ({}));
      if (!ensureRes.ok) {
        return json(400, { error: "Failed to auto-create Stripe prices", details: ensureJson });
      }

      const reload = await admin
        .from("creator_plans")
        .select("stripe_price_id")
        .eq("id", plan_id)
        .single();

      if (reload.error || !reload.data?.stripe_price_id) {
        return json(400, { error: "Stripe price still missing after auto-setup" });
      }

      stripe_price_id = reload.data.stripe_price_id;
    }

    // 3) creator connect account id (DB)
    const creatorRes = await admin
      .from("profiles")
      .select("user_id, stripe_connect_account_id")
      .eq("user_id", creator_id)
      .single();

    if (creatorRes.error || !creatorRes.data) {
      return json(400, { error: "Creator profile not found" });
    }

    const connectId = (creatorRes.data as any).stripe_connect_account_id as string | null;
    if (!connectId) {
      return json(400, { error: "Creator missing stripe_connect_account_id" });
    }

    // 4) ✅ verifica stato reale su Stripe (robusto, niente colonne fantasma)
    const acc = await stripe.accounts.retrieve(connectId);

    const ready =
      Boolean(acc.details_submitted) &&
      Boolean(acc.charges_enabled) &&
      Boolean(acc.payouts_enabled);

    if (!ready) {
      return json(400, {
        error: "Creator not ready for charges",
        connect: {
          id: acc.id,
          details_submitted: acc.details_submitted,
          charges_enabled: acc.charges_enabled,
          payouts_enabled: acc.payouts_enabled,
          disabled_reason: acc.requirements?.disabled_reason ?? null,
          currently_due: acc.requirements?.currently_due ?? [],
          past_due: acc.requirements?.past_due ?? [],
          eventually_due: acc.requirements?.eventually_due ?? [],
        },
      });
    }

    // (opzionale) se vuoi tenere sync nel DB:
    // await admin.from("profiles").update({
    //   charges_enabled: acc.charges_enabled,
    //   payouts_enabled: acc.payouts_enabled,
    //   stripe_onboarding_status: acc.details_submitted ? "completed" : "incomplete",
    // }).eq("user_id", creator_id);

    // 5) fees
    const feePercent = Number(Deno.env.get("PLATFORM_FEE_PERCENT") ?? "0");
    const amountPercentToCreator = Math.max(0, Math.min(100, 100 - feePercent));

    // 6) checkout session subscription
    const params: Record<string, string> = {
      mode: "subscription",
      success_url: successUrl,
      cancel_url: cancelUrl,

      "line_items[0][price]": stripe_price_id!,
      "line_items[0][quantity]": "1",

      client_reference_id: fanId,
      "metadata[fan_id]": fanId,
      "metadata[creator_id]": creator_id,
      "metadata[plan_id]": plan_id,

      "subscription_data[transfer_data][destination]": connectId,

      "subscription_data[metadata][fan_id]": fanId,
      "subscription_data[metadata][creator_id]": creator_id,
      "subscription_data[metadata][plan_id]": plan_id,
    };

    if (feePercent > 0) {
      params["subscription_data[transfer_data][amount_percent]"] = String(amountPercentToCreator);
    }

    const session = await stripeCreateCheckoutSession(STRIPE_SECRET_KEY, params);
    return json(200, { url: session.url, id: session.id });
  } catch (e) {
    console.error(e);
    return json(500, { error: "Server error", details: String((e as any)?.message ?? e) });
  }
});
