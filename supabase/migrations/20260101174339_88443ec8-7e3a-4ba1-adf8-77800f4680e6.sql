-- Create trigger function to send notification when a new badge is granted
CREATE OR REPLACE FUNCTION public.notify_badge_granted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_badge_name text;
  v_badge_emoji text;
BEGIN
  -- Map badge type to human-readable name and emoji
  SELECT 
    CASE NEW.badge
      WHEN 'author' THEN 'Автор'
      WHEN 'experienced_author' THEN 'Опытный автор'
      WHEN 'legend' THEN 'Легенда'
      WHEN 'man' THEN 'Мужчина'
      WHEN 'expert' THEN 'Эксперт'
      WHEN 'sage' THEN 'Мудрец'
      WHEN 'partner' THEN 'Партнёр'
      WHEN 'founder' THEN 'Основатель'
      WHEN 'moderator_badge' THEN 'Модератор'
      WHEN 'referrer' THEN 'Рефер'
      WHEN 'hustler' THEN 'Хастлер'
      WHEN 'ambassador' THEN 'Амбассадор'
      ELSE NEW.badge::text
    END,
    CASE NEW.badge
      WHEN 'author' THEN '📝'
      WHEN 'experienced_author' THEN '✍️'
      WHEN 'legend' THEN '🏆'
      WHEN 'man' THEN '💪'
      WHEN 'expert' THEN '🎓'
      WHEN 'sage' THEN '🧙'
      WHEN 'partner' THEN '🤝'
      WHEN 'founder' THEN '👑'
      WHEN 'moderator_badge' THEN '🛡️'
      WHEN 'referrer' THEN '👥'
      WHEN 'hustler' THEN '🔥'
      WHEN 'ambassador' THEN '🌟'
      ELSE '🏅'
    END
  INTO v_badge_name, v_badge_emoji;

  -- Insert notification
  INSERT INTO notifications (user_profile_id, type, message)
  VALUES (
    NEW.user_profile_id,
    'badge',
    v_badge_emoji || ' Вам присвоен значок «' || v_badge_name || '»!'
  );

  RETURN NEW;
END;
$$;

-- Create trigger on user_badges table
DROP TRIGGER IF EXISTS on_badge_granted ON user_badges;
CREATE TRIGGER on_badge_granted
  AFTER INSERT ON user_badges
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_badge_granted();