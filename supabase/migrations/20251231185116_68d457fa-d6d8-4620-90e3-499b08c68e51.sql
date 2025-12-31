-- Add views_count column to articles
ALTER TABLE public.articles 
ADD COLUMN IF NOT EXISTS views_count integer DEFAULT 0;

-- Create article_views table to track unique views
CREATE TABLE IF NOT EXISTS public.article_views (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  article_id uuid NOT NULL,
  user_profile_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(article_id, user_profile_id)
);

-- Enable RLS
ALTER TABLE public.article_views ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Views are viewable by everyone" 
ON public.article_views 
FOR SELECT 
USING (true);

CREATE POLICY "Service role can manage views" 
ON public.article_views 
FOR ALL 
USING (true)
WITH CHECK (true);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_article_views_article_id ON public.article_views(article_id);
CREATE INDEX IF NOT EXISTS idx_article_views_user_profile ON public.article_views(user_profile_id);