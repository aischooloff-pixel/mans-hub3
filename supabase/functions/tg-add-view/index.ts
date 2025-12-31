import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { initData, articleId } = await req.json();

    if (!initData || !articleId) {
      return new Response(JSON.stringify({ error: 'Missing initData or articleId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse initData to get telegram_id
    const params = new URLSearchParams(initData);
    const userStr = params.get('user');
    if (!userStr) {
      return new Response(JSON.stringify({ error: 'No user in initData' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userData = JSON.parse(userStr);
    const telegramId = userData.id;

    // Get profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('telegram_id', telegramId)
      .single();

    if (profileError || !profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check if user already viewed this article
    const { data: existingView } = await supabase
      .from('article_views')
      .select('id')
      .eq('article_id', articleId)
      .eq('user_profile_id', profile.id)
      .single();

    if (existingView) {
      // Already viewed, just return current count
      const { data: article } = await supabase
        .from('articles')
        .select('views_count')
        .eq('id', articleId)
        .single();

      return new Response(JSON.stringify({ 
        success: true, 
        alreadyViewed: true,
        views_count: article?.views_count || 0 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Add new view
    const { error: viewError } = await supabase
      .from('article_views')
      .insert({ article_id: articleId, user_profile_id: profile.id });

    if (viewError) {
      console.error('Error adding view:', viewError);
      return new Response(JSON.stringify({ error: 'Failed to add view' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get current count and increment
    const { data: currentArticle } = await supabase
      .from('articles')
      .select('views_count')
      .eq('id', articleId)
      .single();

    const newCount = (currentArticle?.views_count || 0) + 1;

    await supabase
      .from('articles')
      .update({ views_count: newCount })
      .eq('id', articleId);

    return new Response(JSON.stringify({ 
      success: true, 
      alreadyViewed: false,
      views_count: newCount
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});