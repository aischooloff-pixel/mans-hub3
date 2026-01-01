import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, crypto-pay-api-signature',
};

// Verify CryptoBot webhook signature using Web Crypto API
async function verifySignature(body: string, signature: string, token: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    
    // Create secret key: HMAC-SHA256("WebAppData", token)
    const webAppDataKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const secretBytes = await crypto.subtle.sign('HMAC', webAppDataKey, encoder.encode(token));
    
    // Create check hash: HMAC-SHA256(secret, body)
    const secretKey = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const hashBytes = await crypto.subtle.sign('HMAC', secretKey, encoder.encode(body));
    
    // Convert to hex
    const hashArray = Array.from(new Uint8Array(hashBytes));
    const checkHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    return checkHash === signature;
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const cryptobotToken = Deno.env.get('CRYPTOBOT_API_TOKEN');
    if (!cryptobotToken) {
      console.error('CRYPTOBOT_API_TOKEN not configured');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const bodyText = await req.text();
    const signature = req.headers.get('crypto-pay-api-signature') || '';

    // Verify webhook signature
    const isValid = await verifySignature(bodyText, signature, cryptobotToken);
    if (!isValid) {
      console.error('Invalid webhook signature');
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = JSON.parse(bodyText);
    console.log('Received CryptoBot webhook:', JSON.stringify(body, null, 2));

    // CryptoBot sends update_type for webhook events
    if (body.update_type !== 'invoice_paid') {
      console.log('Ignoring non-payment update:', body.update_type);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const invoice = body.payload;
    if (!invoice || !invoice.payload) {
      console.error('No payload in invoice');
      return new Response(JSON.stringify({ error: 'Invalid payload' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse our custom payload
    let payloadData;
    try {
      payloadData = JSON.parse(invoice.payload);
    } catch (e) {
      console.error('Failed to parse invoice payload:', e);
      return new Response(JSON.stringify({ error: 'Invalid invoice payload' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { telegram_id, plan, period } = payloadData;
    console.log(`Processing payment for user ${telegram_id}, plan: ${plan}, period: ${period}`);

    // Connect to Supabase
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Calculate premium expiration
    const now = new Date();
    const expiresAt = period === 'yearly' 
      ? new Date(now.setFullYear(now.getFullYear() + 1))
      : new Date(now.setMonth(now.getMonth() + 1));

    // Find user profile by telegram_id
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, referred_by')
      .eq('telegram_id', telegram_id)
      .single();

    if (profileError || !profile) {
      console.error('User profile not found:', profileError);
      return new Response(JSON.stringify({ error: 'User not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update user subscription
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        subscription_tier: plan,
        is_premium: true,
        premium_expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', profile.id);

    if (updateError) {
      console.error('Failed to update subscription:', updateError);
      return new Response(JSON.stringify({ error: 'Failed to update subscription' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Handle referral earnings if user was referred
    if (profile.referred_by) {
      const amount = parseFloat(invoice.amount);
      const earningAmount = amount * 0.2; // 20% referral bonus

      await supabase.from('referral_earnings').insert({
        referrer_id: profile.referred_by,
        referred_id: profile.id,
        purchase_type: `${plan}_${period}`,
        purchase_amount: amount,
        earning_amount: earningAmount,
      });

      // Update referrer's total earnings
      const { data: referrer } = await supabase
        .from('profiles')
        .select('referral_earnings')
        .eq('id', profile.referred_by)
        .single();

      if (referrer) {
        await supabase
          .from('profiles')
          .update({ referral_earnings: (referrer.referral_earnings || 0) + earningAmount })
          .eq('id', profile.referred_by);
      }
    }

    // Create notification for user
    await supabase.from('notifications').insert({
      user_profile_id: profile.id,
      type: 'subscription',
      message: `🎉 Подписка ${plan === 'plus' ? 'Plus' : 'Premium'} успешно активирована!`,
      is_read: false,
    });

    console.log(`Successfully activated ${plan} subscription for user ${telegram_id}`);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Webhook error:', error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
