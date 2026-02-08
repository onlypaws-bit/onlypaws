// feed.js
async function fetchCreatorFeed(creatorId) {
  const supabase = window.onlypawsClient;

  // session + viewer
  const { data: { session } } = await supabase.auth.getSession();
  const viewerId = session?.user?.id || null;
  const isCreatorViewingOwnFeed = !!viewerId && viewerId === creatorId;

  // subscription check (only meaningful if logged and not the creator)
  let isSub = false;
  if (session && !isCreatorViewingOwnFeed) {
    const { data, error } = await supabase.rpc("is_subscribed_to", {
      p_creator_id: creatorId,
    });
    if (error) throw error;
    isSub = !!data;
  }

  const { data: posts, error: postsErr } = await supabase
    .from("posts")
    .select(
      "id, creator_id, pet_id, title, content, preview, slug, media_url, media_type, is_public, is_paid, is_pinned, likes_count, created_at"
    )
    .eq("creator_id", creatorId)
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: false });

  if (postsErr) throw postsErr;

  const enriched = (posts || []).map((p) => {
    const isMine = isCreatorViewingOwnFeed;

    // Rule 1: Private post => only creator
    if (p.is_public === false) {
      const can_view = isMine;
      return { ...p, can_view, is_locked: !can_view };
    }

    // From here: public posts
    // Rule 2: Free public => everyone (viewer in this page can still be null)
    if (p.is_paid !== true) {
      return { ...p, can_view: true, is_locked: false };
    }

    // Rule 3: Premium public => creator OR subscriber
    const can_view = isMine || isSub;
    return { ...p, can_view, is_locked: !can_view };
  });

  return { isSub, posts: enriched };
}

// export globale (se lavori senza bundler)
window.fetchCreatorFeed = fetchCreatorFeed;
