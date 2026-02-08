import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  // ✅ CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  try {
    // 1️⃣ auth header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const jwt = authHeader.replace("Bearer ", "").trim();

    // client con JWT utente
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: `Bearer ${jwt}` },
        },
      }
    );

    const { data: userData, error: userErr } =
      await userClient.auth.getUser();

    if (userErr || !userData?.user) {
      return new Response(
        JSON.stringify({ error: "Invalid user session" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const userId = userData.user.id;

    // 2️⃣ body confirm
    let body: any = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    if (body?.confirm !== true) {
      return new Response(
        JSON.stringify({ error: "Missing confirm=true" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 3️⃣ admin client
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 4️⃣ delete public data (ignora tabelle non ancora esistenti)
    await Promise.allSettled([
      admin.from("withdrawals").delete().eq("profile_id", userId),
      admin.from("wallets").delete().eq("profile_id", userId),
      admin.from("entitlements").delete().eq("user_id", userId),
      admin.from("pets").delete().eq("owner_id", userId),
      admin.from("posts").delete().eq("creator_id", userId),
    ]);

    // delete profile
    await admin.from("profiles").delete().eq("user_id", userId);

    // 5️⃣ delete auth user
    const { error: delAuthErr } =
      await admin.auth.admin.deleteUser(userId);

    if (delAuthErr) {
      return new Response(
        JSON.stringify({ error: delAuthErr.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({ ok: true }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message || String(e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
