import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function verifyTelegramWebAppData(initData: string, botToken: string) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { valid: false, reason: 'no hash' };

    params.delete('hash');
    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map((k) => `${k}=${params.get(k)}`).join('\n');

    const encoder = new TextEncoder();
    const keyData = encoder.encode('WebAppData');
    const tokenData = encoder.encode(botToken);
    
    const key1 = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secretKey = await crypto.subtle.sign('HMAC', key1, tokenData);
    
    const key2 = await crypto.subtle.importKey('raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key2, encoder.encode(dataCheckString));
    
    const calculatedHash = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (calculatedHash !== hash) return { valid: false, reason: 'hash mismatch' };

    const userRaw = params.get('user');
    if (!userRaw) return { valid: false, reason: 'no user' };
    const user = JSON.parse(userRaw);

    return { valid: true, user };
  } catch (e) {
    return { valid: false, reason: String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { initData, action, filter, limit = 50 } = await req.json();
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
    const result = await verifyTelegramWebAppData(initData, botToken);

    if (!result.valid || !result.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const telegramId = result.user.id;

    // Get user profile
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

    // Mark all as read
    if (action === 'mark_all_read') {
      await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_profile_id', profile.id)
        .eq('is_read', false);

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get notifications with optional filter
    let query = supabase
      .from('notifications')
      .select(`
        *,
        article:article_id(id, title, topic),
        from_user:from_user_id(id, first_name, last_name, username, avatar_url)
      `)
      .eq('user_profile_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (filter && filter !== 'all') {
      if (filter === 'likes') {
        query = query.eq('type', 'like');
      } else if (filter === 'comments') {
        query = query.in('type', ['comment', 'reply', 'mention']);
      } else if (filter === 'rep') {
        query = query.eq('type', 'rep');
      } else if (filter === 'articles') {
        query = query.in('type', ['article_approved', 'article_rejected']);
      } else if (filter === 'favorites') {
        query = query.eq('type', 'favorite');
      } else if (filter === 'badges') {
        query = query.eq('type', 'badge');
      }
    }

    const { data: notifications, error: notifError } = await query;

    if (notifError) {
      console.error('Error fetching notifications:', notifError);
      return new Response(JSON.stringify({ error: 'Failed to fetch notifications' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get unread count
    const { count: unreadCount } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_profile_id', profile.id)
      .eq('is_read', false);

    return new Response(JSON.stringify({ 
      notifications: notifications || [],
      unreadCount: unreadCount || 0
    }), {
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
