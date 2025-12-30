import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function parseInitData(initData: string) {
  return new URLSearchParams(initData);
}

function enc(text: string) {
  return new TextEncoder().encode(text);
}

async function hmacSha256Raw(key: string, data: string) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, enc(data));
}

async function hmacSha256Hex(key: ArrayBuffer, data: string) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyTelegramInitData(initData: string): Promise<{ user: any | null }> {
  const params = parseInitData(initData);

  const hash = params.get('hash');
  if (!hash) {
    return { user: null };
  }

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key === 'hash') return;
    pairs.push(`${key}=${value}`);
  });
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = await hmacSha256Raw('WebAppData', TELEGRAM_BOT_TOKEN);
  const checkHash = await hmacSha256Hex(secretKey, dataCheckString);

  if (checkHash !== hash) {
    return { user: null };
  }

  const userJson = params.get('user');
  if (!userJson) {
    return { user: null };
  }

  try {
    const user = JSON.parse(userJson);
    return { user };
  } catch {
    return { user: null };
  }
}

interface ActivityItem {
  id: string;
  type: 'like' | 'comment' | 'article_created' | 'article_updated' | 'article_deleted';
  article_id: string;
  article_title: string;
  article_topic?: string;
  created_at: string;
  details?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { initData, limit = 50 } = await req.json();
    if (!initData) {
      return new Response(JSON.stringify({ error: 'initData is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { user: tgUser } = await verifyTelegramInitData(initData);

    if (!tgUser?.id) {
      return new Response(
        JSON.stringify({ error: 'Invalid Telegram initData' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get profile
    const { data: profile, error: pErr } = await supabase
      .from('profiles')
      .select('*')
      .eq('telegram_id', tgUser.id)
      .maybeSingle();

    if (pErr || !profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const activities: ActivityItem[] = [];

    // Get likes by user
    const { data: likes } = await supabase
      .from('article_likes')
      .select(`
        id,
        created_at,
        article_id,
        articles:article_id(title, topic)
      `)
      .eq('user_profile_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (likes) {
      for (const like of likes) {
        const article = like.articles as any;
        if (article) {
          activities.push({
            id: like.id,
            type: 'like',
            article_id: like.article_id,
            article_title: article.title,
            article_topic: article.topic,
            created_at: like.created_at,
          });
        }
      }
    }

    // Get comments by user
    const { data: comments } = await supabase
      .from('article_comments')
      .select(`
        id,
        created_at,
        body,
        article_id,
        articles:article_id(title, topic)
      `)
      .eq('author_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (comments) {
      for (const comment of comments) {
        const article = comment.articles as any;
        if (article) {
          activities.push({
            id: comment.id,
            type: 'comment',
            article_id: comment.article_id,
            article_title: article.title,
            article_topic: article.topic,
            created_at: comment.created_at,
            details: comment.body.substring(0, 100),
          });
        }
      }
    }

    // Get user's articles (created/updated)
    const { data: articles } = await supabase
      .from('articles')
      .select('id, title, topic, created_at, updated_at, edited_at, status')
      .eq('author_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (articles) {
      for (const article of articles) {
        // Article created
        activities.push({
          id: `created_${article.id}`,
          type: 'article_created',
          article_id: article.id,
          article_title: article.title,
          article_topic: article.topic,
          created_at: article.created_at,
          details: article.status === 'approved' ? 'Опубликовано' : article.status === 'pending' ? 'На модерации' : 'Отклонено',
        });

        // If article was edited
        if (article.edited_at && article.edited_at !== article.created_at) {
          activities.push({
            id: `edited_${article.id}`,
            type: 'article_updated',
            article_id: article.id,
            article_title: article.title,
            article_topic: article.topic,
            created_at: article.edited_at,
          });
        }
      }
    }

    // Sort all activities by date descending
    activities.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return new Response(JSON.stringify({ activities: activities.slice(0, limit) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('tg-my-activity error:', e);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
