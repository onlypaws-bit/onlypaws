import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const endpointSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function sbAdmin(path: string, init: RequestInit) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SB ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export default async (req: Request) => {
  const sig = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig!, endpointSecret);
  } catch (err) {
    return new Response(`Webhook Error: ${(err as Error).message}`, { status: 400 });
  }

  try {
    if (event.type === "account.updated") {
      const acct = event.data.object as Stripe.Account;

      const acctId = acct.id;
      const chargesEnabled = !!acct.charges_enabled;
      const payoutsEnabled = !!acct.payouts_enabled;
      const onboardingDone = chargesEnabled && payoutsEnabled;

      // Find profile by stripe_account_id
      const profArr = await sbAdmin(`profiles?select=user_id&stripe_account_id=eq.${acctId}`, { method: "GET" });
      const prof = Array.isArray(profArr) ? profArr[0] : null;
      if (prof?.user_id) {
        const userId = prof.user_id;

        await sbAdmin(`profiles?user_id=eq.${userId}`, {
          method: "PATCH",
          body: JSON.stringify({
            charges_enabled: chargesEnabled,
            payouts_enabled: payoutsEnabled,
            stripe_onboarding_status: onboardingDone ? "completed" : "started",
          }),
        });

        if (onboardingDone) {
          // Upsert entitlement payouts_enabled=active
          // If you already have a unique constraint on (user_id,key) this is perfect.
          await sbAdmin(`entitlements`, {
            method: "POST",
            body: JSON.stringify([{
              user_id: userId,
              key: "payouts_enabled",
              status: "active",
              updated_at: new Date().toISOString(),
            }]),
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          });
        }
      }
    }

    return new Response("ok", { status: 200 });
  } catch (e) {
    return new Response(`Server Error: ${(e as Error).message}`, { status: 500 });
  }
};
