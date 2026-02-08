// supabase/functions/connect-update/index.ts
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
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

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
    if (userErr || !userRes?.user) {
      return json(401, { error: "Invalid session" });
    }
    const user = userRes.user;
    const userId = user.id;
    const userEmail = user.email ?? null;

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    const body = await req.json().catch(() => ({}));
    const { return_url, refresh_url } = body ?? {};

    // 1) leggi profilo per capire se abbiamo già un connect account id
    const { data: profile, error: pErr } = await supabaseAdmin
      .from("profiles")
      .select("user_id, username, stripe_connect_account_id")
      .eq("user_id", userId)
      .single();

    if (pErr || !profile) {
      return json(400, { error: "Profile not found for user" });
    }

    let accountId: string | null = profile.stripe_connect_account_id ?? null;

    // 2) se manca, crea account express e salva in DB
    if (!accountId) {
      const acct = await stripe.accounts.create({
        type: "express",
        // opzionali ma utili:
        email: userEmail ?? undefined,
        metadata: { user_id: userId },
        capabilities: {
          transfers: { requested: true },
          // per abbonamenti/charge flow spesso serve anche card_payments
          card_payments: { requested: true },
        },
      });

      accountId = acct.id;

      const { error: upErr } = await supabaseAdmin
        .from("profiles")
        .update({ stripe_connect_account_id: accountId })
        .eq("user_id", userId);

      if (upErr) {
        return json(500, { error: "Failed to save stripe_connect_account_id: " + upErr.message });
      }
    } else {
      // sanity check: se l'id è salvato ma non esiste più su Stripe, ricrealo
      try {
        await stripe.accounts.retrieve(accountId);
      } catch {
        const acct = await stripe.accounts.create({
          type: "express",
          email: userEmail ?? undefined,
          metadata: { user_id: userId },
          capabilities: {
            transfers: { requested: true },
            card_payments: { requested: true },
          },
        });

        accountId = acct.id;

        const { error: upErr } = await supabaseAdmin
          .from("profiles")
          .update({ stripe_connect_account_id: accountId })
          .eq("user_id", userId);

        if (upErr) {
          return json(500, { error: "Failed to save stripe_connect_account_id: " + upErr.message });
        }
      }
    }

    // 3) crea onboarding link (sempre)
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      return_url:
        return_url || "https://onlypaws-psi.vercel.app/payouts-setup.html?done=1",
      refresh_url:
        refresh_url || "https://onlypaws-psi.vercel.app/payouts-setup.html?retry=1",
    });

    return json(200, {
      url: link.url,
      type: "account_onboarding",
      stripe_connect_account_id: accountId,
    });
  } catch (e) {
    console.error("CONNECT UPDATE ERROR:", e);
    const msg = (e as any)?.raw?.message || (e as any)?.message || String(e);
    return json(400, { error: msg });
  }
});
