import Stripe from "https://esm.sh/stripe@14.21.0";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    if (!STRIPE_SECRET_KEY) return json(500, { error: "Missing STRIPE_SECRET_KEY" });

    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json(401, { error: "Missing Authorization header" });

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // ⚠️ TEMP: stesso hardcode di connect-update (poi per-user)
    const accountId = "acct_1Sxo2dPoN3OYj5iI";

    const acc = await stripe.accounts.retrieve(accountId);

    return json(200, {
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
