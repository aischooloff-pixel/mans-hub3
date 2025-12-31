import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TELEGRAM_ADMIN_CHAT_ID = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID')!;
const ADMIN_BOT_TOKEN = Deno.env.get('ADMIN_BOT_TOKEN')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Send moderation notification to admin
async function sendProductModerationNotification(product: any, profile: any) {
  const message = `📦 <b>Новый продукт на модерации</b>

🏷 <b>Код:</b> <code>${product.short_code || 'N/A'}</code>
📛 <b>Название:</b> ${product.title}
💰 <b>Цена:</b> ${product.price} ${product.currency || 'RUB'}

📝 <b>Описание:</b>
${product.description?.substring(0, 300) || 'Нет описания'}${product.description?.length > 300 ? '...' : ''}

${product.media_url ? `🎬 <b>Медиа:</b> ${product.media_url}` : ''}
${product.link ? `🔗 <b>Ссылка:</b> ${product.link}` : ''}

👤 <b>Автор:</b> ${profile.username ? '@' + profile.username : profile.first_name || 'ID:' + profile.telegram_id}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Одобрить', callback_data: `product_approve:${product.id}` },
        { text: '❌ Отклонить', callback_data: `product_reject:${product.id}` },
      ],
    ],
  };

  await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_ADMIN_CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    }),
  });
}

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
  if (!hash) return { user: null };

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key === 'hash') return;
    pairs.push(`${key}=${value}`);
  });
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = await hmacSha256Raw('WebAppData', TELEGRAM_BOT_TOKEN);
  const checkHash = await hmacSha256Hex(secretKey, dataCheckString);

  if (checkHash !== hash) return { user: null };

  const userJson = params.get('user');
  if (!userJson) return { user: null };

  try {
    return { user: JSON.parse(userJson) };
  } catch {
    return { user: null };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { initData, action, productId, product } = await req.json();

    if (!initData) {
      return new Response(JSON.stringify({ error: 'initData required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { user: tgUser } = await verifyTelegramInitData(initData);
    if (!tgUser?.id) {
      return new Response(JSON.stringify({ error: 'Invalid initData' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, subscription_tier')
      .eq('telegram_id', tgUser.id)
      .maybeSingle();

    if (profileError || !profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // List products (no premium check needed for own products)
    if (action === 'list') {
      const { data: products, error } = await supabase
        .from('user_products')
        .select('*')
        .eq('user_profile_id', profile.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      return new Response(JSON.stringify({ products: products || [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check if user has premium subscription for other actions
    if (profile.subscription_tier !== 'premium') {
      return new Response(JSON.stringify({ error: 'Premium subscription required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'create') {
      // Check product limit (1 product for Premium)
      const { count: existingCount } = await supabase
        .from('user_products')
        .select('*', { count: 'exact', head: true })
        .eq('user_profile_id', profile.id);

      if (existingCount && existingCount >= 1) {
        return new Response(JSON.stringify({ error: 'Product limit reached. Maximum 1 product allowed.' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Determine media type
      let mediaType = null;
      if (product.media_url) {
        if (product.media_url.includes('youtube.com') || product.media_url.includes('youtu.be')) {
          mediaType = 'youtube';
        } else {
          mediaType = 'image';
        }
      }

      // Get profile info for notification
      const { data: fullProfile } = await supabase
        .from('profiles')
        .select('telegram_id, username, first_name')
        .eq('id', profile.id)
        .maybeSingle();

      const { data: created, error } = await supabase
        .from('user_products')
        .insert({
          user_profile_id: profile.id,
          title: product.title,
          description: product.description,
          price: product.price,
          currency: product.currency || 'RUB',
          media_url: product.media_url,
          media_type: mediaType,
          link: product.link,
          status: 'pending',
        })
        .select('*')
        .single();

      if (error) throw error;

      // Send moderation notification
      await sendProductModerationNotification(created, fullProfile);

      return new Response(JSON.stringify({ product: created }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'update' && productId) {
      // Verify ownership
      const { data: existing } = await supabase
        .from('user_products')
        .select('user_profile_id')
        .eq('id', productId)
        .maybeSingle();

      if (!existing || existing.user_profile_id !== profile.id) {
        return new Response(JSON.stringify({ error: 'Product not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      let mediaType = null;
      if (product.media_url) {
        if (product.media_url.includes('youtube.com') || product.media_url.includes('youtu.be')) {
          mediaType = 'youtube';
        } else {
          mediaType = 'image';
        }
      }

      // Get profile info for notification
      const { data: fullProfile } = await supabase
        .from('profiles')
        .select('telegram_id, username, first_name')
        .eq('id', profile.id)
        .maybeSingle();

      const { data: updated, error } = await supabase
        .from('user_products')
        .update({
          title: product.title,
          description: product.description,
          price: product.price,
          currency: product.currency || 'RUB',
          media_url: product.media_url,
          media_type: mediaType,
          link: product.link,
          status: 'pending',
          rejection_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', productId)
        .select('*')
        .single();

      if (error) throw error;

      // Send moderation notification
      await sendProductModerationNotification(updated, fullProfile);

      return new Response(JSON.stringify({ product: updated }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'delete' && productId) {
      // Verify ownership
      const { data: existing } = await supabase
        .from('user_products')
        .select('user_profile_id')
        .eq('id', productId)
        .maybeSingle();

      if (!existing || existing.user_profile_id !== profile.id) {
        return new Response(JSON.stringify({ error: 'Product not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { error } = await supabase
        .from('user_products')
        .delete()
        .eq('id', productId);

      if (error) throw error;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('tg-manage-product error:', e);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});