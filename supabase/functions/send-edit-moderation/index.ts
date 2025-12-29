import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ADMIN_BOT_TOKEN = Deno.env.get('ADMIN_BOT_TOKEN')!;
const TELEGRAM_ADMIN_CHAT_ID = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function sendAdminMessage(chatId: string | number, text: string, options: any = {}) {
  const url = `https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...options,
    }),
  });

  return response.json();
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function parseDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array; filename: string } | null {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) return null;

  const mime = matches[1];
  const base64Data = matches[2];
  const bytes = decodeBase64ToBytes(base64Data);

  const ext = mime.split('/')[1] || 'jpg';
  const filename = `media.${ext}`;

  return { mime, bytes, filename };
}

async function sendAdminPhoto(chatId: string | number, photoDataUrl: string, caption: string) {
  const url = `https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendPhoto`;

  const parsed = parseDataUrl(photoDataUrl);
  if (!parsed) {
    console.error('Invalid base64 format (data url expected)');
    return { ok: false, error: 'Invalid base64 format' };
  }

  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  // Deno/TS typing quirk: cast to satisfy BlobPart
  formData.append('photo', new Blob([parsed.bytes as unknown as Uint8Array], { type: parsed.mime }), parsed.filename);
  formData.append('caption', caption.slice(0, 900));
  formData.append('parse_mode', 'HTML');

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  return response.json();
}

async function getOrCreateShortId(articleId: string): Promise<string> {
  const { data, error } = await supabase.rpc('get_or_create_short_id', { p_article_id: articleId });
  if (error) throw error;
  return data;
}

function splitForTelegram(text: string, maxLen = 3800): string[] {
  if (text.length <= maxLen) return [text];

  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < 0 || cut < maxLen * 0.5) cut = maxLen;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.trim().length) parts.push(remaining);
  return parts;
}

function safe(s: any) {
  return String(s ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { articleId } = await req.json();

    if (!articleId) {
      return new Response(JSON.stringify({ error: 'articleId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: article, error: aErr } = await supabase
      .from('articles')
      .select(`*, author:author_id(id, telegram_id, username, first_name, last_name)`)
      .eq('id', articleId)
      .maybeSingle();

    if (aErr || !article) {
      return new Response(JSON.stringify({ error: 'Article not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!article.pending_edit) {
      return new Response(JSON.stringify({ error: 'No pending edit for this article' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const shortId = await getOrCreateShortId(articleId);
    const pendingEdit = article.pending_edit as any;
    const author = (article.author as any) || {};

    const nextTitle = pendingEdit.title ?? article.title;
    const nextTopic = pendingEdit.topic ?? article.topic;
    const nextBody = pendingEdit.body ?? article.body;
    const nextMediaUrl = pendingEdit.media_url ?? article.media_url;
    const nextIsAnonymous = pendingEdit.is_anonymous ?? article.is_anonymous;

    const isBase64Image = typeof nextMediaUrl === 'string' && nextMediaUrl.startsWith('data:');
    const isYouTube = (pendingEdit.media_type ?? article.media_type) === 'youtube' && !!nextMediaUrl;
    const youtubeUrl = isYouTube ? `https://youtube.com/watch?v=${nextMediaUrl}` : null;

    const authorLine = `👤 <b>Автор (оригинал):</b> ${safe(`${author.first_name || ''} ${author.last_name || ''}`.trim() || 'Не указано')} ${author.username ? `(@${safe(author.username)})` : ''}`;
    const idsLine = `🆔 <b>Telegram ID:</b> ${safe(author.telegram_id || '—')}\n🧾 <b>Profile ID:</b> <code>${safe(author.id || '—')}</code>`;

    let changes = `<b>📝 Изменения:</b>\n`;

    if ((pendingEdit.title ?? article.title) !== article.title) {
      changes += `• <b>Заголовок:</b> <s>${safe(article.title)}</s> ➡️ ${safe(nextTitle)}\n`;
    }
    if ((pendingEdit.topic ?? article.topic) !== article.topic) {
      changes += `• <b>Тема:</b> <s>${safe(article.topic || '—')}</s> ➡️ ${safe(nextTopic || '—')}\n`;
    }
    if ((pendingEdit.is_anonymous ?? article.is_anonymous) !== article.is_anonymous) {
      changes += `• <b>Анонимность:</b> ${article.is_anonymous ? 'Да' : 'Нет'} ➡️ ${nextIsAnonymous ? 'Да' : 'Нет'}\n`;
    }
    if ((pendingEdit.media_url ?? article.media_url) !== article.media_url) {
      changes += `• <b>Медиа:</b> изменено\n`;
    }
    if ((pendingEdit.body ?? article.body) !== article.body) {
      changes += `• <b>Текст:</b> изменён\n`;
    }

    const header = `✏️ <b>Редактирование статьи</b>\n🆔 Код: <code>${safe(shortId)}</code>\n`;

    const meta =
      `\n🗂 <b>Категория:</b> ${safe(article.category_id || '—')}` +
      `\n🧩 <b>Тема (новая):</b> ${safe(nextTopic || '—')}` +
      `\n📝 <b>Заголовок (новый):</b> ${safe(nextTitle)}` +
      `\n🙈 <b>Анонимная публикация (новая):</b> ${nextIsAnonymous ? 'Да' : 'Нет'}`;

    const mediaLine =
      nextMediaUrl
        ? isBase64Image
          ? `\n\n🖼 <b>Медиа:</b> фото (см. выше)`
          : isYouTube
            ? `\n\n🎬 <b>Медиа:</b> <a href="${youtubeUrl}">YouTube ссылка</a>`
            : `\n\n🔗 <b>Медиа:</b> <a href="${safe(nextMediaUrl)}">ссылка</a>`
        : '';

    const fullText = `${header}${authorLine}\n${idsLine}\n\n${changes}${meta}\n\n📄 <b>Новая версия текста:</b>\n${safe(nextBody || '')}${mediaLine}`;

    const keyboard = {
      inline_keyboard: [[{ text: '✅ Одобрить', callback_data: `edit_approve:${shortId}` }, { text: '❌ Отклонить', callback_data: `edit_reject:${shortId}` }]],
    };

    // 1) If base64 image: send photo first
    if (isBase64Image) {
      const photoCaption = `🖼 <b>Медиа (после редактирования)</b>\n📝 ${safe(nextTitle)}`;
      const photoRes = await sendAdminPhoto(TELEGRAM_ADMIN_CHAT_ID, nextMediaUrl, photoCaption);
      console.log('[send-edit-moderation] sendPhoto response:', photoRes);
    }

    // 2) Send message split; keyboard on last
    const parts = splitForTelegram(fullText);
    let lastResult: any = null;

    for (let i = 0; i < parts.length; i++) {
      const opts = i === parts.length - 1 ? { reply_markup: keyboard } : {};
      // eslint-disable-next-line no-await-in-loop
      lastResult = await sendAdminMessage(TELEGRAM_ADMIN_CHAT_ID, parts[i], opts);
    }

    console.log(`[send-edit-moderation] Sent edit moderation request for article ${articleId}`, lastResult);

    return new Response(JSON.stringify({ success: true, message_id: lastResult?.result?.message_id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('send-edit-moderation error:', e);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
