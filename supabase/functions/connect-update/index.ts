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

    // ✅ validate token + user
    const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userRes?.user) return json(401, { error: "Invalid session" });

    const user = userRes.user;
    const userId = user.id;
    const userEmail = user.email ?? null;

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    const body = await req.json().catch(() => ({}));
    const return_url =
      (typeof body?.return_url === "string" && body.return_url) ||
      "https://onlypaws-psi.vercel.app/payouts-setup.html?done=1";
    const refresh_url =
      (typeof body?.refresh_url === "string" && body.refresh_url) ||
      "https://onlypaws-psi.vercel.app/payouts-setup.html?retry=1";

    // 1) read profile
    const { data: profile, error: pErr } = await supabaseAdmin
      .from("profiles")
      .select("user_id, role, username, stripe_connect_account_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (pErr) return json(500, { error: pErr.message });
    if (!profile) return json(404, { error: "Profile not found for user" });

    // opzionale: blocca chi non è creator
    // if (profile.role !== "creator") return json(403, { error: "Not a creator" });

    let accountId: string | null = profile.stripe_connect_account_id ?? null;

    async function saveConnectAccount(newId: string) {
      const { error: upErr } = await supabaseAdmin
        .from("profiles")
        .update({
          stripe_connect_account_id: newId,
          stripe_onboarding_status: "pending",
          charges_enabled: false,
          payouts_enabled: false,
          stripe_onboarded: false,
        })
        .eq("user_id", userId);

      if (upErr) throw new Error("Failed to update profile: " + upErr.message);
    }

    // 2) create account if missing
    if (!accountId) {
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
      await saveConnectAccount(accountId);
    } else {
      // sanity check: if saved id doesn't exist on Stripe, recreate it
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
        await saveConnectAccount(accountId);
      }

      // se accountId esiste ed è valido, mettiamo comunque pending (così UI coerente)
      await supabaseAdmin
        .from("profiles")
        .update({ stripe_onboarding_status: "pending" })
        .eq("user_id", userId);
    }

    // 3) create onboarding link
    const link = await stripe.accountLinks.create({
      account: accountId!,
      type: "account_onboarding",
      return_url,
      refresh_url,
    });

    return json(200, {
      url: link.url,
      type: "account_onboarding",
      stripe_connect_account_id: accountId,
      return_url,
      refresh_url,
    });
  } catch (e) {
    console.error("CONNECT UPDATE ERROR:", e);
    const msg = (e as any)?.raw?.message || (e as any)?.message || String(e);
    return json(500, { error: msg });
  }
});
